import { cp, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDb, parseMasterKeys, PostgresCredentialVault } from '@aiops/db';
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
