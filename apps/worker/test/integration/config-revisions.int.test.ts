import { randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { cp, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createOpenApiAdapter } from '@aiops/adapters';
import { loadConfigurationDirectory, parseWorkerEnv, revisionFilesOf, revisionSummary } from '@aiops/config';
import { createDb, PostgresConfigRevisionStore, runMigrations, type Database } from '@aiops/db';
import { startPostgres, type StartedPostgres } from '@aiops/testing';
import { configurationLoadOptions } from '@aiops/upstream';
import { pino } from 'pino';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startRuntimeConfiguration, startWorkerRuntime } from '../../src/runtime.js';

const CONFIG_DIR = fileURLToPath(new URL('../../../../deploy/config', import.meta.url));
const PRESET_DIRS = fileURLToPath(new URL('../../../../presets', import.meta.url));
/** A read operation of the Magento preset that `support_agent` is not granted in `deploy/config`. */
const GRANTED = 'catalog.get_product';
/** AUD-1 CONN-8: `config.load` names the preset version each load chose. */
const MAGENTO_PRESETS = [{ id: 'magento-catalog', package: '@aiops/magento2-catalog', version: '1.0.0' }];
const MASTER_KEYS = '1:ZGV2LW9ubHktbWFzdGVyLWtleS0wMTIzNDU2Nzg5YWI=';
const TEMPORAL_KEYS = '1:ZGV2LW9ubHktdGVtcG9yYWwta2V5LTAxMjM0NTY3ODk=';

interface LoadRow {
  readonly seq: string;
  readonly actor: string;
  readonly outcome: string;
  readonly details: Record<string, unknown>;
}

let postgres: StartedPostgres;
let editedDir: string | undefined;

beforeAll(async () => {
  postgres = await startPostgres();
});

afterAll(async () => {
  await postgres.stop();
  if (editedDir !== undefined) await rm(editedDir, { recursive: true, force: true });
});

async function loadRows(database: Database): Promise<LoadRow[]> {
  return (await database.pool.query<LoadRow>(`select seq::text, actor, outcome, details from audit_event where action = 'config.load' order by seq`)).rows;
}

describe('CFG-3 CFG-4 AUD-1 the worker follows applied revisions', () => {
  it('CFG-3 AUD-1 a worker picks up an applied revision without a restart, and audits system:worker', async () => {
    const url = await postgres.createDatabase();
    await runMigrations(url);
    const env = parseWorkerEnv({
      DATABASE_URL: url,
      TEMPORAL_ADDRESS: '127.0.0.1:1',
      AIOPS_CONFIG_DIR: CONFIG_DIR,
      AIOPS_PRESET_DIRS: PRESET_DIRS,
      AIOPS_MASTER_KEYS: MASTER_KEYS,
      AIOPS_TEMPORAL_KEYS: TEMPORAL_KEYS,
      // An ephemeral port: integration files run in parallel (ruling F11).
      AIOPS_WORKER_HTTP_PORT: '0',
    });
    const adapter = createOpenApiAdapter();
    const signals = new EventEmitter();
    const database = createDb(url, { onError: () => undefined });
    const cli = createDb(url, { onError: () => undefined });
    try {
      const { holder, sync } = await startRuntimeConfiguration({ env, database, adapter, logger: pino({ level: 'silent' }), signals });
      try {
        const start = holder.state();
        if (start.status !== 'active' || start.revision === null) throw new Error(`no active bootstrap revision: ${JSON.stringify(start)}`);
        expect(holder.current.policy.roles.find((r) => r.id === 'support_agent')?.grants.map((g) => g.operation)).not.toContain(GRANTED);
        const started = await loadRows(database);
        expect(started.map((r) => [r.actor, r.outcome, r.details])).toEqual([
          ['system:worker', 'ok', { revision: start.revision, hash: start.hash, service: 'worker', trigger: 'start', presets: MAGENTO_PRESETS }],
        ]);

        // A temp copy of deploy/config whose support_agent is granted one more read operation.
        editedDir = await mkdtemp(join(tmpdir(), 'aiops-worker-revision-'));
        await cp(CONFIG_DIR, editedDir, { recursive: true });
        const roles = await readFile(join(editedDir, 'roles.yaml'), 'utf8');
        const granted = roles.replace('      - operation: support.lookup_order\n', `      - operation: support.lookup_order\n      - operation: ${GRANTED}\n`);
        expect(granted).not.toBe(roles);
        await writeFile(join(editedDir, 'roles.yaml'), granted);
        const loaded = await loadConfigurationDirectory(editedDir, configurationLoadOptions(adapter, env));
        if (!loaded.ok) throw new Error(`edited configuration invalid: ${JSON.stringify(loaded.issues)}`);
        const files = revisionFilesOf(loaded.configuration);
        if (!files.ok) throw new Error('edited configuration cannot be stored');

        // On a second pool, as `aiops config apply` would write it.
        const id = randomUUID();
        const applied = await new PostgresConfigRevisionStore(cli.db, { databaseUrl: url }).apply(
          { id, hash: loaded.configuration.hash, files: files.files, actor: 'cli:test', summary: revisionSummary(loaded.configuration) },
          {
            id: randomUUID(),
            actor: 'cli:test',
            action: 'config.apply',
            outcome: 'ok',
            correlationId: randomUUID(),
            details: { revision: id, hash: loaded.configuration.hash, previousHash: start.hash, added: 0, removed: 0, changed: 1 },
          },
          start.hash,
        );
        expect(applied.ok).toBe(true);

        // Observable state: the holder's hash, every 100 ms for up to 10 s.
        const deadline = Date.now() + 10_000;
        for (;;) {
          const state = holder.state();
          if (state.status === 'active' && state.hash === loaded.configuration.hash) break;
          if (Date.now() > deadline) throw new Error(`holder did not reach the applied hash; state ${JSON.stringify(state)}`);
          await new Promise((resolve) => setTimeout(resolve, 100));
        }
        expect(holder.state()).toEqual({ status: 'active', revision: id, hash: loaded.configuration.hash });
        expect(holder.current.policy.roles.find((r) => r.id === 'support_agent')?.grants.map((g) => g.operation)).toContain(GRANTED);

        const afterApply = await loadRows(database);
        expect(afterApply.map((r) => [r.actor, r.outcome, r.details])).toEqual([
          ['system:worker', 'ok', { revision: start.revision, hash: start.hash, service: 'worker', trigger: 'start', presets: MAGENTO_PRESETS }],
          ['system:worker', 'ok', { revision: id, hash: loaded.configuration.hash, service: 'worker', trigger: 'notify', presets: MAGENTO_PRESETS }],
        ]);

        // SIGHUP finds the same seq: unchanged, no row. Refreshes run one after another, so the
        // refresh awaited here settles after the one the signal queued.
        signals.emit('SIGHUP');
        expect(await holder.refresh('poll')).toEqual({ outcome: 'unchanged' });
        const afterSignal = await loadRows(database);
        expect(afterSignal.map((r) => r.seq)).toEqual(afterApply.map((r) => r.seq));
      } finally {
        await sync.close();
      }
      expect(signals.listenerCount('SIGHUP')).toBe(0);
    } finally {
      await cli.close();
      await database.close();
    }
  }, 60_000);

  it('CFG-2 CFG-4 a worker whose only revision mismatches waits, and starts once a loadable revision is applied', async () => {
    const url = await postgres.createDatabase();
    await runMigrations(url);
    const env = parseWorkerEnv({
      DATABASE_URL: url,
      // Nothing listens here: reaching the connect proves the wait ended.
      TEMPORAL_ADDRESS: '127.0.0.1:1',
      AIOPS_CONFIG_DIR: CONFIG_DIR,
      AIOPS_PRESET_DIRS: PRESET_DIRS,
      AIOPS_MASTER_KEYS: MASTER_KEYS,
      AIOPS_TEMPORAL_KEYS: TEMPORAL_KEYS,
      // An ephemeral port: integration files run in parallel (ruling F11).
      AIOPS_WORKER_HTTP_PORT: '0',
    });
    const adapter = createOpenApiAdapter();
    const loaded = await loadConfigurationDirectory(CONFIG_DIR, configurationLoadOptions(adapter, env));
    if (!loaded.ok) throw new Error('deploy/config invalid');
    const files = revisionFilesOf(loaded.configuration);
    if (!files.ok) throw new Error('deploy/config cannot be stored');
    const wrongHash = loaded.configuration.hash === 'f'.repeat(64) ? 'e'.repeat(64) : 'f'.repeat(64);
    const cli = createDb(url, { onError: () => undefined });
    const lines: string[] = [];
    const logger = pino({ level: 'warn' }, { write: (line: string) => lines.push(line) });
    const signals = new EventEmitter();
    try {
      const cliStore = new PostgresConfigRevisionStore(cli.db, { databaseUrl: url });
      const stored = await cliStore.bootstrap({ id: randomUUID(), hash: wrongHash, files: files.files, summary: revisionSummary(loaded.configuration) });

      let settled = false;
      const starting = startWorkerRuntime(env, logger, signals).finally(() => {
        settled = true;
      });
      // Handled at once; asserted below.
      starting.catch(() => undefined);
      const waiting = (): { msg?: string; state?: unknown } | undefined =>
        lines.map((l) => JSON.parse(l) as { msg?: string; state?: unknown }).find((l) => l.msg === 'waiting for a loadable configuration');
      const deadline = Date.now() + 10_000;
      while (waiting() === undefined) {
        if (Date.now() > deadline) throw new Error(`no waiting log; lines ${JSON.stringify(lines)}`);
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
      expect(waiting()?.state).toEqual({ status: 'configuration_mismatch', revision: stored.id });
      expect(settled).toBe(false);
      expect(signals.listenerCount('SIGHUP')).toBe(1);

      const id = randomUUID();
      const applied = await cliStore.apply(
        { id, hash: loaded.configuration.hash, files: files.files, actor: 'cli:test', summary: revisionSummary(loaded.configuration) },
        {
          id: randomUUID(),
          actor: 'cli:test',
          action: 'config.apply',
          outcome: 'ok',
          correlationId: randomUUID(),
          details: { revision: id, hash: loaded.configuration.hash, previousHash: wrongHash, added: 0, removed: 0, changed: 0 },
        },
        wrongHash,
      );
      expect(applied.ok).toBe(true);
      // The wait ends on NOTIFY; the start then reaches the Temporal connect, which fails, and cleans up (F6).
      await expect(starting).rejects.toThrow(/ConnectionRefused/);
      expect(signals.listenerCount('SIGHUP')).toBe(0);
      const rows = await loadRows(cli);
      expect(rows.map((r) => [r.outcome, r.details.trigger, r.details.code])).toEqual([
        ['error', 'start', 'configuration_mismatch'],
        ['ok', 'notify', undefined],
      ]);
    } finally {
      await cli.close();
    }
  }, 60_000);
});
