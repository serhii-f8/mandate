// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Mandate Authors
import { auditRowHash, GENESIS_HASH } from '@mandate/core';
import type pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startPostgres, type StartedPostgres } from '@mandate/testing';
import { CHAIN_COLUMNS, sealAuditChain, toSealedChainRow } from '../../src/audit-chain.js';
import { formatVerifyReport, verifyAuditChain } from '../../src/audit-verify.js';
import { createDb, type Database } from '../../src/client.js';
import { runMigrations } from '../../src/migrate.js';

let postgres: StartedPostgres;

beforeAll(async () => {
  postgres = await startPostgres();
});

afterAll(async () => {
  await postgres.stop();
});

/** A fresh, fully migrated database for each test. */
async function freshDatabase(): Promise<Database> {
  const url = await postgres.createDatabase();
  await runMigrations(url);
  return createDb(url, { onError: () => undefined });
}

/** Inserts `count` unsealed audit rows in one statement; row n has actor `actor-<n>`. */
async function insertRows(pool: pg.Pool, count: number, start = 1): Promise<void> {
  await pool.query(
    `INSERT INTO audit_event (id, actor, action, subject, outcome, correlation_id, details)
     SELECT gen_random_uuid(), 'actor-' || n, 'tool.call', 'ping', 'ok', 'corr-' || n,
            jsonb_build_object('durationMs', n, 'note', 'detail-' || n)
     FROM generate_series($1::int, $2::int) AS n`,
    [start, start + count - 1],
  );
}

/** Seals every unsealed row. */
async function sealAll(pool: pg.Pool): Promise<void> {
  for (;;) {
    const result = await sealAuditChain(pool);
    if (result.sealed === 0) return;
  }
}

/** Runs `work` with triggers disabled, as a superuser tampering with the table would. */
async function tamper(pool: pg.Pool, work: (client: pg.PoolClient) => Promise<void>): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('SET LOCAL session_replication_role = replica');
    await work(client);
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

async function storedHash(pool: pg.Pool, pos: number): Promise<string> {
  const result = await pool.query<{ hash: string }>('SELECT hash FROM audit_event WHERE chain_pos = $1', [pos]);
  const hash = result.rows[0]?.hash;
  if (hash === undefined) throw new Error(`no row at ${pos}`);
  return hash;
}

describe('AUD-5 audit chain verification', () => {
  let database: Database | undefined;

  afterAll(async () => {
    await database?.close();
  });

  async function fresh(): Promise<pg.Pool> {
    await database?.close();
    database = await freshDatabase();
    return database.pool;
  }

  it('AUD-5 an intact chain is ok with counts, start and head', async () => {
    const pool = await fresh();
    await insertRows(pool, 2500);
    await sealAll(pool);
    await insertRows(pool, 3, 2501);
    const hash = await storedHash(pool, 2500);

    const report = await verifyAuditChain(pool);

    expect(report).toEqual({ ok: true, sealed: 2500, unsealed: 3, from: 1, head: { pos: 2500, hash } });
    expect(formatVerifyReport(report)).toBe(`ok sealed=2500 unsealed=3 from=1 head=2500:${hash}`);
  });

  it('AUD-5 an altered column fails with hash_mismatch at that position', async () => {
    const pool = await fresh();
    await insertRows(pool, 2500);
    await sealAll(pool);
    await tamper(pool, async (c) => {
      await c.query("UPDATE audit_event SET actor = 'mallory-id' WHERE chain_pos = 1700");
    });

    const report = await verifyAuditChain(pool);

    expect(report).toEqual({ ok: false, chainPos: 1700, reason: 'hash_mismatch' });
    expect(formatVerifyReport(report)).toBe('failed chain_pos=1700 reason=hash_mismatch');
  });

  it('AUD-5 a removed row fails with gap at the next position', async () => {
    const pool = await fresh();
    await insertRows(pool, 60);
    await sealAll(pool);
    await tamper(pool, async (c) => {
      await c.query('DELETE FROM audit_event WHERE chain_pos = 40');
    });

    expect(formatVerifyReport(await verifyAuditChain(pool))).toBe('failed chain_pos=41 reason=gap');
  });

  it('AUD-5 swapped rows fail', async () => {
    const pool = await fresh();
    await insertRows(pool, 20);
    await sealAll(pool);
    await tamper(pool, async (c) => {
      await c.query('UPDATE audit_event SET chain_pos = -1 WHERE chain_pos = 10');
      await c.query('UPDATE audit_event SET chain_pos = 10 WHERE chain_pos = 11');
      await c.query('UPDATE audit_event SET chain_pos = 11 WHERE chain_pos = -1');
    });

    // Position 10 now holds the former row 11, whose prev_hash is H10, not H9 (ruling T7/F10).
    expect(formatVerifyReport(await verifyAuditChain(pool))).toBe('failed chain_pos=10 reason=prev_mismatch');
  });

  it('AUD-5 a forged hash on the altered row still fails at the next row', async () => {
    const pool = await fresh();
    await insertRows(pool, 10);
    await sealAll(pool);
    await tamper(pool, async (c) => {
      await c.query("UPDATE audit_event SET actor = 'mallory-id' WHERE chain_pos = 5");
      const selected = await c.query<Record<string, unknown>>(
        `SELECT ${CHAIN_COLUMNS} FROM audit_event WHERE chain_pos = 5`,
      );
      const raw = selected.rows[0];
      if (raw === undefined) throw new Error('no row at 5');
      const row = toSealedChainRow(raw);
      const forged = auditRowHash(row, row.prevHash ?? '');
      await c.query('UPDATE audit_event SET hash = $1 WHERE chain_pos = 5', [forged]);
    });

    expect(formatVerifyReport(await verifyAuditChain(pool))).toBe('failed chain_pos=6 reason=prev_mismatch');
  });

  it('AUD-5 verification starts at the newest anchor', async () => {
    const pool = await fresh();
    await insertRows(pool, 150);
    await sealAll(pool);
    const anchorHash = await storedHash(pool, 100);
    const head = await storedHash(pool, 150);
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(
        `INSERT INTO audit_anchor (chain_pos, hash, archive, sha256, count)
         VALUES (50, 'sha256:older', 'audit-1-50.jsonl', 'sha256:x', 50),
                (100, $1, 'audit-51-100.jsonl', 'sha256:y', 50)`,
        [anchorHash],
      );
      await client.query("SELECT set_config('mandate.audit_retention', 'on', true)");
      await client.query('DELETE FROM audit_event WHERE chain_pos <= 100');
      await client.query('COMMIT');
    } finally {
      client.release();
    }

    const report = await verifyAuditChain(pool, { pageSize: 7 });

    expect(report).toEqual({ ok: true, sealed: 50, unsealed: 0, from: 101, head: { pos: 150, hash: head } });
    expect(formatVerifyReport(report)).toBe(`ok sealed=50 unsealed=0 from=101 head=150:${head}`);
  });

  it('AUD-5 an anchor whose hash differs from the next row prev_hash fails at anchor + 1', async () => {
    const pool = await fresh();
    await insertRows(pool, 30);
    await sealAll(pool);
    await pool.query(
      `INSERT INTO audit_anchor (chain_pos, hash, archive, sha256, count)
       VALUES (20, $1, 'audit-1-20.jsonl', 'sha256:x', 20)`,
      [`sha256:${'f'.repeat(64)}`],
    );

    expect(formatVerifyReport(await verifyAuditChain(pool))).toBe('failed chain_pos=21 reason=prev_mismatch');
  });

  it('AUD-5 an empty table verifies as ok from genesis', async () => {
    const pool = await fresh();

    const report = await verifyAuditChain(pool);

    expect(report).toEqual({ ok: true, sealed: 0, unsealed: 0, from: 1, head: { pos: 0, hash: GENESIS_HASH } });
    expect(formatVerifyReport(report)).toBe(`ok sealed=0 unsealed=0 from=1 head=0:${GENESIS_HASH}`);
  });

  it('AUD-5 a row whose content cannot be hashed is reported as hash_mismatch at that position', async () => {
    const pool = await fresh();
    await insertRows(pool, 5);
    await sealAll(pool);
    // jsonb cannot hold a value canonicalJson refuses, so a pool proxy drops `details` from row 3:
    // auditRowHash then throws CanonicalJsonError (undefined), which verify must report, not raise.
    const proxied = {
      connect: async () => {
        const client = await pool.connect();
        const query = client.query.bind(client) as (text: string, values?: unknown[]) => Promise<pg.QueryResult>;
        return Object.assign(Object.create(client) as pg.PoolClient, {
          query: async (text: string, values?: unknown[]) => {
            const result = await query(text, values);
            for (const row of result.rows as Record<string, unknown>[]) {
              if (row.pos === '3') delete row.details;
            }
            return result;
          },
          release: (error?: Error | boolean) => {
            client.release(error);
          },
        });
      },
    } as unknown as pg.Pool; // only `connect` is used by verifyAuditChain

    expect(formatVerifyReport(await verifyAuditChain(proxied))).toBe('failed chain_pos=3 reason=hash_mismatch');
  });

  it('SEC-3 the report never contains row content', async () => {
    const pool = await fresh();
    await insertRows(pool, 30);
    await sealAll(pool);
    await tamper(pool, async (c) => {
      await c.query(
        `UPDATE audit_event SET actor = 'secret-actor-id', correlation_id = 'secret-corr-id',
                details = '{"note":"secret-detail-value"}' WHERE chain_pos = 12`,
      );
    });

    const output = formatVerifyReport(await verifyAuditChain(pool));

    expect(output).toBe('failed chain_pos=12 reason=hash_mismatch');
    for (const content of ['secret-actor-id', 'secret-corr-id', 'secret-detail-value', 'actor-12', 'corr-12', 'detail-12']) {
      expect(output).not.toContain(content);
    }
  });
});
