// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The AI Operations Layer Authors
import { cp, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import pg from 'pg';
import { createDb, parseMasterKeys, PostgresConfigRevisionStore, PostgresCredentialVault } from '@aiops/db';
import { startFakeUpstream, type FakeUpstream, type StartedPostgres } from '@aiops/testing';
import { runApiCli } from '../../src/cli.js';
import { auditRows, startDatabase } from './helpers.js';

const CREDENTIALS_CONFIG = fileURLToPath(new URL('./fixtures/credentials-config', import.meta.url));
/** Obviously fake master keys (version 1 and 2) and credential value. */
const KEY_1 = 'ZGV2LW9ubHktbWFzdGVyLWtleS0wMTIzNDU2Nzg5YWI=';
const KEY_2 = Buffer.alloc(32, 7).toString('base64');
const SECRET = 'e2e-only-cli-credential-value-0123456789';

let postgres: StartedPostgres;
let databaseUrl: string;
let upstream: FakeUpstream;
let configDir: string;
const authorizations: string[] = [];

beforeAll(async () => {
  ({ postgres, databaseUrl } = await startDatabase());
  upstream = await startFakeUpstream();
  upstream.route('GET', '/rest/V1/products', (request) => {
    authorizations.push(String(request.headers.authorization));
    return { status: 200, body: { items: [{ sku: 'a' }], total_count: 1 } };
  });
  configDir = await mkdtemp(join(tmpdir(), 'aiops-cli-e2e-'));
  await cp(CREDENTIALS_CONFIG, configDir, { recursive: true });
  const connections = join(configDir, 'connections.yaml');
  await writeFile(connections, (await readFile(connections, 'utf8')).replaceAll('__UPSTREAM_URL__', upstream.url));
});

afterAll(async () => {
  await upstream.close();
  await postgres.stop();
  await rm(configDir, { recursive: true });
});

/** Runs the CLI against the real database with the given master keys. */
async function cli(argv: string[], masterKeys: string, url = databaseUrl): Promise<{ code: number; lines: string[] }> {
  const lines: string[] = [];
  const code = await runApiCli(argv, (line) => lines.push(line), {
    env: { AIOPS_CONFIG_DIR: configDir, DATABASE_URL: url, AIOPS_MASTER_KEYS: masterKeys },
    defaultPresetDir: null,
  });
  return { code, lines };
}

/** Stores a credential directly through the vault, as the credential page would. */
async function store(ref: string, keys: string): Promise<void> {
  const database = createDb(databaseUrl, { onError: () => undefined });
  try {
    await new PostgresCredentialVault(database.db, parseMasterKeys(keys)).put({ ref, scheme: 'bearer', secret: { token: SECRET }, actor: 'e2e' });
  } finally {
    await database.close();
  }
}

describe('CONN-7 aiops test-connection against PostgreSQL', () => {
  it('CONN-7 AUD-1 reads the stored credential, calls the upstream with it and audits as cli', async () => {
    await store('shop-token', `1:${KEY_1}`);
    const { code, lines } = await cli(['test-connection', 'shop'], `1:${KEY_1}`);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatch(/^ok status=200 items=1 ms=\d+ scopes=not detectable$/);
    expect(code).toBe(0);
    expect(authorizations).toEqual([`Bearer ${SECRET}`]);
    const rows = await auditRows(databaseUrl, "action = 'connection.test'");
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ actor: 'cli', subject: 'shop', outcome: 'ok' });
    expect(JSON.stringify(rows)).not.toContain(SECRET);
  });

  it('CFG-3 a database without the migrations is refused with a clear message', async () => {
    const empty = await postgres.createDatabase();
    const { code, lines } = await cli(['test-connection', 'shop'], `1:${KEY_1}`, empty);
    expect(code).toBe(1);
    expect(lines.join('\n')).toContain('start the api once so it applies the migrations');
  });
});

describe('SEC-2 key rotation from the CLI', () => {
  it('SEC-2 AUD-1 re-wraps a version 1 credential under key 2, audits it, and key 1 can then go', async () => {
    await store('erp-key', `1:${KEY_1}`);
    const database = createDb(databaseUrl, { onError: () => undefined });
    try {
      const before = await new PostgresCredentialVault(database.db, parseMasterKeys(`1:${KEY_1}`)).describe(['erp-key']);
      expect(before[0]).toMatchObject({ set: true, keyVersion: 1 });

      const { code, lines } = await cli(['credentials', 'rotate'], `2:${KEY_2},1:${KEY_1}`);
      expect(lines).toEqual(['rewrapped=2 on_old_versions=0']);
      expect(code).toBe(0);

      const rows = await auditRows(databaseUrl, "action = 'credential.rotate' and subject = 'erp-key'");
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({ actor: 'cli', outcome: 'ok', details: { fromVersion: 1, toVersion: 2 } });

      // Only key 2 remains configured: the read path still works.
      const onlyNew = new PostgresCredentialVault(database.db, parseMasterKeys(`2:${KEY_2}`));
      const handle = await onlyNew.handle('erp-key');
      expect(await handle?.open()).toEqual({ token: SECRET });

      const again = await cli(['credentials', 'rotate'], `2:${KEY_2},1:${KEY_1}`);
      expect(again.lines).toEqual(['rewrapped=0 on_old_versions=0']);
    } finally {
      await database.close();
    }
  });

  it('SEC-2 a malformed master key set is a usage error naming the variable, never the value', async () => {
    const { code, lines } = await cli(['credentials', 'rotate'], 'not-a-key-list-secret');
    expect(code).toBe(2);
    expect(lines.join('\n')).toContain('AIOPS_MASTER_KEYS');
    expect(lines.join('\n')).not.toContain('not-a-key-list-secret');
  });
});

describe('CFG-3 CFG-4 aiops config apply against PostgreSQL', () => {
  it('CFG-3 CFG-4 config apply against PostgreSQL stores the revision, audits it and notifies a listener', async () => {
    const database = createDb(databaseUrl, { onError: () => undefined });
    const store = new PostgresConfigRevisionStore(database.db, { databaseUrl });
    const notifications: (() => void)[] = [];
    const changed = new Promise<void>((resolve) => notifications.push(resolve));
    const listener = await store.listen({
      onChange: () => {
        for (const resolve of notifications) resolve();
      },
      onReconnect: () => undefined,
      onError: () => undefined,
    });
    try {
      const { code, lines } = await cli(['config', 'apply', configDir, '--actor', 'e2e-operator'], `1:${KEY_1}`);
      expect(code).toBe(0);
      expect(lines).toContain('+ role support_agent');
      expect(lines.at(-2)).toMatch(/^hash none -> [0-9a-f]{64}$/);
      expect(lines.at(-1)).toMatch(/^applied revision [0-9a-f-]{36} \(seq \d+\)$/);
      await changed;

      const client = new pg.Client({ connectionString: databaseUrl });
      await client.connect();
      let revisions: { id: string; hash: string; source: string; actor: string; files: Record<string, string> }[];
      try {
        revisions = (await client.query<{ id: string; hash: string; source: string; actor: string; files: Record<string, string> }>('select id, hash, source, actor, files from config_revision order by seq')).rows;
      } finally {
        await client.end();
      }
      expect(revisions).toHaveLength(1);
      const [revision] = revisions;
      expect(revision).toMatchObject({ source: 'apply', actor: 'cli:e2e-operator' });
      expect(Object.keys(revision?.files ?? {}).sort()).toEqual(['connections.yaml', 'operations.yaml', 'roles.yaml']);
      expect(lines.at(-1)).toContain(String(revision?.id));

      const rows = await auditRows(databaseUrl, "action = 'config.apply'");
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({
        actor: 'cli:e2e-operator',
        outcome: 'ok',
        details: { revision: revision?.id, hash: revision?.hash, previousHash: null, removed: 0, changed: 0 },
      });

      const again = await cli(['config', 'apply', configDir, '--actor', 'e2e-operator'], `1:${KEY_1}`);
      expect(again).toEqual({ code: 0, lines: ['No changes'] });
    } finally {
      await listener.close();
      await database.close();
    }
  });

  it('CFG-3 config diff against a database without the migrations is refused with a clear message', async () => {
    const empty = await postgres.createDatabase();
    const { code, lines } = await cli(['config', 'diff', configDir], `1:${KEY_1}`, empty);
    expect(code).toBe(1);
    expect(lines).toEqual(['cannot read the config_revision table: check DATABASE_URL, and start the api once so it applies the migrations']);
  });
});

describe('CONN-1 aiops validate with an mcp connection', () => {
  it('CONN-1 aiops validate accepts an mcp connection and reports no issue when the server is down', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'aiops-cli-mcp-'));
    try {
      // Nothing listens on port 1: the load-time tool list fails, which is never a load issue (R1).
      await writeFile(
        join(dir, 'aiops.yaml'),
        `version: 1
connections:
  - { id: tools, adapter: mcp, mcp_url: 'http://127.0.0.1:1/mcp', allow_private_network: true, retry: { max_attempts: 1 } }
operations:
  - id: tools.lookup
    connection: tools
    risk: read
    description: Look up a record by key.
    upstream: { tool: lookup, pin: 'sha256:${'0'.repeat(64)}' }
roles:
  - id: reader
    grants: [{ operation: tools.lookup }]
`,
      );
      const lines: string[] = [];
      const code = await runApiCli(['validate', dir], (line) => lines.push(line), { env: {}, defaultPresetDir: null });
      expect(lines).toEqual(['Configuration valid: 1 connections, 1 operations, 1 roles']);
      expect(code).toBe(0);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
