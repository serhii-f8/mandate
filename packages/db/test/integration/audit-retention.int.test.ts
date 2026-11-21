// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The AI Operations Layer Authors
import { createHash, randomUUID } from 'node:crypto';
import { chmod, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { GENESIS_HASH } from '@aiops/core';
import type pg from 'pg';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { startPostgres, type StartedPostgres } from '@aiops/testing';
import { formatArchiveReport, verifyAuditArchive, writeAuditArchive, type ArchiveManifest } from '../../src/audit-archive.js';
import { sealAuditChain } from '../../src/audit-chain.js';
import { DrizzleAuditLog } from '../../src/audit-log.js';
import { runAuditRetention, type RetentionDeps } from '../../src/audit-retention.js';
import { formatVerifyReport, verifyAuditChain } from '../../src/audit-verify.js';
import { createDb, type Database } from '../../src/client.js';
import { AUDIT_RETENTION_LOCK_KEY } from '../../src/locks.js';
import { runMigrations } from '../../src/migrate.js';
import { PostgresRateCounter } from '../../src/rate-counter.js';

let postgres: StartedPostgres;
const databases: Database[] = [];
const dirs: string[] = [];

beforeAll(async () => {
  postgres = await startPostgres();
});

afterEach(async () => {
  for (const database of databases.splice(0)) await database.close();
  for (const dir of dirs.splice(0)) {
    await chmod(dir, 0o700).catch(() => undefined);
    await rm(dir, { recursive: true, force: true });
  }
});

afterAll(async () => {
  await postgres.stop();
});

/** A fresh, fully migrated database. */
async function freshDatabase(): Promise<Database> {
  const url = await postgres.createDatabase();
  await runMigrations(url);
  const database = createDb(url, { onError: () => undefined });
  databases.push(database);
  return database;
}

async function freshDir(): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), 'aiops-archive-'));
  dirs.push(dir);
  return dir;
}

/** Inserts `count` unsealed rows, `ageDays` old (0 = now). */
async function insertRows(pool: pg.Pool, count: number, ageDays: number): Promise<void> {
  await pool.query(
    `INSERT INTO audit_event (id, ts, actor, action, subject, outcome, correlation_id, details)
     SELECT gen_random_uuid(), now() - make_interval(days => $2::int), 'actor-' || n, 'tool.call', 'ping', 'ok', 'corr-' || n,
            jsonb_build_object('durationMs', n, 'note', 'detail-' || n)
     FROM generate_series(1, $1::int) AS n`,
    [count, ageDays],
  );
}

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

function deps(database: Database, overrides: Partial<RetentionDeps> = {}): RetentionDeps {
  return {
    pool: database.pool,
    audit: new DrizzleAuditLog(database.db),
    rateCounter: new PostgresRateCounter(database.db),
    retentionDays: 30,
    archiveDir: undefined,
    actor: 'system',
    now: () => new Date(),
    newId: randomUUID,
    ...overrides,
  };
}

async function count(pool: pg.Pool, sql: string): Promise<number> {
  const result = await pool.query<{ n: string }>(sql);
  return Number(result.rows[0]?.n);
}

const eventCount = (pool: pg.Pool): Promise<number> => count(pool, 'SELECT count(*)::text AS n FROM audit_event');

async function retentionRows(pool: pg.Pool): Promise<{ outcome: string; details: unknown }[]> {
  const result = await pool.query<{ outcome: string; details: unknown }>(
    "SELECT outcome, details FROM audit_event WHERE action = 'audit.retention' ORDER BY seq",
  );
  return result.rows;
}

async function anchors(pool: pg.Pool): Promise<Record<string, unknown>[]> {
  const result = await pool.query<Record<string, unknown>>(
    'SELECT chain_pos::int AS "chainPos", hash, archive, sha256, count::int AS count FROM audit_anchor ORDER BY chain_pos',
  );
  return result.rows;
}

async function hashAt(pool: pg.Pool, pos: number): Promise<string> {
  const result = await pool.query<{ hash: string }>('SELECT hash FROM audit_event WHERE chain_pos = $1', [pos]);
  const hash = result.rows[0]?.hash;
  if (hash === undefined) throw new Error(`no row at ${pos}`);
  return hash;
}

const sha256 = (bytes: Buffer | string): string => `sha256:${createHash('sha256').update(bytes).digest('hex')}`;

async function readManifest(file: string): Promise<ArchiveManifest> {
  return JSON.parse(await readFile(file, 'utf8')) as ArchiveManifest;
}

describe('AUD-7 audit retention', () => {
  it('AUD-7 archives the sealed prefix older than the cutoff, anchors it and deletes it', async () => {
    const database = await freshDatabase();
    const { pool } = database;
    const dir = await freshDir();
    await insertRows(pool, 30, 40);
    await insertRows(pool, 5, 0);
    await sealAll(pool);
    const hash30 = await hashAt(pool, 30);

    const report = await runAuditRetention(deps(database, { archiveDir: dir }));

    expect(report).toEqual({ kind: 'archived', first: 1, last: 30, count: 30, archive: 'audit-1-30.jsonl', rateBucketsDeleted: 0 });
    expect((await readdir(dir)).sort()).toEqual(['audit-1-30.jsonl', 'audit-1-30.manifest.json']);
    const bytes = await readFile(path.join(dir, 'audit-1-30.jsonl'));
    const lines = bytes.toString('utf8').split('\n').filter((line) => line !== '');
    expect(lines).toHaveLength(30);
    const manifest = await readManifest(path.join(dir, 'audit-1-30.manifest.json'));
    expect(manifest).toMatchObject({ first: 1, last: 30, count: 30, prevHash: GENESIS_HASH, lastHash: hash30, sha256: sha256(bytes) });
    expect(await anchors(pool)).toEqual([{ chainPos: 30, hash: hash30, archive: 'audit-1-30.jsonl', sha256: sha256(bytes), count: 30 }]);
    expect(await count(pool, "SELECT count(*)::text AS n FROM audit_event WHERE action = 'tool.call'")).toBe(5);
    expect(await count(pool, "SELECT count(*)::text AS n FROM audit_event WHERE ts < now() - interval '30 days'")).toBe(0);
    expect(formatVerifyReport(await verifyAuditChain(pool))).toMatch(/^ok sealed=5 unsealed=1 from=31 head=35:/);
    expect(await retentionRows(pool)).toEqual([
      { outcome: 'ok', details: { first: 1, last: 30, count: 30, archive: 'audit-1-30.jsonl' } },
    ]);
    expect(await verifyAuditArchive(pool, path.join(dir, 'audit-1-30.jsonl'))).toEqual({ ok: true, first: 1, last: 30, count: 30 });
  });

  it('AUD-7 unsealed old rows are sealed first', async () => {
    const database = await freshDatabase();
    const dir = await freshDir();
    await insertRows(database.pool, 12, 40);
    await insertRows(database.pool, 3, 0);

    const report = await runAuditRetention(deps(database, { archiveDir: dir }));

    expect(report).toMatchObject({ kind: 'archived', first: 1, last: 12, count: 12, archive: 'audit-1-12.jsonl' });
    expect(await eventCount(database.pool)).toBe(4);
  });

  it('AUD-7 a second run archives from the anchor on and the chain verifies across the cut', async () => {
    const database = await freshDatabase();
    const { pool } = database;
    const dir = await freshDir();
    await insertRows(pool, 30, 40);
    expect(await runAuditRetention(deps(database, { archiveDir: dir }))).toMatchObject({ kind: 'archived', last: 30 });
    const [firstAnchor] = await anchors(pool);
    // The first run's own audit.retention row seals at 31; nine more old rows take 32–40.
    await insertRows(pool, 9, 40);

    const report = await runAuditRetention(deps(database, { archiveDir: dir }));

    expect(report).toMatchObject({ kind: 'archived', first: 31, last: 40, count: 10, archive: 'audit-31-40.jsonl' });
    const manifest = await readManifest(path.join(dir, 'audit-31-40.manifest.json'));
    expect(manifest.prevHash).toBe(firstAnchor?.hash);
    expect(await verifyAuditArchive(pool, path.join(dir, 'audit-1-30.jsonl'))).toEqual({ ok: true, first: 1, last: 30, count: 30 });
    expect(await verifyAuditArchive(pool, path.join(dir, 'audit-31-40.jsonl'))).toEqual({ ok: true, first: 31, last: 40, count: 10 });
    await sealAll(pool);
    expect(formatVerifyReport(await verifyAuditChain(pool))).toMatch(/^ok sealed=1 unsealed=0 from=41 head=41:/);
  });

  it('AUD-7 nothing due and not configured delete nothing', async () => {
    const database = await freshDatabase();
    const dir = await freshDir();
    await insertRows(database.pool, 4, 40);
    await insertRows(database.pool, 2, 0);

    expect(await runAuditRetention(deps(database, { retentionDays: undefined, archiveDir: dir }))).toEqual({
      kind: 'not_configured',
      rateBucketsDeleted: 0,
    });
    expect(await runAuditRetention(deps(database, { retentionDays: 60, archiveDir: dir }))).toEqual({
      kind: 'nothing_due',
      rateBucketsDeleted: 0,
    });
    expect(await eventCount(database.pool)).toBe(6);
    expect(await readdir(dir)).toEqual([]);
    expect(await retentionRows(database.pool)).toEqual([]);
    expect(await anchors(database.pool)).toEqual([]);
  });

  it('AUD-7 a missing or unwritable archive directory refuses and deletes nothing', async () => {
    const database = await freshDatabase();
    const { pool } = database;
    const parent = await freshDir();
    await insertRows(pool, 5, 40);
    const unavailable = [undefined, path.join(parent, 'does-not-exist')];
    // Root passes access(W_OK) on a mode-0o500 directory, so that case only runs as a normal user.
    if (process.getuid?.() !== 0) {
      const readOnly = path.join(parent, 'read-only');
      await mkdir(readOnly, { mode: 0o500 });
      unavailable.push(readOnly);
    }

    for (const archiveDir of unavailable) {
      expect(await runAuditRetention(deps(database, { archiveDir }))).toEqual({
        kind: 'refused',
        reason: 'archive_unavailable',
        rateBucketsDeleted: 0,
      });
    }

    expect(await count(pool, "SELECT count(*)::text AS n FROM audit_event WHERE action = 'tool.call'")).toBe(5);
    expect(await anchors(pool)).toEqual([]);
    expect(await retentionRows(pool)).toEqual(
      unavailable.map(() => ({ outcome: 'error', details: { reason: 'archive_unavailable' } })),
    );
    expect((await readdir(parent)).filter((name) => name !== 'read-only')).toEqual([]);
  });

  it('AUD-7 AUD-5 a tampered row in the range refuses with chain_invalid', async () => {
    const database = await freshDatabase();
    const { pool } = database;
    const dir = await freshDir();
    await insertRows(pool, 1500, 40);
    await sealAll(pool);
    await tamper(pool, async (client) => {
      await client.query("UPDATE audit_event SET details = '{\"durationMs\":0}' WHERE chain_pos = 1200");
    });

    const report = await runAuditRetention(deps(database, { archiveDir: dir }));

    expect(report).toEqual({ kind: 'refused', reason: 'chain_invalid', rateBucketsDeleted: 0 });
    expect(await readdir(dir)).toEqual([]);
    expect(await count(pool, "SELECT count(*)::text AS n FROM audit_event WHERE action = 'tool.call'")).toBe(1500);
    expect(await anchors(pool)).toEqual([]);
    expect(await retentionRows(pool)).toEqual([{ outcome: 'error', details: { reason: 'chain_invalid', chainPos: 1200 } }]);
  });

  it('AUD-7 a run after a crash between archive and delete rewrites the files', async () => {
    const database = await freshDatabase();
    const { pool } = database;
    const dir = await freshDir();
    await insertRows(pool, 30, 40);
    await sealAll(pool);
    const written = await writeAuditArchive(pool, dir, { pos: 0, hash: GENESIS_HASH }, 30);
    expect(written).toMatchObject({ ok: true, file: path.join(dir, 'audit-1-30.jsonl') });
    const orphan = await verifyAuditArchive(pool, path.join(dir, 'audit-1-30.jsonl'));
    expect(orphan).toEqual({ ok: false, reason: 'no_anchor' });
    expect(formatArchiveReport(orphan)).toBe('failed archive reason=no_anchor');

    const report = await runAuditRetention(deps(database, { archiveDir: dir }));

    expect(report).toMatchObject({ kind: 'archived', first: 1, last: 30, archive: 'audit-1-30.jsonl' });
    expect((await readdir(dir)).sort()).toEqual(['audit-1-30.jsonl', 'audit-1-30.manifest.json']);
    const report2 = await verifyAuditArchive(pool, path.join(dir, 'audit-1-30.jsonl'));
    expect(formatArchiveReport(report2)).toBe('ok archive count=30 first=1 last=30');
  });

  it('AUD-7 verifyAuditArchive detects a changed byte, a dropped line and a wrong range', async () => {
    const database = await freshDatabase();
    const { pool } = database;
    const dir = await freshDir();
    await insertRows(pool, 30, 40);
    await runAuditRetention(deps(database, { archiveDir: dir }));
    const file = path.join(dir, 'audit-1-30.jsonl');
    const manifestFile = path.join(dir, 'audit-1-30.manifest.json');
    const original = await readFile(file, 'utf8');
    const manifest = await readManifest(manifestFile);
    const lines = original.split('\n').filter((line) => line !== '');

    /** Writes `content` as the archive with `patch` applied to the manifest, and verifies it. */
    async function check(content: string, patch: Partial<ArchiveManifest> = {}): Promise<string> {
      await writeFile(file, content);
      await writeFile(manifestFile, JSON.stringify({ ...manifest, ...patch }));
      return formatArchiveReport(await verifyAuditArchive(pool, file));
    }

    const changed = original.replace('detail-7"', 'detail-8"');
    const dropped = [...lines.slice(0, 10), ...lines.slice(11)].map((line) => `${line}\n`).join('');
    const shifted = lines.slice(1).map((line) => `${line}\n`).join('');

    expect(await check(changed)).toBe('failed archive reason=sha256_mismatch');
    expect(await check(dropped)).toBe('failed archive reason=sha256_mismatch');
    expect(await check(shifted)).toBe('failed archive reason=sha256_mismatch');
    expect(await check(dropped, { sha256: sha256(dropped) })).toBe('failed archive reason=count_mismatch');
    expect(await check(shifted, { sha256: sha256(shifted), count: 29 })).toBe('failed archive reason=range_mismatch');
    expect(await check(changed, { sha256: sha256(changed) })).toBe('failed archive reason=hash_mismatch chain_pos=7');
    await writeFile(manifestFile, '{not json');
    expect(formatArchiveReport(await verifyAuditArchive(pool, file))).toBe('failed archive reason=manifest_unreadable');
    expect(await check(original)).toBe('ok archive count=30 first=1 last=30');
    await rm(file);
    expect(formatArchiveReport(await verifyAuditArchive(pool, file))).toBe('failed archive reason=archive_unreadable');
  });

  it('AUD-7 the manifest createdAt comes from the injected clock', async () => {
    const database = await freshDatabase();
    const dir = await freshDir();
    await insertRows(database.pool, 3, 40);
    // A day ahead: the wall clock cannot produce it, and the 40-day-old rows are still due.
    const fixed = new Date(Date.now() + 24 * 60 * 60 * 1000);

    await runAuditRetention(deps(database, { archiveDir: dir, now: () => fixed }));

    expect((await readManifest(path.join(dir, 'audit-1-3.manifest.json'))).createdAt).toBe(fixed.toISOString());
  });

  it('AUD-7 only one retention run at a time', async () => {
    const database = await freshDatabase();
    const dir = await freshDir();
    await insertRows(database.pool, 5, 40);
    const holder = await database.pool.connect();
    try {
      await holder.query('SELECT pg_advisory_lock($1)', [AUDIT_RETENTION_LOCK_KEY.toString()]);

      expect(await runAuditRetention(deps(database, { archiveDir: dir }))).toEqual({ kind: 'locked', rateBucketsDeleted: 0 });

      expect(await eventCount(database.pool)).toBe(5);
      expect(await readdir(dir)).toEqual([]);
      expect(await retentionRows(database.pool)).toEqual([]);
    } finally {
      await holder.query('SELECT pg_advisory_unlock($1)', [AUDIT_RETENTION_LOCK_KEY.toString()]);
      holder.release();
    }
    expect(await runAuditRetention(deps(database, { archiveDir: dir }))).toMatchObject({ kind: 'archived', count: 5 });
  });

  it('AUD-7 rate_bucket rows older than two days are deleted on every run, configured or not', async () => {
    const database = await freshDatabase();
    const { pool } = database;
    const insertBuckets = (): Promise<unknown> =>
      pool.query(
        `INSERT INTO rate_bucket (key, window_start, count) VALUES
           ('k-' || gen_random_uuid(), now() - interval '49 hours', 1),
           ('k-' || gen_random_uuid(), now() - interval '3 days', 2),
           ('k-' || gen_random_uuid(), now() - interval '47 hours', 3)`,
      );
    const buckets = (): Promise<number> => count(pool, 'SELECT count(*)::text AS n FROM rate_bucket');

    await insertBuckets();
    expect(await runAuditRetention(deps(database, { retentionDays: undefined }))).toEqual({ kind: 'not_configured', rateBucketsDeleted: 2 });
    expect(await buckets()).toBe(1);

    await insertBuckets();
    expect(await runAuditRetention(deps(database, { retentionDays: 30 }))).toEqual({ kind: 'nothing_due', rateBucketsDeleted: 2 });
    expect(await buckets()).toBe(2);
  });
});
