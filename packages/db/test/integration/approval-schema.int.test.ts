// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Mandate Authors
import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startPostgres, type StartedPostgres } from '@mandate/testing';
import { PostgresChangeSetRepository } from '../../src/changeset-repository.js';
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

async function insertChangeSet(status: string): Promise<string> {
  const id = randomUUID();
  await database.db.execute(sql`
    INSERT INTO change_set (id, operation, connection, requester, args, hash, status, stats, config_hash, correlation_id, created_at, expires_at)
    VALUES (${id}, 'op', 'conn', 'alice', '{}'::jsonb, 'h', ${status}, '{}'::jsonb, 'cfg', 'corr', now(), now() + interval '1 day')`);
  return id;
}

function insertApproval(
  changesetId: string,
  over: { decision?: string; channel?: string; comment?: string | null; step?: number } = {},
): Promise<unknown> {
  return database.db.execute(sql`
    INSERT INTO approval (id, changeset_id, round, step, role, approver, decision, comment, hash, item_count, channel, correlation_id, ts)
    VALUES (${randomUUID()}, ${changesetId}, 1, ${over.step ?? 1}, 'lead', 'bob', ${over.decision ?? 'approved'},
      ${over.comment ?? null}, 'h', 2, ${over.channel ?? 'page'}, 'corr', now())`);
}

async function rejection(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
  } catch (error) {
    // Drizzle wraps the driver error; the trigger message sits on the cause.
    const cause = (error as { cause?: { message?: string; constraint?: string } }).cause;
    return cause?.constraint ?? cause?.message ?? (error as Error).message;
  }
  throw new Error('expected the statement to be rejected');
}

const APPROVAL_COLUMNS = 'change_set update rejected: approval columns change only on submission';
const AWAITING_ROLE = 'change_set update rejected: awaiting_role changes only while awaiting approval';

describe('AUD-3 APR-1 approval storage guards', () => {
  it('AUD-3 approval rows are append-only: UPDATE, DELETE and TRUNCATE are rejected', async () => {
    const id = await insertChangeSet('pending_approval');
    await insertApproval(id);
    for (const statement of [
      sql`UPDATE approval SET comment = 'x' WHERE changeset_id = ${id}`,
      sql`DELETE FROM approval WHERE changeset_id = ${id}`,
      sql`TRUNCATE approval`,
    ]) {
      expect(await rejection(database.db.execute(statement))).toBe('approval rows are append-only');
    }
    const rows = await database.db.execute(sql`SELECT count(*)::int AS n FROM approval WHERE changeset_id = ${id}`);
    expect(rows.rows[0]).toEqual({ n: 1 });
  });

  it('APR-1 the unique key (changeset_id, round, step) refuses a second decision of a step', async () => {
    const id = await insertChangeSet('pending_approval');
    await insertApproval(id);
    expect(await rejection(insertApproval(id))).toBe('approval_changeset_round_step_key');
  });

  it('APR-1 the decision, channel and comment length checks hold', async () => {
    const id = await insertChangeSet('pending_approval');
    expect(await rejection(insertApproval(id, { decision: 'maybe' }))).toBe('approval_decision_check');
    expect(await rejection(insertApproval(id, { channel: 'email' }))).toBe('approval_channel_check');
    expect(await rejection(insertApproval(id, { decision: 'returned', comment: 'x'.repeat(2001) }))).toBe(
      'approval_comment_length_check',
    );
    await insertApproval(id, { decision: 'returned', comment: 'x'.repeat(2000) });
  });

  it('CS-4 approval_plan, submission and approval_round change only with a status change out of prepared', async () => {
    const id = await insertChangeSet('pending_approval');
    expect(await rejection(database.db.execute(sql`UPDATE change_set SET approval_round = 5 WHERE id = ${id}`))).toBe(
      APPROVAL_COLUMNS,
    );
    expect(
      await rejection(
        database.db.execute(sql`UPDATE change_set SET approval_plan = '{}'::jsonb, status = 'approved' WHERE id = ${id}`),
      ),
    ).toBe(APPROVAL_COLUMNS);
    const prepared = await insertChangeSet('prepared');
    expect(
      await rejection(database.db.execute(sql`UPDATE change_set SET submission = '{}'::jsonb WHERE id = ${prepared}`)),
    ).toBe(APPROVAL_COLUMNS);
    // The submission itself: prepared to pending_approval with all three columns.
    await database.db.execute(sql`
      UPDATE change_set SET status = 'pending_approval', approval_round = approval_round + 1,
        submission = '{}'::jsonb, approval_plan = '{}'::jsonb, awaiting_role = 'lead' WHERE id = ${prepared}`);
  });

  it('CS-4 awaiting_role changes only while prepared or pending_approval', async () => {
    const id = await insertChangeSet('executing');
    expect(await rejection(database.db.execute(sql`UPDATE change_set SET awaiting_role = 'lead' WHERE id = ${id}`))).toBe(
      AWAITING_ROLE,
    );
    const pending = await insertChangeSet('pending_approval');
    await database.db.execute(sql`UPDATE change_set SET awaiting_role = 'brand' WHERE id = ${pending}`);
    await database.db.execute(sql`UPDATE change_set SET awaiting_role = NULL, status = 'approved' WHERE id = ${pending}`);
  });

  it('CS-4 the 0006 guards still hold: the hash is fixed once prepared', async () => {
    const id = await insertChangeSet('pending_approval');
    expect(await rejection(database.db.execute(sql`UPDATE change_set SET hash = 'other' WHERE id = ${id}`))).toBe(
      'change_set update rejected: hash is fixed once prepared',
    );
  });
});

describe('CS-4 hash version and action columns', () => {
  const HASH_FIXED = 'change_set update rejected: hash is fixed once prepared';

  it('CS-4 hash_version and action are fixed once the change-set left preparing', async () => {
    for (const status of ['prepared', 'pending_approval', 'executing', 'failed']) {
      const id = await insertChangeSet(status);
      expect(await rejection(database.db.execute(sql`UPDATE change_set SET hash_version = 2 WHERE id = ${id}`))).toBe(
        HASH_FIXED,
      );
      expect(await rejection(database.db.execute(sql`UPDATE change_set SET action = 'update' WHERE id = ${id}`))).toBe(
        HASH_FIXED,
      );
    }
  });

  it('CS-4 hash_version and action are written together with the hash while preparing', async () => {
    const id = await insertChangeSet('preparing');
    await database.db.execute(
      sql`UPDATE change_set SET hash = 'h2', hash_version = 2, action = 'create', status = 'prepared', prepared_at = now() WHERE id = ${id}`,
    );
    const rows = await database.db.execute(sql`SELECT hash_version, action FROM change_set WHERE id = ${id}`);
    expect(rows.rows[0]).toEqual({ hash_version: 2, action: 'create' });
  });

  it('CS-4 a row inserted without the columns, as an old process does, reads version 1 and no action', async () => {
    const id = await insertChangeSet('prepared');
    const rows = await database.db.execute(sql`SELECT hash_version, action FROM change_set WHERE id = ${id}`);
    expect(rows.rows[0]).toEqual({ hash_version: 1, action: null });
    const record = await new PostgresChangeSetRepository(database.db).get(id);
    expect(record?.hashVersion).toBe(1);
    expect(record !== undefined && 'action' in record).toBe(false);
  });

  it('CS-4 the checks refuse a hash version below 1 and an unknown action', async () => {
    const id = await insertChangeSet('preparing');
    expect(await rejection(database.db.execute(sql`UPDATE change_set SET hash_version = 0 WHERE id = ${id}`))).toBe(
      'change_set_hash_version_check',
    );
    expect(await rejection(database.db.execute(sql`UPDATE change_set SET action = 'upsert' WHERE id = ${id}`))).toBe(
      'change_set_action_check',
    );
  });
});
