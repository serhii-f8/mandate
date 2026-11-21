// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The AI Operations Layer Authors
import type pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startPostgres, type StartedPostgres } from '@aiops/testing';
import { sealAuditChain } from '../../src/audit-chain.js';
import { PostgresAuditReader } from '../../src/audit-search.js';
import { createDb, type Database } from '../../src/client.js';
import { runMigrations } from '../../src/migrate.js';

let postgres: StartedPostgres;

beforeAll(async () => {
  postgres = await startPostgres();
});

afterAll(async () => {
  await postgres.stop();
});

const CS_1 = '00000000-0000-4000-8000-0000000000c1';
const CS_2 = '00000000-0000-4000-8000-0000000000c2';

interface Row {
  readonly actor?: string;
  readonly action?: string;
  readonly outcome?: string;
  readonly correlationId?: string;
  readonly changesetId?: string | null;
  readonly ts?: string;
}

/** Inserts rows one by one, in order, so `seq` follows the array. */
async function insert(pool: pg.Pool, rows: readonly Row[]): Promise<void> {
  for (const row of rows) {
    await pool.query(
      `INSERT INTO audit_event (id, ts, actor, client_id, action, subject, decision, outcome, correlation_id, changeset_id, details)
       VALUES (gen_random_uuid(), $1, $2, 'claude-ai', $3, 'ping', NULL, $4, $5, $6, '{"k":1}')`,
      [
        row.ts ?? '2026-11-18T10:00:00.000Z',
        row.actor ?? 'alice-id',
        row.action ?? 'tool.call',
        row.outcome ?? 'ok',
        row.correlationId ?? 'corr',
        row.changesetId ?? null,
      ],
    );
  }
}

describe('AUD-6 NFR-8 audit search reader', () => {
  let database: Database | undefined;

  afterAll(async () => {
    await database?.close();
  });

  async function fresh(): Promise<pg.Pool> {
    await database?.close();
    const url = await postgres.createDatabase();
    await runMigrations(url);
    database = createDb(url, { onError: () => undefined });
    return database.pool;
  }

  it('AUD-6 filters by actor, action, outcome, changeset, correlation and time, newest first', async () => {
    const pool = await fresh();
    await insert(pool, [
      { actor: 'alice-id', correlationId: 'c-1', ts: '2026-11-18T09:00:00.000Z' },
      { actor: 'bob-id', action: 'approval.decision', changesetId: CS_1, correlationId: 'c-2', ts: '2026-11-18T10:00:00.000Z' },
      { actor: 'alice-id', action: 'approval.decision', outcome: 'denied', changesetId: CS_1, correlationId: 'c-3', ts: '2026-11-18T11:00:00.000Z' },
      { actor: 'alice-id', action: 'approval.decision', changesetId: CS_2, correlationId: 'c-4', ts: '2026-11-18T12:00:00.000Z' },
      { actor: 'alice-id', correlationId: 'c-5', ts: '2026-11-18T13:00:00.000Z' },
    ]);
    const reader = new PostgresAuditReader(pool);
    const corr = async (filter: Parameters<PostgresAuditReader['search']>[0]): Promise<string[]> =>
      (await reader.search(filter, { limit: 100 })).events.map((e) => e.correlationId);

    expect(await corr({})).toEqual(['c-5', 'c-4', 'c-3', 'c-2', 'c-1']);
    expect(await corr({ actor: 'alice-id' })).toEqual(['c-5', 'c-4', 'c-3', 'c-1']);
    expect(await corr({ action: 'approval.decision' })).toEqual(['c-4', 'c-3', 'c-2']);
    expect(await corr({ outcome: 'denied' })).toEqual(['c-3']);
    expect(await corr({ changesetId: CS_1 })).toEqual(['c-3', 'c-2']);
    expect(await corr({ correlationId: 'c-4' })).toEqual(['c-4']);
    // `from` is inclusive, `to` exclusive.
    expect(await corr({ from: new Date('2026-11-18T10:00:00.000Z'), to: new Date('2026-11-18T12:00:00.000Z') })).toEqual([
      'c-3',
      'c-2',
    ]);
    expect(await corr({ actor: 'alice-id', action: 'approval.decision', outcome: 'ok' })).toEqual(['c-4']);

    const { events, more } = await reader.search({ correlationId: 'c-2' }, { limit: 10 });
    expect(more).toBe(false);
    const [event] = events;
    expect(event?.id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
    expect(events).toEqual([
      {
        seq: '2',
        id: event?.id,
        ts: '2026-11-18T10:00:00.000000Z',
        actor: 'bob-id',
        clientId: 'claude-ai',
        action: 'approval.decision',
        subject: 'ping',
        decision: null,
        outcome: 'ok',
        correlationId: 'c-2',
        changesetId: CS_1,
        details: { k: 1 },
        chainPos: null,
      },
    ]);
  });

  it('NFR-8 pages by seq with no row twice or missing', async () => {
    const pool = await fresh();
    await pool.query(
      `INSERT INTO audit_event (id, actor, action, outcome, correlation_id, details)
       SELECT gen_random_uuid(), 'actor', 'tool.call', 'ok', 'corr-' || n, '{}'::jsonb FROM generate_series(1, 120) AS n`,
    );
    const reader = new PostgresAuditReader(pool);
    const seen: string[] = [];
    const pages: number[] = [];
    let beforeSeq: string | undefined;
    for (;;) {
      const page = await reader.search({}, beforeSeq === undefined ? { limit: 50 } : { limit: 50, beforeSeq });
      pages.push(page.events.length);
      seen.push(...page.events.map((e) => e.seq));
      const last = page.events.at(-1);
      if (!page.more || last === undefined) break;
      beforeSeq = last.seq;
    }
    expect(pages).toEqual([50, 50, 20]);
    expect(seen).toEqual(Array.from({ length: 120 }, (_, i) => String(120 - i)));
  });

  it('NFR-8 orders by numeric seq across a digit boundary', async () => {
    const pool = await fresh();
    await pool.query(
      `INSERT INTO audit_event (id, actor, action, outcome, correlation_id, details)
       SELECT gen_random_uuid(), 'actor', 'tool.call', 'ok', 'corr-' || n, '{}'::jsonb FROM generate_series(1, 12) AS n`,
    );
    const page = await new PostgresAuditReader(pool).search({}, { limit: 3, beforeSeq: '11' });
    expect(page.events.map((e) => e.seq)).toEqual(['10', '9', '8']);
    expect(page.more).toBe(true);
  });

  it('AUD-6 returns chainPos for sealed rows and null for unsealed', async () => {
    const pool = await fresh();
    await insert(pool, [{ correlationId: 'c-1' }, { correlationId: 'c-2' }]);
    await sealAuditChain(pool);
    await insert(pool, [{ correlationId: 'c-3' }]);
    const { events } = await new PostgresAuditReader(pool).search({}, { limit: 10 });
    expect(events.map((e) => [e.correlationId, e.chainPos])).toEqual([
      ['c-3', null],
      ['c-2', 2],
      ['c-1', 1],
    ]);
  });

  it("AUD-6 a filter value with quotes or percent signs is a literal", async () => {
    const pool = await fresh();
    await insert(pool, [
      { actor: "a%'b", correlationId: 'c-1' },
      { actor: "aX'b", correlationId: 'c-2' },
      { actor: "a%'bc", correlationId: 'c-3' },
      { actor: 'a_b', correlationId: 'c-4' },
    ]);
    const reader = new PostgresAuditReader(pool);
    expect((await reader.search({ actor: "a%'b" }, { limit: 10 })).events.map((e) => e.correlationId)).toEqual(['c-1']);
    expect((await reader.search({ correlationId: '%' }, { limit: 10 })).events).toEqual([]);
  });
});
