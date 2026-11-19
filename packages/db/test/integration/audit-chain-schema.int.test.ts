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
const APPEND_ONLY_UPDATE = /audit_event is append-only \(UPDATE rejected\)/;
const APPEND_ONLY_DELETE = /audit_event is append-only \(DELETE rejected\)/;
const APPEND_ONLY_TRUNCATE = /audit_event is append-only \(TRUNCATE rejected\)/;

const SEAL = 'aiops.audit_seal';
const RETENTION = 'aiops.audit_retention';

/** The minimal query surface shared by `pg.Client`, `pg.PoolClient` and `pg.Pool`. */
interface Queryable {
  query(text: string, params?: unknown[]): Promise<{ rows: Record<string, unknown>[] }>;
}

let postgres: StartedPostgres;

beforeAll(async () => {
  postgres = await startPostgres();
});

afterAll(async () => {
  await postgres.stop();
});

/** A fresh, fully migrated database and a pool on it; one per `describe`. */
function migratedDatabase(): { pool: () => pg.Pool } {
  let pool: pg.Pool | undefined;
  beforeAll(async () => {
    const url = await postgres.createDatabase();
    await runMigrations(url);
    pool = new pg.Pool({ connectionString: url });
  });
  afterAll(async () => {
    await pool?.end();
  });
  return {
    pool: () => {
      if (pool === undefined) throw new Error('database not started');
      return pool;
    },
  };
}

/** The number of committed migrations after journal index `idx`: an upgrade applies all of them. */
function migrationsAfter(idx: number): number {
  const journal = JSON.parse(readFileSync(join(MIGRATIONS, 'meta', '_journal.json'), 'utf8')) as {
    entries: { idx: number }[];
  };
  return journal.entries.filter((entry) => entry.idx > idx).length;
}

/** The committed migrations up to and including 0012, as the previous release shipped them. */
function migrationsBefore0013(): string {
  const dir = mkdtempSync(join(tmpdir(), 'aiops-mig-'));
  cpSync(MIGRATIONS, dir, { recursive: true });
  for (const file of readdirSync(dir)) {
    if (file.startsWith('0013_')) rmSync(join(dir, file));
  }
  const journalPath = join(dir, 'meta', '_journal.json');
  const journal = JSON.parse(readFileSync(journalPath, 'utf8')) as { entries: { idx: number }[] };
  journal.entries = journal.entries.filter((entry) => entry.idx <= 12);
  writeFileSync(journalPath, JSON.stringify(journal));
  return dir;
}

/** Inserts one unchained audit row and returns its `seq`. */
async function insertRow(client: Queryable, actor = 'alice-id'): Promise<string> {
  const result = await client.query(
    `INSERT INTO audit_event (id, actor, action, outcome, correlation_id, details)
     VALUES ($1, $2, 'tool.call', 'ok', 'corr-1', '{"durationMs":2}'::jsonb) RETURNING seq::text AS seq`,
    [randomUUID(), actor],
  );
  return String(result.rows[0]?.seq);
}

/** Runs `work` in one transaction with each of `settings` set transaction-locally to `on`; rolls back on error. */
async function inTransaction<T>(
  pool: pg.Pool,
  settings: readonly string[],
  work: (client: pg.PoolClient) => Promise<T>,
): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    for (const name of settings) await client.query("SELECT set_config($1, 'on', true)", [name]);
    const result = await work(client);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

function seal(client: Queryable, seq: string, pos: number, prev = `sha256:${'0'.repeat(64)}`, hash = `sha256:${'a'.repeat(64)}`) {
  return client.query('UPDATE audit_event SET chain_pos = $2, prev_hash = $3, hash = $4 WHERE seq = $1', [
    seq,
    pos,
    prev,
    hash,
  ]);
}

async function chainColumns(client: Queryable, seq: string): Promise<Record<string, unknown> | undefined> {
  const result = await client.query(
    'SELECT chain_pos::text AS chain_pos, prev_hash, hash, actor FROM audit_event WHERE seq = $1',
    [seq],
  );
  return result.rows[0];
}

describe('NFR-5 AUD-3 migration 0013 on an existing database', () => {
  it('NFR-5 AUD-3 migration 0013 applies on a database that already holds audit rows', async () => {
    const url = await postgres.createDatabase();
    const folder = migrationsBefore0013();
    const client = new pg.Client({ connectionString: url });
    await client.connect();
    try {
      await migrate(drizzle(client), { migrationsFolder: folder });
      await insertRow(client);
      await insertRow(client, 'bob-id');
    } finally {
      await client.end();
      rmSync(folder, { recursive: true, force: true });
    }

    expect(await runMigrations(url)).toEqual({ applied: migrationsAfter(12) });

    const after = new pg.Client({ connectionString: url });
    await after.connect();
    try {
      const rows = await after.query('SELECT actor, chain_pos, prev_hash, hash FROM audit_event ORDER BY seq');
      expect(rows.rows).toEqual([
        { actor: 'alice-id', chain_pos: null, prev_hash: null, hash: null },
        { actor: 'bob-id', chain_pos: null, prev_hash: null, hash: null },
      ]);
    } finally {
      await after.end();
    }
  });
});

describe('AUD-3 sanctioned seal path', () => {
  const db = migratedDatabase();

  it('AUD-3 an UPDATE without the seal setting is refused', async () => {
    const seq = await insertRow(db.pool());
    await expect(seal(db.pool(), seq, 1)).rejects.toThrow(APPEND_ONLY_UPDATE);
    await expect(inTransaction(db.pool(), [RETENTION], (c) => seal(c, seq, 1))).rejects.toThrow(APPEND_ONLY_UPDATE);
    expect(await chainColumns(db.pool(), seq)).toEqual({
      chain_pos: null,
      prev_hash: null,
      hash: null,
      actor: 'alice-id',
    });
  });

  it('AUD-3 the seal setting allows only filling the three chain columns of an unsealed row', async () => {
    const pool = db.pool();
    const seq = await insertRow(pool);

    await expect(
      inTransaction(pool, [SEAL], (c) =>
        c.query(
          "UPDATE audit_event SET chain_pos = 10, prev_hash = 'p', hash = 'h', actor = 'mallory' WHERE seq = $1",
          [seq],
        ),
      ),
    ).rejects.toThrow(APPEND_ONLY_UPDATE);
    await expect(
      inTransaction(pool, [SEAL], (c) => c.query("UPDATE audit_event SET hash = 'h' WHERE seq = $1", [seq])),
    ).rejects.toThrow(APPEND_ONLY_UPDATE);

    await inTransaction(pool, [SEAL], (c) => seal(c, seq, 10));
    expect(await chainColumns(pool, seq)).toEqual({
      chain_pos: '10',
      prev_hash: `sha256:${'0'.repeat(64)}`,
      hash: `sha256:${'a'.repeat(64)}`,
      actor: 'alice-id',
    });

    await expect(
      inTransaction(pool, [SEAL], (c) => seal(c, seq, 11, `sha256:${'1'.repeat(64)}`, `sha256:${'b'.repeat(64)}`)),
    ).rejects.toThrow(APPEND_ONLY_UPDATE);
    expect(await chainColumns(pool, seq)).toMatchObject({ chain_pos: '10', hash: `sha256:${'a'.repeat(64)}` });
  });
});

describe('AUD-3 AUD-7 sanctioned retention path', () => {
  const db = migratedDatabase();

  it('AUD-3 a DELETE is refused without the retention setting, for unsealed rows, and above the newest anchor', async () => {
    const pool = db.pool();
    const seqs = [await insertRow(pool), await insertRow(pool), await insertRow(pool)];
    const unsealed = await insertRow(pool);

    // No anchor yet: even a sealed row is refused.
    await inTransaction(pool, [SEAL], async (c) => {
      for (const [i, seq] of seqs.entries()) await seal(c, seq, i + 1);
    });
    await expect(
      inTransaction(pool, [RETENTION], (c) => c.query('DELETE FROM audit_event WHERE chain_pos = 1')),
    ).rejects.toThrow(APPEND_ONLY_DELETE);

    await pool.query(
      `INSERT INTO audit_anchor (chain_pos, hash, archive, sha256, count)
       VALUES (2, 'sha256:h2', 'audit-1-2.jsonl', 'sha256:file', 2)`,
    );

    await inTransaction(pool, [RETENTION], (c) => c.query('DELETE FROM audit_event WHERE chain_pos = 1'));
    await expect(
      inTransaction(pool, [RETENTION], (c) => c.query('DELETE FROM audit_event WHERE chain_pos = 3')),
    ).rejects.toThrow(APPEND_ONLY_DELETE);
    await expect(
      inTransaction(pool, [RETENTION], (c) => c.query('DELETE FROM audit_event WHERE seq = $1', [unsealed])),
    ).rejects.toThrow(APPEND_ONLY_DELETE);
    await expect(pool.query('DELETE FROM audit_event WHERE chain_pos = 2')).rejects.toThrow(APPEND_ONLY_DELETE);
    await expect(
      inTransaction(pool, [SEAL], (c) => c.query('DELETE FROM audit_event WHERE chain_pos = 2')),
    ).rejects.toThrow(APPEND_ONLY_DELETE);

    const left = await pool.query('SELECT chain_pos::text AS chain_pos FROM audit_event ORDER BY seq');
    expect(left.rows).toEqual([{ chain_pos: '2' }, { chain_pos: '3' }, { chain_pos: null }]);
  });

  it('AUD-3 TRUNCATE is refused even with both settings', async () => {
    const pool = db.pool();
    await insertRow(pool);
    await expect(
      inTransaction(pool, [SEAL, RETENTION], (c) => c.query('TRUNCATE audit_event')),
    ).rejects.toThrow(APPEND_ONLY_TRUNCATE);
    const count = await pool.query<{ n: number }>('SELECT count(*)::int AS n FROM audit_event');
    expect(Number(count.rows[0]?.n)).toBeGreaterThan(0);
  });

  it('AUD-7 audit_anchor rows cannot be updated, deleted or truncated', async () => {
    const pool = db.pool();
    await pool.query(
      `INSERT INTO audit_anchor (chain_pos, hash, archive, sha256, count)
       VALUES (100, 'sha256:h100', 'audit-3-100.jsonl', 'sha256:file', 98)`,
    );
    const settings = [SEAL, RETENTION];
    await expect(
      inTransaction(pool, settings, (c) => c.query("UPDATE audit_anchor SET hash = 'x' WHERE chain_pos = 100")),
    ).rejects.toThrow(/audit_anchor is append-only \(UPDATE rejected\)/);
    await expect(
      inTransaction(pool, settings, (c) => c.query('DELETE FROM audit_anchor WHERE chain_pos = 100')),
    ).rejects.toThrow(/audit_anchor is append-only \(DELETE rejected\)/);
    await expect(inTransaction(pool, settings, (c) => c.query('TRUNCATE audit_anchor'))).rejects.toThrow(
      /audit_anchor is append-only \(TRUNCATE rejected\)/,
    );
    const anchor = await pool.query('SELECT hash, created_at IS NOT NULL AS stamped FROM audit_anchor WHERE chain_pos = 100');
    expect(anchor.rows).toEqual([{ hash: 'sha256:h100', stamped: true }]);
  });
});

describe('AUD-3 chain position', () => {
  const db = migratedDatabase();

  it('AUD-3 chain_pos is unique', async () => {
    const pool = db.pool();
    const first = await insertRow(pool);
    const second = await insertRow(pool);
    await inTransaction(pool, [SEAL], (c) => seal(c, first, 1));
    await expect(inTransaction(pool, [SEAL], (c) => seal(c, second, 1))).rejects.toThrow(
      /audit_event_chain_pos_unique/,
    );
    expect(await chainColumns(pool, second)).toMatchObject({ chain_pos: null, hash: null });
  });
});
