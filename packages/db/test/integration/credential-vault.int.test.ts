import { randomBytes } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { InMemoryAuditLog, startPostgres, type StartedPostgres } from '@aiops/testing';
import { createDb, type Database } from '../../src/client.js';
import { PostgresCredentialVault } from '../../src/credential-vault.js';
import { parseMasterKeys } from '../../src/keyring.js';
import { runMigrations } from '../../src/migrate.js';

const KEY_1 = randomBytes(32).toString('base64');
const KEY_2 = randomBytes(32).toString('base64');
const SECRET_VALUE = 'dev-only-plaintext-marker-7f3a9c';

let postgres: StartedPostgres;
let database: Database;

beforeAll(async () => {
  postgres = await startPostgres();
  const url = await postgres.createDatabase();
  await runMigrations(url);
  database = createDb(url, { onError: () => undefined });
});

afterAll(async () => {
  await database.close();
  await postgres.stop();
});

beforeEach(async () => {
  await database.pool.query('DELETE FROM credential');
});

describe('SEC-2 credential vault in PostgreSQL', () => {
  it('stores no plaintext bytes in the row (as text and as hex)', async () => {
    const vault = new PostgresCredentialVault(database.db, parseMasterKeys(`1:${KEY_1}`));
    await expect(
      vault.put({ ref: 'magento_token', scheme: 'bearer', secret: { token: SECRET_VALUE }, actor: 'alice' }),
    ).resolves.toEqual({ keyVersion: 1 });

    const asText = await database.pool.query<{ row: string }>(
      'SELECT row_to_json(c)::text AS row FROM credential c',
    );
    const asHex = await database.pool.query<{ hex: string }>(
      `SELECT encode(ciphertext, 'hex') || encode(nonce, 'hex') || encode(wrapped_key, 'hex')
              || encode(key_nonce, 'hex') AS hex FROM credential`,
    );
    expect(asText.rows).toHaveLength(1);
    const text = asText.rows[0]?.row ?? '';
    const hex = asHex.rows[0]?.hex ?? '';
    expect(text).toContain('magento_token');
    expect(text).not.toContain(SECRET_VALUE);
    expect(hex).not.toContain(Buffer.from(SECRET_VALUE, 'utf8').toString('hex'));
    expect(hex).not.toContain(Buffer.from(KEY_1, 'base64').toString('hex'));
  });

  it('handle().open() returns the secret', async () => {
    const vault = new PostgresCredentialVault(database.db, parseMasterKeys(`1:${KEY_1}`));
    await vault.put({ ref: 'magento_token', scheme: 'bearer', secret: { token: SECRET_VALUE }, actor: 'alice' });
    const handle = await vault.handle('magento_token');
    expect(handle?.ref).toBe('magento_token');
    expect(handle?.scheme).toBe('bearer');
    await expect(handle?.open()).resolves.toEqual({ token: SECRET_VALUE });
    await expect(vault.handle('missing')).resolves.toBeUndefined();
  });

  it('put upserts: a second put replaces the secret and the scheme', async () => {
    const vault = new PostgresCredentialVault(database.db, parseMasterKeys(`1:${KEY_1}`));
    await vault.put({ ref: 'r', scheme: 'bearer', secret: { token: 'dev-only-a' }, actor: 'alice' });
    await vault.put({
      ref: 'r',
      scheme: 'basic',
      secret: { username: 'dev-only-u', password: 'dev-only-p' },
      actor: 'bob',
    });
    const handle = await vault.handle('r');
    expect(handle?.scheme).toBe('basic');
    await expect(handle?.open()).resolves.toEqual({ username: 'dev-only-u', password: 'dev-only-p' });
    const [status] = await vault.describe(['r']);
    expect(status?.updatedBy).toBe('bob');
  });

  it('a row copied to another ref does not open', async () => {
    const vault = new PostgresCredentialVault(database.db, parseMasterKeys(`1:${KEY_1}`));
    await vault.put({ ref: 'source_ref', scheme: 'bearer', secret: { token: SECRET_VALUE }, actor: 'alice' });
    await database.pool.query(
      `INSERT INTO credential (ref, scheme, ciphertext, nonce, wrapped_key, key_nonce, key_version, updated_by)
       SELECT 'stolen_ref', scheme, ciphertext, nonce, wrapped_key, key_nonce, key_version, updated_by
       FROM credential WHERE ref = 'source_ref'`,
    );
    const handle = await vault.handle('stolen_ref');
    expect(handle).toBeDefined();
    const error = await handle?.open().then(
      () => undefined,
      (caught: unknown) => caught,
    );
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).not.toContain(SECRET_VALUE);
  });

  it('rotate rewraps every old-version row once, audits it, and the rows open with only the new key', async () => {
    const v1 = new PostgresCredentialVault(database.db, parseMasterKeys(`1:${KEY_1}`));
    await v1.put({ ref: 'a', scheme: 'bearer', secret: { token: 'dev-only-a' }, actor: 'alice' });
    await v1.put({ ref: 'b', scheme: 'api_key', secret: { key: 'dev-only-b' }, actor: 'alice' });

    const both = new PostgresCredentialVault(database.db, parseMasterKeys(`2:${KEY_2},1:${KEY_1}`));
    await both.put({ ref: 'c', scheme: 'bearer', secret: { token: 'dev-only-c' }, actor: 'alice' });
    const audit = new InMemoryAuditLog();

    await expect(both.rotate('cli', audit, 'corr-rotate-1')).resolves.toEqual({ rewrapped: 2, onOldVersions: 0 });
    expect(audit.events).toHaveLength(2);
    const subjects = audit.events.map((event) => event.subject).sort();
    expect(subjects).toEqual(['a', 'b']);
    for (const event of audit.events) {
      expect(event).toMatchObject({
        actor: 'cli',
        action: 'credential.rotate',
        outcome: 'ok',
        correlationId: 'corr-rotate-1',
        details: { fromVersion: 1, toVersion: 2 },
      });
      const serialized = JSON.stringify(event);
      for (const material of [KEY_1, KEY_2, 'dev-only-a', 'dev-only-b']) expect(serialized).not.toContain(material);
    }

    await expect(both.rotate('cli', audit, 'corr-rotate-2')).resolves.toEqual({ rewrapped: 0, onOldVersions: 0 });
    expect(audit.events).toHaveLength(2);

    const v2 = new PostgresCredentialVault(database.db, parseMasterKeys(`2:${KEY_2}`));
    await expect((await v2.handle('a'))?.open()).resolves.toEqual({ token: 'dev-only-a' });
    await expect((await v2.handle('b'))?.open()).resolves.toEqual({ key: 'dev-only-b' });
    await expect((await v2.handle('c'))?.open()).resolves.toEqual({ token: 'dev-only-c' });
  });

  it('rotate counts rows whose key version is not configured as still on old versions', async () => {
    const v1 = new PostgresCredentialVault(database.db, parseMasterKeys(`1:${KEY_1}`));
    await v1.put({ ref: 'a', scheme: 'bearer', secret: { token: 'dev-only-a' }, actor: 'alice' });
    const v2 = new PostgresCredentialVault(database.db, parseMasterKeys(`2:${KEY_2}`));
    const audit = new InMemoryAuditLog();
    await expect(v2.rotate('cli', audit, 'corr')).resolves.toEqual({ rewrapped: 0, onOldVersions: 1 });
    expect(audit.events).toHaveLength(0);
  });

  it('describe returns metadata only, in the requested order, with unset refs', async () => {
    const vault = new PostgresCredentialVault(database.db, parseMasterKeys(`1:${KEY_1}`));
    await vault.put({ ref: 'magento_token', scheme: 'bearer', secret: { token: SECRET_VALUE }, actor: 'alice' });
    const statuses = await vault.describe(['missing', 'magento_token']);
    expect(statuses).toHaveLength(2);
    expect(statuses[0]).toEqual({ ref: 'missing', set: false });
    const status = statuses[1];
    expect(Object.keys(status ?? {}).sort()).toEqual(['keyVersion', 'ref', 'scheme', 'set', 'updatedAt', 'updatedBy']);
    expect(status).toMatchObject({ ref: 'magento_token', set: true, scheme: 'bearer', updatedBy: 'alice', keyVersion: 1 });
    expect(status?.updatedAt).toBeInstanceOf(Date);
    expect(JSON.stringify(statuses)).not.toContain(SECRET_VALUE);
    await expect(vault.describe([])).resolves.toEqual([]);
  });
});
