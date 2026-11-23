// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Mandate Authors
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { sha256Of, type FileLink } from '@mandate/core';
import { fileStoreContract, startPostgres, type StartedPostgres } from '@mandate/testing';
import { createDb, type Database } from '../../src/client.js';
import { PostgresFileStore } from '../../src/file-store.js';
import { runMigrations } from '../../src/migrate.js';

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

const pool = () => database.pool;

fileStoreContract(() =>
  Promise.resolve({
    store: new PostgresFileStore(database.db),
    link: async (changesetId: string, links: readonly FileLink[]) => {
      await pool().query(
        `INSERT INTO change_set (id, operation, connection, requester, args, hash, status, stats, config_hash, correlation_id, created_at, expires_at)
         VALUES ($1, 'op', 'conn', 'alice', '{}'::jsonb, 'h', 'prepared', '{}'::jsonb, 'cfg', 'corr', now(), now() + interval '1 day')`,
        [changesetId],
      );
      for (const l of links) {
        await pool().query('INSERT INTO change_set_file (change_set_id, pointer, file_id) VALUES ($1, $2, $3)', [changesetId, l.pointer, l.fileId]);
      }
    },
    endChangeSet: async (changesetId: string, at: Date) => {
      await pool().query("UPDATE change_set SET status = 'completed', updated_at = $2 WHERE id = $1", [changesetId, at]);
    },
  }),
);

async function refusal(sqlText: string, params: unknown[]): Promise<string> {
  try {
    await pool().query(sqlText, params);
  } catch (error) {
    return (error as Error).message;
  }
  throw new Error('expected the statement to be rejected');
}

describe('CS-10 staged file schema', () => {
  it('CS-10 the database refuses to edit a staged file, delete one, or edit a link', async () => {
    const store = new PostgresFileStore(database.db);
    const id = randomUUID();
    const bytes = new TextEncoder().encode('abc');
    const staged = await store.stage(
      { id, owner: 'o', name: 'n.txt', mediaType: 'text/plain', content: bytes, sha256: sha256Of(bytes), preview: 'text', createdAt: new Date(), quota: { count: 5, bytes: 100 } },
      { id: randomUUID(), actor: 'o', action: 'file.staged', outcome: 'ok', correlationId: 'c-1', details: { size: 3 } },
    );
    expect(staged.ok).toBe(true);
    const audited = await pool().query<{ n: number }>("SELECT count(*)::int AS n FROM audit_event WHERE correlation_id = 'c-1' AND action = 'file.staged'");
    expect(audited.rows[0]?.n).toBe(1);
    await expect(refusal("UPDATE staged_file SET name = 'x' WHERE id = $1", [id])).resolves.toMatch(/staged_file/);
    await expect(refusal("UPDATE staged_file SET content = '\\x00'::bytea WHERE id = $1", [id])).resolves.toMatch(/staged_file/);
    await expect(refusal('DELETE FROM staged_file WHERE id = $1', [id])).resolves.toMatch(/staged_file/);
    // The content check: content and purged_at go together.
    await expect(refusal('UPDATE staged_file SET purged_at = now() WHERE id = $1', [id])).resolves.toBeTruthy();
    const cs = randomUUID();
    await pool().query(
      `INSERT INTO change_set (id, operation, connection, requester, args, hash, status, stats, config_hash, correlation_id, created_at, expires_at)
       VALUES ($1, 'op', 'conn', 'alice', '{}'::jsonb, 'h', 'prepared', '{}'::jsonb, 'cfg', 'corr', now(), now() + interval '1 day')`,
      [cs],
    );
    await pool().query('INSERT INTO change_set_file (change_set_id, pointer, file_id) VALUES ($1, $2, $3)', [cs, '/f', id]);
    await expect(refusal("UPDATE change_set_file SET pointer = '/g' WHERE change_set_id = $1", [cs])).resolves.toMatch(/change_set_file/);
    await expect(refusal('DELETE FROM change_set_file WHERE change_set_id = $1', [cs])).resolves.toMatch(/change_set_file/);
  });

  it('CS-10 the audit event rolls back with a refused stage', async () => {
    const store = new PostgresFileStore(database.db);
    const owner = `o-${randomUUID()}`;
    const bytes = new TextEncoder().encode('abc');
    const input = (id: string) => ({ id, owner, name: 'n', mediaType: 'text/plain', content: bytes, sha256: sha256Of(bytes), preview: 'text' as const, createdAt: new Date(), quota: { count: 1, bytes: 100 } });
    const event = (corr: string) => ({ id: randomUUID(), actor: owner, action: 'file.staged' as const, outcome: 'ok' as const, correlationId: corr, details: {} });
    expect((await store.stage(input(randomUUID()), event('c-ok'))).ok).toBe(true);
    expect((await store.stage(input(randomUUID()), event('c-refused'))).ok).toBe(false);
    const n = await pool().query<{ n: number }>("SELECT count(*)::int AS n FROM audit_event WHERE correlation_id = 'c-refused'");
    expect(n.rows[0]?.n).toBe(0);
  });
});
