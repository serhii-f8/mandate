import { randomUUID } from 'node:crypto';
import { cpSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { drizzle } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startPostgres, type StartedPostgres } from '@aiops/testing';
import { runMigrations } from '../../src/migrate.js';

const MIGRATIONS = fileURLToPath(new URL('../../migrations', import.meta.url));

/** The minimal query surface shared by `pg.Client` and `pg.Pool`. */
interface Queryable {
  query(text: string, params?: unknown[]): Promise<{ rows: Record<string, unknown>[] }>;
}

let postgres: StartedPostgres;
let pool: pg.Pool;

beforeAll(async () => {
  postgres = await startPostgres();
  const url = await postgres.createDatabase();
  await runMigrations(url);
  pool = new pg.Pool({ connectionString: url });
});

afterAll(async () => {
  await pool.end();
  await postgres.stop();
});

const WRITTEN = 't-0001';
const ALREADY_APPLIED = 't-0002';

/**
 * A change-set that went through preparation and ended in `status`. With `executed`, it ran:
 * execution columns set, one item written by this run and one written with `already_applied`.
 */
async function executed(
  client: Queryable,
  { status, executed: ran }: { status: string; executed: boolean },
): Promise<string> {
  const id = randomUUID();
  await client.query(
    `INSERT INTO change_set (id, operation, connection, requester, args, status, stats, config_hash, correlation_id, created_at, expires_at)
     VALUES ($1, 'op', 'conn', 'alice', '{}'::jsonb, 'preparing', '{}'::jsonb, 'cfg', 'corr', now(), now() + interval '1 day')`,
    [id],
  );
  for (const target of [WRITTEN, ALREADY_APPLIED]) {
    await client.query(
      `INSERT INTO change_item (changeset_id, target_id, status, before, after)
       VALUES ($1, $2, 'pending', '{"name":"a"}'::jsonb, '{"name":"b"}'::jsonb)`,
      [id, target],
    );
  }
  await client.query(`UPDATE change_set SET status = 'prepared', hash = 'h', prepared_at = now() WHERE id = $1`, [id]);
  if (ran) {
    await client.query(
      `UPDATE change_set SET status = 'executing', execution_actor = 'alice', execution_groups = '["g"]'::jsonb,
         execution_correlation_id = 'x1', execution_started_at = now() WHERE id = $1`,
      [id],
    );
    await client.query(`UPDATE change_item SET status = 'written' WHERE changeset_id = $1 AND target_id = $2`, [
      id,
      WRITTEN,
    ]);
    await client.query(
      `UPDATE change_item SET status = 'written', error = 'already_applied' WHERE changeset_id = $1 AND target_id = $2`,
      [id, ALREADY_APPLIED],
    );
  }
  await client.query(`UPDATE change_set SET status = $2 WHERE id = $1`, [id, status]);
  return id;
}

/** The trigger message, or the name of the violated constraint. */
async function rejection(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
  } catch (error) {
    const failure = error as { message: string; constraint?: string };
    return failure.constraint ?? failure.message;
  }
  throw new Error('expected the statement to be rejected');
}

const REQUEST = `rollback_requested_at = now(), rollback_actor = 'alice', rollback_correlation_id = 'r1', rollback_client_id = 'c1'`;

function toRollingBack(id: string): Promise<unknown> {
  return pool.query(`UPDATE change_set SET status = 'rolling_back', ${REQUEST} WHERE id = $1`, [id]);
}

function setStatus(id: string, status: string): Promise<unknown> {
  return pool.query(`UPDATE change_set SET status = $2 WHERE id = $1`, [id, status]);
}

function setItemRollback(id: string, target: string, value: string): Promise<unknown> {
  return pool.query(`UPDATE change_item SET rollback_status = $3 WHERE changeset_id = $1 AND target_id = $2`, [
    id,
    target,
    value,
  ]);
}

/** The number of committed migrations after journal index `idx`: an upgrade applies all of them. */
function migrationsAfter(idx: number): number {
  const journal = JSON.parse(readFileSync(join(MIGRATIONS, 'meta', '_journal.json'), 'utf8')) as {
    entries: { idx: number }[];
  };
  return journal.entries.filter((entry) => entry.idx > idx).length;
}

/** The committed migrations up to and including 0011, as the previous release shipped them. */
function migrationsBefore0012(): string {
  const dir = mkdtempSync(join(tmpdir(), 'aiops-mig-'));
  cpSync(MIGRATIONS, dir, { recursive: true });
  for (const file of readdirSync(dir)) {
    if (file.startsWith('0012_')) rmSync(join(dir, file));
  }
  const journalPath = join(dir, 'meta', '_journal.json');
  const journal = JSON.parse(readFileSync(journalPath, 'utf8')) as { entries: { idx: number }[] };
  journal.entries = journal.entries.filter((entry) => entry.idx <= 11);
  writeFileSync(journalPath, JSON.stringify(journal));
  return dir;
}

describe('EXE-8 rollback storage', () => {
  it('NFR-5 EXE-8 migration 0012 applies on a database that already holds executed change-sets', async () => {
    const url = await postgres.createDatabase();
    const folder = migrationsBefore0012();
    const client = new pg.Client({ connectionString: url });
    await client.connect();
    let id: string;
    const outboxId = randomUUID();
    try {
      await migrate(drizzle(client), { migrationsFolder: folder });
      id = await executed(client, { status: 'completed', executed: true });
      await client.query(
        `INSERT INTO notification_outbox (id, kind, changeset_id, round, step, target, next_attempt_at, created_at)
         VALUES ($1, 'execution_finished', $2, 0, 0, 'chat', now(), now())`,
        [outboxId, id],
      );
    } finally {
      await client.end();
      rmSync(folder, { recursive: true, force: true });
    }

    expect(await runMigrations(url)).toEqual({ applied: migrationsAfter(11) });

    const after = new pg.Client({ connectionString: url });
    await after.connect();
    try {
      const row = await after.query(
        `SELECT status, rollback_until, rollback_requested_at, rollback_actor, rollback_correlation_id, rollback_client_id
         FROM change_set WHERE id = $1`,
        [id],
      );
      expect(row.rows).toEqual([
        {
          status: 'completed',
          rollback_until: null,
          rollback_requested_at: null,
          rollback_actor: null,
          rollback_correlation_id: null,
          rollback_client_id: null,
        },
      ]);
      const items = await after.query(
        'SELECT target_id, status, error, rollback_status, rollback_error FROM change_item WHERE changeset_id = $1 ORDER BY target_id',
        [id],
      );
      expect(items.rows).toEqual([
        { target_id: WRITTEN, status: 'written', error: null, rollback_status: null, rollback_error: null },
        { target_id: ALREADY_APPLIED, status: 'written', error: 'already_applied', rollback_status: null, rollback_error: null },
      ]);
      const outbox = await after.query('SELECT kind, changeset_id, state FROM notification_outbox WHERE id = $1', [
        outboxId,
      ]);
      expect(outbox.rows).toEqual([{ kind: 'execution_finished', changeset_id: id, state: 'pending' }]);
    } finally {
      await after.end();
    }
  });

  it('EXE-8 a finished change-set moves to rolling_back only with the request columns, once', async () => {
    const id = await executed(pool, { status: 'completed', executed: true });
    expect(await rejection(setStatus(id, 'rolling_back'))).toBe(
      'change_set update rejected: a finished change-set moves only to a requested rollback',
    );
    await toRollingBack(id);
    expect(await rejection(setStatus(id, 'completed'))).toBe(
      'change_set update rejected: a rollback ends only rolled back or failed',
    );
    await setStatus(id, 'failed');
    expect(await rejection(setStatus(id, 'rolling_back'))).toBe(
      'change_set update rejected: a finished change-set moves only to a requested rollback',
    );
    // Writing the request again is refused by the request rule, before the status rule.
    expect(await rejection(toRollingBack(id))).toBe('change_set update rejected: rollback request is fixed');
  });

  it('EXE-8 a cancelled or failed change-set rolls back only when execution started', async () => {
    const neverRan = await executed(pool, { status: 'cancelled', executed: false });
    expect(await rejection(toRollingBack(neverRan))).toBe(
      'change_set update rejected: a finished change-set moves only to a requested rollback',
    );
    const failedNeverRan = await executed(pool, { status: 'failed', executed: false });
    expect(await rejection(toRollingBack(failedNeverRan))).toBe(
      'change_set update rejected: a finished change-set moves only to a requested rollback',
    );
    const ran = await executed(pool, { status: 'cancelled', executed: true });
    await toRollingBack(ran);
    const failedRan = await executed(pool, { status: 'failed', executed: true });
    await toRollingBack(failedRan);
    const rows = await pool.query(`SELECT status FROM change_set WHERE id = ANY($1::uuid[])`, [[ran, failedRan]]);
    expect(rows.rows).toEqual([{ status: 'rolling_back' }, { status: 'rolling_back' }]);
  });

  it('EXE-8 rolled_back is final and the request columns are fixed', async () => {
    const id = await executed(pool, { status: 'completed', executed: true });
    await toRollingBack(id);
    expect(await rejection(pool.query(`UPDATE change_set SET rollback_actor = 'eve' WHERE id = $1`, [id]))).toBe(
      'change_set update rejected: rollback request is fixed',
    );
    await setStatus(id, 'rolled_back');
    expect(await rejection(setStatus(id, 'failed'))).toBe(
      'change_set update rejected: a finished change-set moves only to a requested rollback',
    );
    // A stats recompute on a finished row stays allowed.
    await pool.query(`UPDATE change_set SET stats = '{"written":1}'::jsonb, updated_at = now() WHERE id = $1`, [id]);
  });

  it('EXE-8 rollback_until is written once', async () => {
    const id = await executed(pool, { status: 'completed', executed: true });
    await pool.query(`UPDATE change_set SET rollback_until = now() + interval '1 day' WHERE id = $1`, [id]);
    expect(
      await rejection(pool.query(`UPDATE change_set SET rollback_until = now() + interval '2 days' WHERE id = $1`, [id])),
    ).toBe('change_set update rejected: rollback window is fixed');
    expect(await rejection(pool.query(`UPDATE change_set SET rollback_until = NULL WHERE id = $1`, [id]))).toBe(
      'change_set update rejected: rollback window is fixed',
    );
  });

  it('EXE-8 an item rollback outcome is written once, only for an item this run wrote, only while rolling back', async () => {
    const id = await executed(pool, { status: 'completed', executed: true });
    expect(await rejection(setItemRollback(id, WRITTEN, 'restored'))).toBe(
      'change_item update rejected: change-set is not rolling back',
    );
    await toRollingBack(id);
    await setItemRollback(id, WRITTEN, 'restored');
    expect(await rejection(setItemRollback(id, WRITTEN, 'failed'))).toBe(
      'change_item update rejected: rollback outcome is fixed',
    );
    expect(
      await rejection(
        pool.query(`UPDATE change_item SET rollback_error = 'drift' WHERE changeset_id = $1 AND target_id = $2`, [
          id,
          WRITTEN,
        ]),
      ),
    ).toBe('change_item update rejected: rollback outcome is fixed');
    expect(await rejection(setItemRollback(id, ALREADY_APPLIED, 'restored'))).toBe(
      'change_item update rejected: only items this run wrote roll back',
    );

    const other = await executed(pool, { status: 'completed', executed: true });
    await toRollingBack(other);
    expect(await rejection(setItemRollback(other, WRITTEN, 'gone'))).toBe('change_item_rollback_status_check');
    // An outcome with its error in one statement is accepted.
    await pool.query(
      `UPDATE change_item SET rollback_status = 'skipped', rollback_error = 'drift' WHERE changeset_id = $1 AND target_id = $2`,
      [other, WRITTEN],
    );
    const rows = await pool.query(
      `SELECT target_id, rollback_status, rollback_error FROM change_item WHERE changeset_id = $1 ORDER BY target_id`,
      [other],
    );
    expect(rows.rows).toEqual([
      { target_id: WRITTEN, rollback_status: 'skipped', rollback_error: 'drift' },
      { target_id: ALREADY_APPLIED, rollback_status: null, rollback_error: null },
    ]);
  });

  it('CS-4 the 0004 item rules still hold after 0012', async () => {
    const id = await executed(pool, { status: 'completed', executed: true });
    expect(
      await rejection(
        pool.query(`UPDATE change_item SET before = '{"name":"z"}'::jsonb WHERE changeset_id = $1 AND target_id = $2`, [
          id,
          WRITTEN,
        ]),
      ),
    ).toBe('change_item update rejected: item content is immutable');
    expect(
      await rejection(
        pool.query(`UPDATE change_item SET status = 'failed' WHERE changeset_id = $1 AND target_id = $2`, [id, WRITTEN]),
      ),
    ).toBe('change_item update rejected: change-set is not executing');
  });

  it('EXE-3 a done rollback batch is frozen and rollback batches are never deleted', async () => {
    const id = await executed(pool, { status: 'completed', executed: true });
    await toRollingBack(id);
    await pool.query(
      `INSERT INTO change_rollback_batch (changeset_id, batch_no, attempt, state, target_ids, last_target)
       VALUES ($1, 0, 1, 'open', '["t-0001"]'::jsonb, 't-0001')`,
      [id],
    );
    await pool.query(
      `UPDATE change_rollback_batch SET state = 'done', written = 1 WHERE changeset_id = $1 AND batch_no = 0`,
      [id],
    );
    expect(
      await rejection(
        pool.query(`UPDATE change_rollback_batch SET written = 2 WHERE changeset_id = $1 AND batch_no = 0`, [id]),
      ),
    ).toBe('change_batch update rejected: batch is done');
    expect(await rejection(pool.query(`DELETE FROM change_rollback_batch WHERE changeset_id = $1`, [id]))).toBe(
      'DELETE rejected: change-sets and their items are never deleted',
    );
    expect(await rejection(pool.query('TRUNCATE change_rollback_batch'))).toBe(
      'TRUNCATE rejected: change-sets and their items are never deleted',
    );
    expect(
      await rejection(
        pool.query(
          `INSERT INTO change_rollback_batch (changeset_id, batch_no, attempt, state, target_ids, last_target)
           VALUES ($1, 1, 1, 'closed', '[]'::jsonb, 'x')`,
          [id],
        ),
      ),
    ).toBe('change_rollback_batch_state_check');
    const collation = await pool.query(
      `SELECT collation_name FROM information_schema.columns WHERE table_name = 'change_rollback_batch' AND column_name = 'last_target'`,
    );
    expect(collation.rows).toEqual([{ collation_name: 'C' }]);
  });

  it('NTF-1 the outbox accepts rollback_result', async () => {
    const id = await executed(pool, { status: 'completed', executed: true });
    await pool.query(
      `INSERT INTO notification_outbox (id, kind, changeset_id, round, step, target, next_attempt_at, created_at)
       VALUES ($1, 'rollback_result', $2, 0, 0, 'chat', now(), now())`,
      [randomUUID(), id],
    );
    expect(
      await rejection(
        pool.query(
          `INSERT INTO notification_outbox (id, kind, changeset_id, round, step, target, next_attempt_at, created_at)
           VALUES ($1, 'other', $2, 0, 0, 'chat', now(), now())`,
          [randomUUID(), id],
        ),
      ),
    ).toBe('notification_outbox_kind_check');
  });

  it('APR-1 CS-5 the 0011 rules still hold after 0012', async () => {
    const source = await executed(pool, { status: 'completed', executed: true });
    expect(await rejection(pool.query(`UPDATE change_set SET derived_from = $2 WHERE id = $1`, [source, source]))).toBe(
      'change_set update rejected: identity columns are immutable',
    );
    expect(await rejection(pool.query(`UPDATE change_set SET approval_round = 1 WHERE id = $1`, [source]))).toBe(
      'change_set update rejected: approval columns change only on submission',
    );
  });
});
