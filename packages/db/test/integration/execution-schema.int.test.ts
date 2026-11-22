// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Mandate Authors
import { randomUUID } from 'node:crypto';
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import pg from 'pg';
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

describe('EXE-12 verification storage', () => {
  const MIGRATIONS = fileURLToPath(new URL('../../migrations', import.meta.url));

  /** An executing change-set with item `a` written and item `b` excluded. */
  async function executing(): Promise<string> {
    const id = randomUUID();
    await database.db.execute(sql`
      INSERT INTO change_set (id, operation, connection, requester, args, status, stats, config_hash, correlation_id, created_at, expires_at)
      VALUES (${id}, 'op', 'conn', 'alice', '{}'::jsonb, 'preparing', '{}'::jsonb, 'cfg', 'corr', now(), now() + interval '1 day')`);
    await database.db.execute(sql`
      INSERT INTO change_item (changeset_id, target_id, status, reason, before, after) VALUES
        (${id}, 'a', 'pending', NULL, '{"v":1}'::jsonb, '{"v":2}'::jsonb),
        (${id}, 'b', 'excluded', 'no_change', '{"v":1}'::jsonb, '{"v":1}'::jsonb)`);
    await database.db.execute(
      sql`UPDATE change_set SET status = 'prepared', hash = 'h', prepared_at = now() WHERE id = ${id}`,
    );
    await database.db.execute(sql`UPDATE change_set SET status = 'executing' WHERE id = ${id}`);
    await database.db.execute(sql`UPDATE change_item SET status = 'written' WHERE changeset_id = ${id} AND target_id = 'a'`);
    return id;
  }

  /** The trigger message, or the name of the violated constraint. */
  async function refusal(promise: Promise<unknown>): Promise<string> {
    try {
      await promise;
    } catch (error) {
      const cause = (error as { cause?: { message?: string; constraint?: string } }).cause;
      return cause?.constraint ?? cause?.message ?? (error as Error).message;
    }
    throw new Error('expected the statement to be rejected');
  }

  /** The committed migrations up to and including 0015, as the previous release shipped them. */
  function migrationsThrough0015(): string {
    const dir = mkdtempSync(join(tmpdir(), 'mandate-mig-'));
    cpSync(MIGRATIONS, dir, { recursive: true });
    const journalPath = join(dir, 'meta', '_journal.json');
    const journal = JSON.parse(readFileSync(journalPath, 'utf8')) as { entries: { idx: number; tag: string }[] };
    for (const entry of journal.entries.filter((e) => e.idx > 15)) rmSync(join(dir, `${entry.tag}.sql`));
    journal.entries = journal.entries.filter((entry) => entry.idx <= 15);
    writeFileSync(journalPath, JSON.stringify(journal));
    return dir;
  }

  it('NFR-5 EXE-12 migration 0016 applies on a database at 0015 that holds an executing change-set', async () => {
    const url = await postgres.createDatabase();
    const folder = migrationsThrough0015();
    const id = randomUUID();
    const client = new pg.Client({ connectionString: url });
    await client.connect();
    try {
      await migrate(drizzle(client), { migrationsFolder: folder });
      await client.query(
        `INSERT INTO change_set (id, operation, connection, requester, args, status, stats, config_hash, correlation_id, created_at, expires_at)
         VALUES ($1, 'op', 'conn', 'alice', '{}'::jsonb, 'preparing', '{"total":1}'::jsonb, 'cfg', 'corr', now(), now() + interval '1 day')`,
        [id],
      );
      await client.query(
        `INSERT INTO change_item (changeset_id, target_id, status, before, after) VALUES ($1, 'a', 'pending', '{}'::jsonb, '{}'::jsonb)`,
        [id],
      );
      await client.query(`UPDATE change_set SET status = 'prepared', hash = 'h', prepared_at = now() WHERE id = $1`, [id]);
      await client.query(`UPDATE change_set SET status = 'executing' WHERE id = $1`, [id]);
    } finally {
      await client.end();
      rmSync(folder, { recursive: true, force: true });
    }
    const applied = await runMigrations(url);
    expect(applied.applied).toBeGreaterThanOrEqual(1);
    const after = new pg.Client({ connectionString: url });
    await after.connect();
    try {
      const cs = await after.query(
        'SELECT status, stats, verification_first_at, verification_until, verification_finished_at FROM change_set WHERE id = $1',
        [id],
      );
      expect(cs.rows).toEqual([
        {
          status: 'executing',
          stats: { total: 1 },
          verification_first_at: null,
          verification_until: null,
          verification_finished_at: null,
        },
      ]);
      const items = await after.query(
        'SELECT verification_status, verification_code, verification_round FROM change_item WHERE changeset_id = $1',
        [id],
      );
      expect(items.rows).toEqual([{ verification_status: null, verification_code: null, verification_round: 0 }]);
      // An item of a change-set that was executing during the upgrade can be verified.
      await after.query(
        `UPDATE change_item SET verification_status = 'pending' WHERE changeset_id = $1 AND target_id = 'a'`,
        [id],
      );
    } finally {
      await after.end();
    }
  });

  it('EXE-12 the verification columns are writable; item content and status rules still hold', async () => {
    const id = await executing();
    await database.db.execute(sql`
      UPDATE change_item SET verification_status = 'pending', verification_code = 'x', verification_round = 1
      WHERE changeset_id = ${id} AND target_id = 'a'`);
    await database.db.execute(sql`
      UPDATE change_item SET verification_status = 'unconfirmed', verification_code = 'verify_timeout'
      WHERE changeset_id = ${id} AND target_id = 'a'`);
    expect(
      await refusal(
        database.db.execute(
          sql`UPDATE change_item SET verification_status = 'maybe' WHERE changeset_id = ${id} AND target_id = 'a'`,
        ),
      ),
    ).toBe('change_item_verification_status_check');
    expect(
      await refusal(
        database.db.execute(sql`UPDATE change_item SET after = '{"v":3}'::jsonb WHERE changeset_id = ${id} AND target_id = 'a'`),
      ),
    ).toBe('change_item update rejected: item content is immutable');
    expect(
      await refusal(
        database.db.execute(sql`UPDATE change_item SET before = '{"v":0}'::jsonb WHERE changeset_id = ${id} AND target_id = 'a'`),
      ),
    ).toBe('change_item update rejected: item content is immutable');
    await database.db.execute(sql`UPDATE change_set SET status = 'completed' WHERE id = ${id}`);
    expect(
      await refusal(
        database.db.execute(sql`UPDATE change_item SET status = 'failed' WHERE changeset_id = ${id} AND target_id = 'a'`),
      ),
    ).toBe('change_item update rejected: change-set is not executing');
  });

  it('EXE-12 NFR-2 the verification schedule and its end are written once', async () => {
    const id = await executing();
    await database.db.execute(sql`
      UPDATE change_set SET verification_first_at = now(), verification_until = now() + interval '10 minutes' WHERE id = ${id}`);
    for (const column of ['verification_first_at', 'verification_until']) {
      expect(
        await refusal(
          database.db.execute(sql`UPDATE change_set SET ${sql.identifier(column)} = now() + interval '1 day' WHERE id = ${id}`),
        ),
      ).toBe('change_set update rejected: verification schedule is fixed');
      expect(
        await refusal(database.db.execute(sql`UPDATE change_set SET ${sql.identifier(column)} = NULL WHERE id = ${id}`)),
      ).toBe('change_set update rejected: verification schedule is fixed');
    }
    await database.db.execute(sql`UPDATE change_set SET verification_finished_at = now() WHERE id = ${id}`);
    expect(
      await refusal(
        database.db.execute(sql`UPDATE change_set SET verification_finished_at = now() + interval '1 day' WHERE id = ${id}`),
      ),
    ).toBe('change_set update rejected: verification schedule is fixed');
    // Unrelated updates still work, and an unchanged value is not a change.
    await database.db.execute(sql`UPDATE change_set SET stats = '{"total":2}'::jsonb, status = 'completed' WHERE id = ${id}`);
  });
});
