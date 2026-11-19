import { randomUUID } from 'node:crypto';
import type { AuditEventInput, NewConfigRevision } from '@aiops/core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { describeConfigRevisionStoreContract, startPostgres, type StartedPostgres } from '@aiops/testing';
import { createDb, type Database } from '../../src/client.js';
import { PostgresConfigRevisionStore } from '../../src/config-revision-store.js';
import { CONFIG_LOCK_KEY } from '../../src/locks.js';
import { runMigrations } from '../../src/migrate.js';

let postgres: StartedPostgres;
const databases: Database[] = [];

beforeAll(async () => {
  postgres = await startPostgres();
});

afterAll(async () => {
  for (const database of databases.splice(0)) await database.close();
  await postgres.stop();
});

/** A fresh, fully migrated database; the pools opened on it are closed in afterAll. */
async function freshUrl(): Promise<string> {
  const url = await postgres.createDatabase();
  await runMigrations(url);
  return url;
}

function open(url: string): { database: Database; store: PostgresConfigRevisionStore } {
  const database = createDb(url, { onError: () => undefined });
  databases.push(database);
  return { database, store: new PostgresConfigRevisionStore(database.db, { databaseUrl: url }) };
}

async function auditRowsOf(database: Database): Promise<AuditEventInput[]> {
  const result = await database.pool.query<{
    id: string;
    actor: string;
    action: AuditEventInput['action'];
    outcome: AuditEventInput['outcome'];
    correlation_id: string;
    details: Record<string, unknown>;
  }>('SELECT id, actor, action, outcome, correlation_id, details FROM audit_event ORDER BY ts, id');
  return result.rows.map((row) => ({
    id: row.id,
    actor: row.actor,
    action: row.action,
    outcome: row.outcome,
    correlationId: row.correlation_id,
    details: row.details,
  }));
}

async function count(database: Database, sql: string): Promise<number> {
  const result = await database.pool.query<{ n: string }>(sql);
  return Number(result.rows[0]?.n);
}

async function waitFor(check: () => Promise<boolean>): Promise<void> {
  const deadline = Date.now() + 10_000;
  while (!(await check())) {
    if (Date.now() > deadline) throw new Error('condition not reached within 10 s');
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

/**
 * Runs `race` while a third connection holds CONFIG_LOCK_KEY, and releases it only once `waiters`
 * transactions are queued on that lock: the racers really overlap, and each provably takes the lock.
 */
async function underHeldLock<T>(database: Database, waiters: number, race: () => Promise<T>): Promise<T> {
  const holder = await database.pool.connect();
  try {
    await holder.query('BEGIN');
    await holder.query('SELECT pg_advisory_xact_lock($1::bigint)', [CONFIG_LOCK_KEY.toString()]);
    const running = race();
    // Observed through pg_locks; rejections of `running` are surfaced by the await below.
    running.catch(() => undefined);
    await waitFor(
      async () =>
        (await count(
          database,
          "SELECT count(*) AS n FROM pg_locks WHERE locktype = 'advisory' AND NOT granted AND database = (SELECT oid FROM pg_database WHERE datname = current_database())",
        )) === waiters,
    );
    await holder.query('COMMIT');
    return await running;
  } finally {
    holder.release();
  }
}

describeConfigRevisionStoreContract(
  async () => {
    const { database, store } = open(await freshUrl());
    return { store, auditRows: () => auditRowsOf(database) };
  },
  { listener: false },
);

const HASH_A = 'a'.repeat(64);
const HASH_B = 'b'.repeat(64);
const HASH_C = 'c'.repeat(64);
const SUMMARY = { connections: 1, operations: 2, roles: 3, notifications: 0 } as const;

function revision(hash: string): NewConfigRevision {
  return { id: randomUUID(), hash, files: { 'config.yaml': `hash: ${hash}\n` }, actor: 'cli:alice', summary: SUMMARY };
}

function bootstrapRevision(hash: string): Omit<NewConfigRevision, 'actor'> {
  const { id, files, summary } = revision(hash);
  return { id, hash, files, summary };
}

function applyEvent(id: string = randomUUID()): AuditEventInput {
  return { id, actor: 'cli:alice', action: 'config.apply', outcome: 'ok', correlationId: randomUUID(), details: { note: 'race' } };
}

describe('CFG-4 PostgresConfigRevisionStore under concurrency', () => {
  it('CFG-4 NFR-3 two bootstraps racing on two pools insert one row and return the same revision', async () => {
    const url = await freshUrl();
    const one = open(url);
    const two = open(url);
    const [r1, r2] = await underHeldLock(one.database, 2, () =>
      Promise.all([one.store.bootstrap(bootstrapRevision(HASH_A)), two.store.bootstrap(bootstrapRevision(HASH_B))]),
    );
    expect(r1.id).toBe(r2.id);
    expect(r1).toEqual(r2);
    expect(await count(one.database, 'SELECT count(*) AS n FROM config_revision')).toBe(1);
  });

  it('CFG-4 two applies racing against the same previous hash: one ok, one concurrent_apply', async () => {
    const url = await freshUrl();
    const one = open(url);
    const two = open(url);
    await one.store.bootstrap(bootstrapRevision(HASH_A));
    const results = await underHeldLock(one.database, 2, () =>
      Promise.all([one.store.apply(revision(HASH_B), applyEvent(), HASH_A), two.store.apply(revision(HASH_C), applyEvent(), HASH_A)]),
    );
    const tally = { ok: 0, concurrent_apply: 0 };
    for (const result of results) {
      if (result.ok) tally.ok += 1;
      else if (result.reason === 'concurrent_apply') tally.concurrent_apply += 1;
    }
    expect(tally).toEqual({ ok: 1, concurrent_apply: 1 });
    expect(await count(one.database, 'SELECT count(*) AS n FROM config_revision')).toBe(2);
    expect(await count(one.database, "SELECT count(*) AS n FROM audit_event WHERE action = 'config.apply'")).toBe(1);
  });

  it('CFG-4 a failing audit append rolls the revision back', async () => {
    const { database, store } = open(await freshUrl());
    await store.bootstrap(bootstrapRevision(HASH_A));
    const first = await store.apply(revision(HASH_B), applyEvent(), HASH_A);
    if (!first.ok) throw new Error(`apply refused: ${first.reason}`);
    const [existing] = await auditRowsOf(database);
    if (existing === undefined) throw new Error('no audit row');

    await expect(store.apply(revision(HASH_C), applyEvent(existing.id), HASH_B)).rejects.toThrow(/^config apply failed/);
    expect(await store.active()).toEqual(first.revision);
    expect(await count(database, 'SELECT count(*) AS n FROM config_revision')).toBe(2);
  });
});
