import { randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { cp, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createOpenApiAdapter } from '@aiops/adapters';
import {
  ConfigurationHolder,
  loadConfigurationDirectory,
  revisionFilesOf,
  revisionSummary,
  startConfigurationSync,
  type ConfigurationLogger,
  type ConfigurationSync,
  type LoadOptions,
} from '@aiops/config';
import { createDb, DrizzleAuditLog, PostgresConfigRevisionStore, runMigrations, type Database } from '@aiops/db';
import { startTestIssuer, type StartedPostgres, type TestIssuer } from '@aiops/testing';
import { configurationLoadOptions } from '@aiops/upstream';
import { auditRows, connectClient, FIXTURE_CONFIG, rawPost, startApi, startDatabase, tokenFor, type RunningApi } from './helpers.js';

const GRANTED = 'support.lookup_order';

const silent: ConfigurationLogger = { debug: () => undefined, info: () => undefined, warn: () => undefined, error: () => undefined };

let postgres: StartedPostgres;
let databaseUrl: string;
let issuer: TestIssuer;
let configDir: string;
let editedDir: string | undefined;
let configDb: Database;
let store: PostgresConfigRevisionStore;
let holder: ConfigurationHolder;
let sync: ConfigurationSync;
let api: RunningApi;
let load: LoadOptions;
let appliedRevision: { id: string; hash: string } | undefined;

beforeAll(async () => {
  ({ postgres, databaseUrl } = await startDatabase());
  issuer = await startTestIssuer();
  configDir = await mkdtemp(join(tmpdir(), 'aiops-revisions-e2e-'));
  await cp(FIXTURE_CONFIG, configDir, { recursive: true });
  const adapter = createOpenApiAdapter();
  load = configurationLoadOptions(adapter, { presetDirs: [] });
  // As `main.ts` wires it: its own database handle, an audit log without sensitive keys (F5).
  configDb = createDb(databaseUrl, { onError: () => undefined });
  store = new PostgresConfigRevisionStore(configDb.db, { databaseUrl });
  holder = await ConfigurationHolder.fromRevisions({
    store,
    fallbackDir: configDir,
    load,
    audit: new DrizzleAuditLog(configDb.db),
    service: 'api',
    newId: randomUUID,
    logger: silent,
  });
  // A poll every 10 minutes never fires here: only NOTIFY can deliver the applied revision.
  sync = await startConfigurationSync({ holder, store, signals: new EventEmitter(), logger: silent, pollIntervalMs: 600_000 });
  api = await startApi(databaseUrl, { issuer, configDir, adapter, configuration: holder });
});

afterAll(async () => {
  await api.close();
  await sync.close();
  await configDb.close();
  await issuer.close();
  await postgres.stop();
  await rm(configDir, { recursive: true, force: true });
  if (editedDir !== undefined) await rm(editedDir, { recursive: true, force: true });
});

async function toolNames(token: string, url: string): Promise<string[]> {
  const client = await connectClient({ era: 'modern', baseUrls: [url], token });
  try {
    return (await client.listTools()).tools.map((t) => t.name);
  } finally {
    await client.close();
  }
}

/** Waits on observable state: the holder's hash, polled every 100 ms for up to 10 s. */
async function waitForHash(hash: string): Promise<void> {
  const deadline = Date.now() + 10_000;
  for (;;) {
    const state = holder.state();
    if (state.status === 'active' && state.hash === hash) return;
    if (Date.now() > deadline) throw new Error(`holder did not reach hash ${hash}; state ${JSON.stringify(state)}`);
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

describe('CFG-3 CFG-4 the api follows applied revisions', () => {
  it('CFG-3 a revision applied by another connection is served without a restart', async () => {
    const editor = await tokenFor(issuer, api, 'editor-id', ['content']);
    expect(await toolNames(editor, api.url)).not.toContain(GRANTED);

    editedDir = await mkdtemp(join(tmpdir(), 'aiops-revisions-edit-'));
    await cp(configDir, editedDir, { recursive: true });
    const roles = await readFile(join(editedDir, 'roles.yaml'), 'utf8');
    const granted = roles.replace('        deny_fields: [cost]\n', `        deny_fields: [cost]\n      - operation: ${GRANTED}\n`);
    expect(granted).not.toBe(roles);
    await writeFile(join(editedDir, 'roles.yaml'), granted);
    const loaded = await loadConfigurationDirectory(editedDir, load);
    if (!loaded.ok) throw new Error(`edited configuration invalid: ${JSON.stringify(loaded.issues)}`);
    const files = revisionFilesOf(loaded.configuration);
    if (!files.ok) throw new Error('edited configuration cannot be stored');
    const before = holder.state();
    if (before.status !== 'active') throw new Error('no active configuration before the apply');

    // Another connection: the store's own pool on a separate handle, as `aiops config apply` would use.
    const cli = createDb(databaseUrl, { onError: () => undefined });
    try {
      const id = randomUUID();
      const result = await new PostgresConfigRevisionStore(cli.db, { databaseUrl }).apply(
        { id, hash: loaded.configuration.hash, files: files.files, actor: 'cli:e2e', summary: revisionSummary(loaded.configuration) },
        {
          id: randomUUID(),
          actor: 'cli:e2e',
          action: 'config.apply',
          outcome: 'ok',
          correlationId: randomUUID(),
          details: { revision: id, hash: loaded.configuration.hash, previousHash: before.hash, added: 0, removed: 0, changed: 1 },
        },
        before.hash,
      );
      expect(result.ok).toBe(true);
      appliedRevision = { id, hash: loaded.configuration.hash };
    } finally {
      await cli.close();
    }

    await waitForHash(loaded.configuration.hash);
    expect(holder.state()).toEqual({ status: 'active', revision: appliedRevision.id, hash: appliedRevision.hash });
    expect(await toolNames(editor, api.url)).toContain(GRANTED);
  });

  it('AUD-1 the load is audited as config.load by system:api with trigger notify', async () => {
    expect(appliedRevision).toBeDefined();
    const rows = await auditRows(databaseUrl, `action = 'config.load'`);
    expect(rows.map((r) => [r.actor, r.outcome, r.details.trigger])).toEqual([
      ['system:api', 'ok', 'start'],
      ['system:api', 'ok', 'notify'],
    ]);
    const notify = rows[1];
    expect(notify?.details).toEqual({ revision: appliedRevision?.id, hash: appliedRevision?.hash, service: 'api', trigger: 'notify', presets: [] });
    expect(notify?.subject).toBeNull();
  });

  it('CFG-2 an api whose only revision mismatches answers 503 on /mcp and 200 on /healthz', async () => {
    // A fresh database (F15): the shared one already holds valid revisions.
    const freshUrl = await postgres.createDatabase();
    await runMigrations(freshUrl);
    const db = createDb(freshUrl, { onError: () => undefined });
    let second: RunningApi | undefined;
    try {
      const freshStore = new PostgresConfigRevisionStore(db.db, { databaseUrl: freshUrl });
      const loaded = await loadConfigurationDirectory(configDir, load);
      if (!loaded.ok) throw new Error('fixture configuration invalid');
      const files = revisionFilesOf(loaded.configuration);
      if (!files.ok) throw new Error('fixture configuration cannot be stored');
      const wrongHash = loaded.configuration.hash === 'f'.repeat(64) ? 'e'.repeat(64) : 'f'.repeat(64);
      const stored = await freshStore.bootstrap({ id: randomUUID(), hash: wrongHash, files: files.files, summary: revisionSummary(loaded.configuration) });

      const mismatched = await ConfigurationHolder.fromRevisions({
        store: freshStore,
        fallbackDir: configDir,
        load,
        audit: new DrizzleAuditLog(db.db),
        service: 'api',
        newId: randomUUID,
        logger: silent,
      });
      expect(mismatched.state()).toEqual({ status: 'configuration_mismatch', revision: stored.id });

      second = await startApi(freshUrl, { issuer, configDir, configuration: mismatched });
      const token = await tokenFor(issuer, second, 'editor-id', ['content']);
      const mcp = await rawPost(second.url, { jsonrpc: '2.0', id: 1, method: 'tools/list' }, { authorization: `Bearer ${token}` });
      expect(mcp.status).toBe(503);
      expect(mcp.headers.get('cache-control')).toBe('no-store');
      expect(await mcp.json()).toEqual({ error: 'configuration_unavailable' });
      const page = await fetch(`${second.url}/api/v1/changesets/x`);
      expect(page.status).toBe(503);
      const health = await fetch(`${second.url}/healthz`);
      expect(health.status).toBe(200);
      const ready = await fetch(`${second.url}/readyz`);
      expect(ready.status).toBe(503);
      expect(ready.headers.get('cache-control')).toBe('no-store');
      expect(await ready.json()).toMatchObject({ database: 'ok', configuration: 'configuration_mismatch' });

      const rows = await auditRows(freshUrl, `action = 'config.load'`);
      expect(rows.map((r) => [r.outcome, r.details.code, r.details.trigger])).toEqual([['error', 'configuration_mismatch', 'start']]);
    } finally {
      await second?.close();
      await db.close();
    }
  });
});
