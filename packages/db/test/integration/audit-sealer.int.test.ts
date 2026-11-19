import { randomUUID } from 'node:crypto';
import { auditRowHash, checkLink, GENESIS_HASH, type ChainHead } from '@aiops/core';
import type pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startPostgres, type StartedPostgres } from '@aiops/testing';
import { CHAIN_COLUMNS, sealAuditChain, toSealedChainRow } from '../../src/audit-chain.js';
import { DrizzleAuditLog } from '../../src/audit-log.js';
import { createDb, type Database } from '../../src/client.js';
import { AUDIT_SEAL_LOCK_KEY } from '../../src/locks.js';
import { runMigrations } from '../../src/migrate.js';

let postgres: StartedPostgres;

beforeAll(async () => {
  postgres = await startPostgres();
});

afterAll(async () => {
  await postgres.stop();
});

/** A fresh, fully migrated database; one per `describe`. */
function migratedDatabase(): () => Database {
  let database: Database | undefined;
  beforeAll(async () => {
    const url = await postgres.createDatabase();
    await runMigrations(url);
    database = createDb(url, { onError: () => undefined });
  });
  afterAll(async () => {
    await database?.close();
  });
  return () => {
    if (database === undefined) throw new Error('database not started');
    return database;
  };
}

/** Appends one audit row through the production log with autocommit. */
async function append(database: Database, actor = 'alice-id'): Promise<void> {
  await new DrizzleAuditLog(database.db).append({
    id: randomUUID(),
    actor,
    action: 'tool.call',
    subject: 'ping',
    outcome: 'ok',
    correlationId: 'corr-1',
    details: { durationMs: 2, nested: { b: [1, 'x'], a: true } },
  });
}

/** Every sealed row in chain order, read back through `CHAIN_COLUMNS`. */
async function sealedRows(pool: pg.Pool) {
  const result = await pool.query<Record<string, unknown>>(
    `SELECT ${CHAIN_COLUMNS} FROM audit_event WHERE chain_pos IS NOT NULL ORDER BY chain_pos`,
  );
  return result.rows.map(toSealedChainRow);
}

/** The first chain break walking from `from`, or undefined when every row links. */
function firstBreak(from: ChainHead, rows: Awaited<ReturnType<typeof sealedRows>>): string | undefined {
  let previous = from;
  for (const row of rows) {
    const broken = checkLink(previous, row);
    if (broken !== undefined) return `${broken} at ${row.pos}`;
    previous = { pos: row.pos, hash: row.hash ?? '' };
  }
  return undefined;
}

describe('AUD-3 audit sealer', () => {
  describe('from genesis', () => {
    const db = migratedDatabase();

    it('AUD-3 seals unsealed rows in seq order from genesis, linking each to the one before', async () => {
      for (const actor of ['a-id', 'b-id', 'c-id']) await append(db(), actor);

      expect(await sealAuditChain(db().pool)).toEqual({ sealed: 3, locked: true });

      const rows = await sealedRows(db().pool);
      expect(rows.map((row) => row.pos)).toEqual([1, 2, 3]);
      expect(rows.map((row) => row.actor)).toEqual(['a-id', 'b-id', 'c-id']);
      expect(rows[0]?.prevHash).toBe(GENESIS_HASH);
      let prev = GENESIS_HASH;
      for (const row of rows) {
        expect(row.prevHash).toBe(prev);
        expect(row.hash).toBe(auditRowHash(row, prev));
        prev = row.hash ?? '';
      }
      expect(Number(rows[0]?.seq)).toBeLessThan(Number(rows[2]?.seq));
    });
  });

  describe('batches', () => {
    const db = migratedDatabase();

    it('AUD-3 a second run continues from the head and seals at most batchSize rows', async () => {
      for (let i = 0; i < 5; i++) await append(db());

      const runs = [];
      for (let i = 0; i < 4; i++) runs.push(await sealAuditChain(db().pool, { batchSize: 2 }));

      expect(runs).toEqual([
        { sealed: 2, locked: true },
        { sealed: 2, locked: true },
        { sealed: 1, locked: true },
        { sealed: 0, locked: true },
      ]);
      const rows = await sealedRows(db().pool);
      expect(rows.map((row) => row.pos)).toEqual([1, 2, 3, 4, 5]);
      expect(firstBreak({ pos: 0, hash: GENESIS_HASH }, rows)).toBeUndefined();
    });
  });

  describe('late commit', () => {
    const db = migratedDatabase();

    it('AUD-3 a row whose transaction commits late gets a later position', async () => {
      const a = await db().pool.connect();
      try {
        await a.query('BEGIN');
        const x = await a.query<{ seq: string }>(
          `INSERT INTO audit_event (id, actor, action, outcome, correlation_id)
           VALUES ($1, 'x-id', 'tool.call', 'ok', 'corr-x') RETURNING seq::text AS seq`,
          [randomUUID()],
        );
        await append(db(), 'y-id');

        expect(await sealAuditChain(db().pool)).toEqual({ sealed: 1, locked: true });
        const afterFirst = await sealedRows(db().pool);
        expect(afterFirst.map((row) => [row.actor, row.pos])).toEqual([['y-id', 1]]);

        await a.query('COMMIT');
        expect(await sealAuditChain(db().pool)).toEqual({ sealed: 1, locked: true });

        const rows = await sealedRows(db().pool);
        expect(rows.map((row) => [row.actor, row.pos])).toEqual([
          ['y-id', 1],
          ['x-id', 2],
        ]);
        // X was inserted first (lower seq) but sealed later.
        expect(BigInt(rows[1]?.seq ?? '0')).toBe(BigInt(x.rows[0]?.seq ?? '-1'));
        expect(BigInt(rows[1]?.seq ?? '0')).toBeLessThan(BigInt(rows[0]?.seq ?? '0'));
        expect(firstBreak({ pos: 0, hash: GENESIS_HASH }, rows)).toBeUndefined();
      } finally {
        a.release();
      }
    });
  });

  describe('two sealers', () => {
    const db = migratedDatabase();

    it('NFR-4 AUD-3 two sealers never assign a position twice', async () => {
      let inserted = false;
      const inserters = Array.from({ length: 4 }, async (_, i) => {
        for (let n = 0; n < 50; n++) await append(db(), `inserter-${i}`);
      });
      const allInserted = Promise.all(inserters).then(() => {
        inserted = true;
      });
      let sealedTotal = 0;
      // A loop stops only once every inserter resolved and a round that held the lock sealed nothing (T5/F9).
      const sealer = async (): Promise<void> => {
        for (;;) {
          const done = inserted;
          const result = await sealAuditChain(db().pool, { batchSize: 7 });
          sealedTotal += result.sealed;
          if (done && result.locked && result.sealed === 0) return;
        }
      };

      await Promise.all([allInserted, sealer(), sealer()]);

      expect(sealedTotal).toBe(200);
      const rows = await sealedRows(db().pool);
      expect(rows.map((row) => row.pos)).toEqual(Array.from({ length: 200 }, (_, i) => i + 1));
      expect(firstBreak({ pos: 0, hash: GENESIS_HASH }, rows)).toBeUndefined();
      const unsealed = await db().pool.query('SELECT 1 FROM audit_event WHERE chain_pos IS NULL');
      expect(unsealed.rowCount).toBe(0);
    });
  });

  describe('held lock', () => {
    const db = migratedDatabase();

    it('AUD-3 a held seal lock skips the round', async () => {
      await append(db());
      const holder = await db().pool.connect();
      try {
        await holder.query('BEGIN');
        await holder.query('SELECT pg_advisory_xact_lock($1)', [AUDIT_SEAL_LOCK_KEY.toString()]);

        expect(await sealAuditChain(db().pool)).toEqual({ sealed: 0, locked: false });
        expect((await sealedRows(db().pool)).length).toBe(0);

        await holder.query('ROLLBACK');
      } finally {
        holder.release();
      }
      expect(await sealAuditChain(db().pool)).toEqual({ sealed: 1, locked: true });
    });
  });

  describe('anchor', () => {
    const db = migratedDatabase();

    it('AUD-3 the head after an anchor is the anchor', async () => {
      await append(db());
      await append(db());
      expect(await sealAuditChain(db().pool)).toEqual({ sealed: 2, locked: true });
      const [, second] = await sealedRows(db().pool);
      const anchorHash = second?.hash ?? '';
      expect(anchorHash).toMatch(/^sha256:[0-9a-f]{64}$/);

      const client = await db().pool.connect();
      try {
        await client.query('BEGIN');
        await client.query(
          `INSERT INTO audit_anchor (chain_pos, hash, archive, sha256, count)
           VALUES (2, $1, 'audit-1-2.jsonl', $2, 2)`,
          [anchorHash, `sha256:${'a'.repeat(64)}`],
        );
        await client.query("SELECT set_config('aiops.audit_retention', 'on', true)");
        const deleted = await client.query('DELETE FROM audit_event WHERE chain_pos <= 2');
        expect(deleted.rowCount).toBe(2);
        await client.query('COMMIT');
      } finally {
        client.release();
      }

      await append(db(), 'after-anchor');
      expect(await sealAuditChain(db().pool)).toEqual({ sealed: 1, locked: true });

      const rows = await sealedRows(db().pool);
      expect(rows.map((row) => [row.actor, row.pos, row.prevHash])).toEqual([['after-anchor', 3, anchorHash]]);
      expect(firstBreak({ pos: 2, hash: anchorHash }, rows)).toBeUndefined();
    });
  });
});
