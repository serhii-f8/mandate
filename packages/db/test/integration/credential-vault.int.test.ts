// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Mandate Authors
import { randomBytes, randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { startPostgres, type StartedPostgres } from '@mandate/testing';
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
  // Test-only: a deferred constraint trigger that fails the commit of any transaction that
  // wrote the ref `fail_at_commit`, i.e. a failure after every statement (the audit insert
  // included) has run inside the transaction.
  await database.pool.query(`
    CREATE FUNCTION test_fail_at_commit() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN RAISE EXCEPTION 'test failure at commit'; END; $$;
    CREATE CONSTRAINT TRIGGER test_fail_at_commit AFTER INSERT OR UPDATE ON credential
      DEFERRABLE INITIALLY DEFERRED FOR EACH ROW WHEN (NEW.ref = 'fail_at_commit')
      EXECUTE FUNCTION test_fail_at_commit();
    CREATE FUNCTION test_fail_audit() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN RAISE EXCEPTION 'audit unavailable'; END; $$;
    CREATE TRIGGER test_fail_audit BEFORE INSERT ON audit_event
      FOR EACH ROW WHEN (NEW.correlation_id LIKE 'fail-audit%')
      EXECUTE FUNCTION test_fail_audit();
  `);
});

async function auditCount(where: string, params: unknown[]): Promise<number> {
  const result = await database.pool.query<{ n: number }>(`SELECT count(*)::int AS n FROM audit_event WHERE ${where}`, params);
  return result.rows[0]?.n ?? -1;
}

interface AuditRow {
  actor: string;
  action: string;
  subject: string | null;
  outcome: string;
  correlation_id: string;
  details: Record<string, unknown>;
}

async function auditRowsOf(correlationId: string): Promise<AuditRow[]> {
  const result = await database.pool.query<AuditRow>(
    'SELECT actor, action, subject, outcome, correlation_id, details FROM audit_event WHERE correlation_id = $1 ORDER BY seq',
    [correlationId],
  );
  return result.rows;
}

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
    const first = randomUUID();

    await expect(both.rotate('cli', first)).resolves.toEqual({
      rewrapped: 2,
      onOldVersions: 0,
      failed: [],
    });
    const events = await auditRowsOf(first);
    expect(events).toHaveLength(2);
    const subjects = events.map((event) => event.subject).sort();
    expect(subjects).toEqual(['a', 'b']);
    for (const event of events) {
      expect(event).toMatchObject({
        actor: 'cli',
        action: 'credential.rotate',
        outcome: 'ok',
        correlation_id: first,
        details: { fromVersion: 1, toVersion: 2 },
      });
      const serialized = JSON.stringify(event);
      for (const material of [KEY_1, KEY_2, 'dev-only-a', 'dev-only-b']) expect(serialized).not.toContain(material);
    }

    const second = randomUUID();
    await expect(both.rotate('cli', second)).resolves.toEqual({
      rewrapped: 0,
      onOldVersions: 0,
      failed: [],
    });
    expect(await auditRowsOf(second)).toHaveLength(0);

    const v2 = new PostgresCredentialVault(database.db, parseMasterKeys(`2:${KEY_2}`));
    await expect((await v2.handle('a'))?.open()).resolves.toEqual({ token: 'dev-only-a' });
    await expect((await v2.handle('b'))?.open()).resolves.toEqual({ key: 'dev-only-b' });
    await expect((await v2.handle('c'))?.open()).resolves.toEqual({ token: 'dev-only-c' });
  });

  it('rotate reports rows whose key version is not configured as failed and still on old versions', async () => {
    const v1 = new PostgresCredentialVault(database.db, parseMasterKeys(`1:${KEY_1}`));
    await v1.put({ ref: 'a', scheme: 'bearer', secret: { token: 'dev-only-a' }, actor: 'alice' });
    const v2 = new PostgresCredentialVault(database.db, parseMasterKeys(`2:${KEY_2}`));
    const correlationId = randomUUID();
    await expect(v2.rotate('cli', correlationId)).resolves.toEqual({
      rewrapped: 0,
      onOldVersions: 1,
      failed: ['a'],
    });
    expect(await auditRowsOf(correlationId)).toHaveLength(0);
  });

  it('rotate reports rows that fail authentication as failed, by ref only', async () => {
    const v1 = new PostgresCredentialVault(database.db, parseMasterKeys(`1:${KEY_1}`));
    await v1.put({ ref: 'good', scheme: 'bearer', secret: { token: 'dev-only-good' }, actor: 'alice' });
    await v1.put({ ref: 'broken', scheme: 'bearer', secret: { token: 'dev-only-broken' }, actor: 'alice' });
    await database.pool.query(
      `UPDATE credential SET wrapped_key = set_byte(wrapped_key, 0, get_byte(wrapped_key, 0) # 255) WHERE ref = 'broken'`,
    );
    const both = new PostgresCredentialVault(database.db, parseMasterKeys(`1:${KEY_1},2:${KEY_2}`));
    const correlationId = randomUUID();
    const result = await both.rotate('cli', correlationId);
    expect(result).toEqual({ rewrapped: 1, onOldVersions: 1, failed: ['broken'] });
    expect(JSON.stringify(result)).not.toContain('dev-only');
    expect((await auditRowsOf(correlationId)).map((event) => event.subject)).toEqual(['good']);
  });

  it('SEC-2 AUD-1 put with an audit appends the event with the stored key version', async () => {
    const vault = new PostgresCredentialVault(database.db, parseMasterKeys(`1:${KEY_1}`));
    const correlationId = randomUUID();
    const result = await vault.put({
      ref: 'r',
      scheme: 'bearer',
      secret: { token: SECRET_VALUE },
      actor: 'carol',
      audit: {
        event: (keyVersion) => ({ id: randomUUID(), actor: 'carol', action: 'credential.set', outcome: 'ok', correlationId, details: { ref: 'r', keyVersion } }),
      },
    });
    expect(result).toEqual({ keyVersion: 1 });
    expect(await auditRowsOf(correlationId)).toEqual([expect.objectContaining({ action: 'credential.set', details: { ref: 'r', keyVersion: 1 } })]);
  });

  it('SEC-2 AUD-1 put rolls back when its audit append fails: a new ref is not stored, an old value is kept', async () => {
    const vault = new PostgresCredentialVault(database.db, parseMasterKeys(`1:${KEY_1}`));
    // The test trigger refuses audit inserts with this correlation id.
    const correlationId = `fail-audit-${randomUUID()}`;
    const event = (keyVersion: number) => ({ id: randomUUID(), actor: 'carol', action: 'credential.set' as const, outcome: 'ok' as const, correlationId, details: { keyVersion } });

    await expect(vault.put({ ref: 'new', scheme: 'bearer', secret: { token: 'dev-only-new' }, actor: 'carol', audit: { event } })).rejects.toThrow();
    await expect(vault.handle('new')).resolves.toBeUndefined();

    await vault.put({ ref: 'old', scheme: 'bearer', secret: { token: 'dev-only-old' }, actor: 'alice' });
    await expect(vault.put({ ref: 'old', scheme: 'bearer', secret: { token: 'dev-only-replaced' }, actor: 'carol', audit: { event } })).rejects.toThrow();
    await expect((await vault.handle('old'))?.open()).resolves.toEqual({ token: 'dev-only-old' });
    expect((await vault.describe(['old']))[0]?.updatedBy).toBe('alice');
    expect(await auditRowsOf(correlationId)).toEqual([]);
  });

  it('rotate rolls a row back when its audit append fails, and a re-run retries it', async () => {
    const v1 = new PostgresCredentialVault(database.db, parseMasterKeys(`1:${KEY_1}`));
    await v1.put({ ref: 'a', scheme: 'bearer', secret: { token: 'dev-only-a' }, actor: 'alice' });
    const both = new PostgresCredentialVault(database.db, parseMasterKeys(`1:${KEY_1},2:${KEY_2}`));
    // The test trigger refuses audit inserts with this correlation id.
    const failing = `fail-audit-${randomUUID()}`;

    await expect(both.rotate('cli', failing)).resolves.toEqual({
      rewrapped: 0,
      onOldVersions: 1,
      failed: [],
    });
    const [status] = await both.describe(['a']);
    expect(status?.keyVersion).toBe(1);
    expect(await auditRowsOf(failing)).toHaveLength(0);

    const retry = randomUUID();
    await expect(both.rotate('cli', retry)).resolves.toEqual({
      rewrapped: 1,
      onOldVersions: 0,
      failed: [],
    });
    expect(await auditRowsOf(retry)).toHaveLength(1);
    await expect((await both.handle('a'))?.open()).resolves.toEqual({ token: 'dev-only-a' });
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

  it('SEC-2 AUD-1 put: a failure after the audit insert, at commit, leaves neither the credential nor the audit row', async () => {
    const vault = new PostgresCredentialVault(database.db, parseMasterKeys(`1:${KEY_1}`));
    const id = randomUUID();
    await expect(
      vault.put({
        ref: 'fail_at_commit',
        scheme: 'bearer',
        secret: { token: 'dev-only-x' },
        actor: 'carol',
        audit: { event: (keyVersion) => ({ id, actor: 'carol', action: 'credential.set', outcome: 'ok', correlationId: 'c', details: { keyVersion } }) },
      }),
    ).rejects.toThrow();
    await expect(vault.handle('fail_at_commit')).resolves.toBeUndefined();
    expect(await auditCount('id = $1', [id])).toBe(0);
  });

  it('SEC-2 AUD-1 put: 15 concurrent audited puts against a pool of 10 all succeed and are all audited', async () => {
    const vault = new PostgresCredentialVault(database.db, parseMasterKeys(`1:${KEY_1}`));
    const correlationId = randomUUID();
    const refs = Array.from({ length: 15 }, (_, i) => `concurrent_${String(i)}`);
    const results = await Promise.allSettled(
      refs.map((ref) =>
        vault.put({
          ref,
          scheme: 'bearer',
          secret: { token: 'dev-only-c' },
          actor: 'carol',
          audit: { event: (keyVersion) => ({ id: randomUUID(), actor: 'carol', action: 'credential.set', subject: ref, outcome: 'ok', correlationId, details: { keyVersion } }) },
        }),
      ),
    );
    expect(results.filter((r) => r.status === 'rejected')).toHaveLength(0);
    expect(await auditCount('correlation_id = $1', [correlationId])).toBe(15);
    expect((await vault.describe(refs)).every((status) => status.set)).toBe(true);
  }, 30_000);

  it('SEC-2 AUD-1 rotate: a failure after the audit insert, at commit, leaves the row on its old version and no audit row', async () => {
    const v1 = new PostgresCredentialVault(database.db, parseMasterKeys(`1:${KEY_1}`));
    await database.pool.query('ALTER TABLE credential DISABLE TRIGGER test_fail_at_commit');
    await v1.put({ ref: 'fail_at_commit', scheme: 'bearer', secret: { token: 'dev-only-r' }, actor: 'alice' });
    await database.pool.query('ALTER TABLE credential ENABLE TRIGGER test_fail_at_commit');
    const both = new PostgresCredentialVault(database.db, parseMasterKeys(`2:${KEY_2},1:${KEY_1}`));
    const correlationId = randomUUID();
    await expect(both.rotate('cli', correlationId)).resolves.toEqual({ rewrapped: 0, onOldVersions: 1, failed: [] });
    expect((await both.describe(['fail_at_commit']))[0]?.keyVersion).toBe(1);
    expect(await auditCount('correlation_id = $1', [correlationId])).toBe(0);
  });
});
