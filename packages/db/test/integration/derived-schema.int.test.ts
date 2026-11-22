// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Mandate Authors
import { randomUUID } from 'node:crypto';
import { cpSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
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

const MIGRATIONS = fileURLToPath(new URL('../../migrations', import.meta.url));

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

async function insertChangeSet(
  db: Database['db'],
  status: string,
  derivedFrom: string | null = null,
): Promise<string> {
  const id = randomUUID();
  await db.execute(sql`
    INSERT INTO change_set (id, operation, connection, requester, args, hash, status, stats, config_hash, correlation_id, created_at, expires_at, derived_from)
    VALUES (${id}, 'op', 'conn', 'alice', '{}'::jsonb, 'h', ${status}, '{}'::jsonb, 'cfg', 'corr', now(), now() + interval '1 day', ${derivedFrom})`);
  return id;
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

/** The number of committed migrations after journal index `idx`: an upgrade applies all of them. */
function migrationsAfter(idx: number): number {
  const journal = JSON.parse(readFileSync(join(MIGRATIONS, 'meta', '_journal.json'), 'utf8')) as {
    entries: { idx: number }[];
  };
  return journal.entries.filter((entry) => entry.idx > idx).length;
}

/** The committed migrations up to and including 0010, as the previous release shipped them. */
function migrationsBefore0011(): string {
  const dir = mkdtempSync(join(tmpdir(), 'mandate-mig-'));
  cpSync(MIGRATIONS, dir, { recursive: true });
  for (const file of readdirSync(dir)) {
    if (file.startsWith('0011_')) rmSync(join(dir, file));
  }
  const journalPath = join(dir, 'meta', '_journal.json');
  const journal = JSON.parse(readFileSync(journalPath, 'utf8')) as { entries: { idx: number }[] };
  journal.entries = journal.entries.filter((entry) => entry.idx <= 10);
  writeFileSync(journalPath, JSON.stringify(journal));
  return dir;
}

describe('CS-5 derived change-set storage', () => {
  it('NFR-5 CS-5 migration 0011 applies on a database that already holds change-sets', async () => {
    const url = await postgres.createDatabase();
    const folder = migrationsBefore0011();
    const client = new pg.Client({ connectionString: url });
    await client.connect();
    const id = randomUUID();
    try {
      await migrate(drizzle(client), { migrationsFolder: folder });
      await client.query(
        `INSERT INTO change_set (id, operation, connection, requester, args, status, stats, config_hash, correlation_id, created_at, expires_at)
         VALUES ($1, 'op', 'conn', 'alice', '{}'::jsonb, 'preparing', '{}'::jsonb, 'cfg', 'corr', now(), now() + interval '1 day')`,
        [id],
      );
      await client.query(
        `INSERT INTO change_item (changeset_id, target_id, status, before, after)
         VALUES ($1, 't-0001', 'pending', '{"name":"a"}'::jsonb, '{"name":"b"}'::jsonb)`,
        [id],
      );
      await client.query(`UPDATE change_set SET status = 'prepared', hash = 'h', prepared_at = now() WHERE id = $1`, [
        id,
      ]);
    } finally {
      await client.end();
      rmSync(folder, { recursive: true, force: true });
    }

    expect(await runMigrations(url)).toEqual({ applied: migrationsAfter(10) });

    const after = new pg.Client({ connectionString: url });
    await after.connect();
    try {
      const row = await after.query('SELECT status, hash, derived_from FROM change_set WHERE id = $1', [id]);
      expect(row.rows).toEqual([{ status: 'prepared', hash: 'h', derived_from: null }]);
      const items = await after.query(
        'SELECT target_id, status, reason, before, after, error FROM change_item WHERE changeset_id = $1',
        [id],
      );
      expect(items.rows).toEqual([
        { target_id: 't-0001', status: 'pending', reason: null, before: { name: 'a' }, after: { name: 'b' }, error: null },
      ]);
    } finally {
      await after.end();
    }
  });

  it('CS-5 derived_from is stored on insert and refused on update', async () => {
    const source = await insertChangeSet(database.db, 'prepared');
    const derived = await insertChangeSet(database.db, 'prepared', source);
    const row = await database.db.execute(sql`SELECT derived_from FROM change_set WHERE id = ${derived}`);
    expect(row.rows).toEqual([{ derived_from: source }]);
    expect(
      await rejection(database.db.execute(sql`UPDATE change_set SET derived_from = NULL WHERE id = ${derived}`)),
    ).toBe('change_set update rejected: identity columns are immutable');
    // A row stored without a source cannot gain one later either.
    expect(
      await rejection(database.db.execute(sql`UPDATE change_set SET derived_from = ${derived} WHERE id = ${source}`)),
    ).toBe('change_set update rejected: identity columns are immutable');
  });

  it('CS-5 derived_from must name an existing change-set', async () => {
    expect(await rejection(insertChangeSet(database.db, 'prepared', randomUUID()))).toBe(
      'change_set_derived_from_change_set_id_fk',
    );
  });

  it('APR-1 the 0009 approval-column rule still holds after 0011', async () => {
    const id = await insertChangeSet(database.db, 'prepared');
    expect(await rejection(database.db.execute(sql`UPDATE change_set SET approval_round = 1 WHERE id = ${id}`))).toBe(
      'change_set update rejected: approval columns change only on submission',
    );
  });
});
