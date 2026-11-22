// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Mandate Authors
import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startPostgres, type StartedPostgres } from '@mandate/testing';
import { createDb, type Database } from '../../src/client.js';
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

async function insertChangeSet(): Promise<string> {
  const id = randomUUID();
  await database.db.execute(sql`
    INSERT INTO change_set (id, operation, connection, requester, args, hash, status, stats, config_hash, correlation_id, created_at, expires_at)
    VALUES (${id}, 'op', 'conn', 'alice', '{}'::jsonb, 'h', 'approved', '{}'::jsonb, 'cfg', 'corr', now(), now() + interval '1 day')`);
  return id;
}

async function rejection(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
  } catch (error) {
    // Drizzle wraps the driver error; the trigger message sits on the cause.
    const cause = (error as { cause?: { message?: string } }).cause;
    return cause?.message ?? (error as Error).message;
  }
  throw new Error('expected the statement to be rejected');
}

describe('POL-6 execution request columns', () => {
  it('POL-6 execution request columns are written once: a second change is rejected', async () => {
    const id = await insertChangeSet();
    await database.db.execute(sql`
      UPDATE change_set SET execution_actor = 'bob', execution_groups = '["g"]'::jsonb, execution_client_id = 'c1',
        execution_correlation_id = 'x1', execution_started_at = now() WHERE id = ${id}`);
    const message = await rejection(
      database.db.execute(sql`UPDATE change_set SET execution_actor = 'eve' WHERE id = ${id}`),
    );
    expect(message).toBe('change_set update rejected: execution request is fixed');
    // Unrelated updates still work and an unchanged value is not a change.
    await database.db.execute(
      sql`UPDATE change_set SET execution_actor = 'bob', status = 'executing', updated_at = now() WHERE id = ${id}`,
    );
  });
});

describe('EXE-7 cancel request columns', () => {
  it('EXE-7 cancel request columns are written once', async () => {
    const id = await insertChangeSet();
    await database.db.execute(sql`
      UPDATE change_set SET cancel_requested_by = 'bob', cancel_correlation_id = 'k1', cancel_requested_at = now() WHERE id = ${id}`);
    const message = await rejection(
      database.db.execute(sql`UPDATE change_set SET cancel_requested_by = 'eve' WHERE id = ${id}`),
    );
    expect(message).toBe('change_set update rejected: execution request is fixed');
  });
});

describe('EXE-3 change_batch', () => {
  async function insertBatch(id: string, batchNo: number): Promise<void> {
    await database.db.execute(sql`
      INSERT INTO change_batch (changeset_id, batch_no, attempt, state, target_ids, last_target)
      VALUES (${id}, ${batchNo}, 1, 'open', '["a","b"]'::jsonb, 'b')`);
  }

  it('EXE-3 a done change_batch row cannot change any more', async () => {
    const id = await insertChangeSet();
    await insertBatch(id, 0);
    await database.db.execute(sql`UPDATE change_batch SET written = 2, state = 'done' WHERE changeset_id = ${id}`);
    const message = await rejection(
      database.db.execute(sql`UPDATE change_batch SET written = 3 WHERE changeset_id = ${id}`),
    );
    expect(message).toBe('change_batch update rejected: batch is done');
  });

  it('EXE-3 change_batch rows are never deleted', async () => {
    const id = await insertChangeSet();
    await insertBatch(id, 0);
    expect(await rejection(database.db.execute(sql`DELETE FROM change_batch WHERE changeset_id = ${id}`))).toContain(
      'never deleted',
    );
    expect(await rejection(database.db.execute(sql`TRUNCATE change_batch`))).toContain('never deleted');
  });
});

describe('POL-4 rate_bucket', () => {
  it('POL-4 rate_bucket upsert increments per key and window', async () => {
    const key = `k-${randomUUID()}`;
    const upsert = async (): Promise<number> => {
      const result = await database.db.execute<{ count: number }>(sql`
        INSERT INTO rate_bucket (key, window_start, count) VALUES (${key}, '2026-01-01T00:00:00Z', 1)
        ON CONFLICT (key, window_start) DO UPDATE SET count = rate_bucket.count + 1 RETURNING count`);
      return Number(result.rows[0]?.count);
    };
    expect(await upsert()).toBe(1);
    expect(await upsert()).toBe(2);
  });
});
