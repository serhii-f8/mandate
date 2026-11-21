// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The AI Operations Layer Authors
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
const HASH = 'a'.repeat(64);
const SUMMARY = { connections: 1, operations: 2, roles: 3, notifications: 0 };

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

/** The number of committed migrations after journal index `idx`: an upgrade applies all of them. */
function migrationsAfter(idx: number): number {
  const journal = JSON.parse(readFileSync(join(MIGRATIONS, 'meta', '_journal.json'), 'utf8')) as {
    entries: { idx: number }[];
  };
  return journal.entries.filter((entry) => entry.idx > idx).length;
}

/** The committed migrations up to and including 0013, as the previous release shipped them. */
function migrationsBefore0014(): string {
  const dir = mkdtempSync(join(tmpdir(), 'aiops-mig-'));
  cpSync(MIGRATIONS, dir, { recursive: true });
  for (const file of readdirSync(dir)) {
    if (file.startsWith('0014_')) rmSync(join(dir, file));
  }
  const journalPath = join(dir, 'meta', '_journal.json');
  const journal = JSON.parse(readFileSync(journalPath, 'utf8')) as { entries: { idx: number }[] };
  journal.entries = journal.entries.filter((entry) => entry.idx <= 13);
  writeFileSync(journalPath, JSON.stringify(journal));
  return dir;
}

interface RevisionValues {
  readonly id?: string;
  readonly hash?: string;
  readonly source?: string;
}

/** Inserts one revision and returns its generated `seq`. */
async function insertRevision(values: RevisionValues = {}): Promise<number> {
  const result = await pool.query<{ seq: string }>(
    `INSERT INTO config_revision (id, hash, files, source, actor, summary)
     VALUES ($1, $2, $3::jsonb, $4, 'cli:alice', $5::jsonb) RETURNING seq`,
    [
      values.id ?? randomUUID(),
      values.hash ?? HASH,
      JSON.stringify({ 'aiops.yaml': 'version: 1\n' }),
      values.source ?? 'apply',
      JSON.stringify(SUMMARY),
    ],
  );
  return Number(result.rows[0]?.seq);
}

/** The driver error of a rejected statement: its message, SQLSTATE and constraint name. */
async function rejection(promise: Promise<unknown>): Promise<{ message: string; code?: string; constraint?: string }> {
  try {
    await promise;
  } catch (error) {
    const { message, code, constraint } = error as pg.DatabaseError;
    return { message, ...(code === undefined ? {} : { code }), ...(constraint === undefined ? {} : { constraint }) };
  }
  throw new Error('expected the statement to be rejected');
}

describe('CFG-4 configuration revision storage', () => {
  it('NFR-5 CFG-4 migration 0014 applies on a database migrated to 0013 that holds data', async () => {
    const url = await postgres.createDatabase();
    const folder = migrationsBefore0014();
    const auditId = randomUUID();
    const client = new pg.Client({ connectionString: url });
    await client.connect();
    try {
      await migrate(drizzle(client), { migrationsFolder: folder });
      await client.query(
        `INSERT INTO audit_event (id, actor, action, outcome, correlation_id, details)
         VALUES ($1, 'alice-id', 'tool.call', 'ok', 'corr-1', '{"durationMs":2}'::jsonb)`,
        [auditId],
      );
    } finally {
      await client.end();
      rmSync(folder, { recursive: true, force: true });
    }

    expect(await runMigrations(url)).toEqual({ applied: migrationsAfter(13) });

    const after = new pg.Client({ connectionString: url });
    await after.connect();
    try {
      const table = await after.query(`SELECT to_regclass('public.config_revision')::text AS name`);
      expect(table.rows).toEqual([{ name: 'config_revision' }]);
      const rows = await after.query(
        'SELECT id, actor, action, outcome, correlation_id, details, chain_pos, hash FROM audit_event',
      );
      expect(rows.rows).toEqual([
        {
          id: auditId,
          actor: 'alice-id',
          action: 'tool.call',
          outcome: 'ok',
          correlation_id: 'corr-1',
          details: { durationMs: 2 },
          chain_pos: null,
          hash: null,
        },
      ]);
    } finally {
      await after.end();
    }
  });

  it('CFG-4 a revision is stored with a generated seq and applied_at', async () => {
    const id = randomUUID();
    const before = await pool.query('SELECT now() AS now');
    const first = await insertRevision({ id, source: 'bootstrap' });
    const second = await insertRevision();
    expect(second).toBeGreaterThan(first);

    const row = await pool.query(
      'SELECT seq, id, hash, files, source, actor, applied_at, summary FROM config_revision WHERE seq = $1',
      [first],
    );
    const stored = row.rows[0] as Record<string, unknown>;
    expect(stored).toMatchObject({
      id,
      hash: HASH,
      files: { 'aiops.yaml': 'version: 1\n' },
      source: 'bootstrap',
      actor: 'cli:alice',
      summary: SUMMARY,
    });
    expect(stored.applied_at).toBeInstanceOf(Date);
    expect((stored.applied_at as Date).getTime()).toBeGreaterThanOrEqual(
      (before.rows[0] as { now: Date }).now.getTime(),
    );
    // A value for seq is refused: it is GENERATED ALWAYS.
    expect(
      (
        await rejection(
          pool.query(
            `INSERT INTO config_revision (seq, id, hash, files, source, actor, summary)
             VALUES (999999, $1, $2, '{}'::jsonb, 'apply', 'cli', '{}'::jsonb)`,
            [randomUUID(), HASH],
          ),
        )
      ).code,
    ).toBe('428C9');
    // The id is unique.
    expect((await rejection(insertRevision({ id }))).constraint).toBe('config_revision_id_unique');
  });

  it('CFG-4 config_revision is append-only', async () => {
    const seq = await insertRevision();
    for (const [op, statement] of [
      ['UPDATE', `UPDATE config_revision SET actor = 'mallory' WHERE seq = ${seq}`],
      ['DELETE', `DELETE FROM config_revision WHERE seq = ${seq}`],
      ['TRUNCATE', 'TRUNCATE config_revision'],
    ] as const) {
      const error = await rejection(pool.query(statement));
      expect(error.message).toBe(`config_revision is append-only (${op} rejected)`);
      expect(error.code).toBe('42501');
    }
    const row = await pool.query('SELECT actor FROM config_revision WHERE seq = $1', [seq]);
    expect(row.rows).toEqual([{ actor: 'cli:alice' }]);
  });

  it('CFG-4 source and hash are checked', async () => {
    expect((await rejection(insertRevision({ source: 'manual' }))).constraint).toBe('config_revision_source_check');
    expect((await rejection(insertRevision({ hash: `sha256:${HASH}` }))).constraint).toBe(
      'config_revision_hash_check',
    );
    expect((await rejection(insertRevision({ hash: 'A'.repeat(64) }))).constraint).toBe('config_revision_hash_check');
    expect((await rejection(insertRevision({ hash: 'a'.repeat(63) }))).constraint).toBe('config_revision_hash_check');
  });
});
