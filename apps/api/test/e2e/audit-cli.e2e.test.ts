// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Mandate Authors
import { cp, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { runMigrations, sealAuditChain } from '@mandate/db';
import type { StartedPostgres } from '@mandate/testing';
import { runApiCli } from '../../src/cli.js';
import { startDatabase } from './helpers.js';

const AUDIT_CONFIG = fileURLToPath(new URL('./fixtures/audit-config', import.meta.url));
const KEY_1 = 'ZGV2LW9ubHktbWFzdGVyLWtleS0wMTIzNDU2Nzg5YWI=';

let postgres: StartedPostgres;
let archiveDir: string;

beforeAll(async () => {
  ({ postgres } = await startDatabase());
  archiveDir = await mkdtemp(join(tmpdir(), 'mandate-audit-cli-'));
});

afterAll(async () => {
  await postgres.stop();
  await rm(archiveDir, { recursive: true, force: true });
});

async function freshDatabase(): Promise<string> {
  const url = await postgres.createDatabase();
  await runMigrations(url);
  return url;
}

async function withPool<T>(url: string, action: (pool: pg.Pool) => Promise<T>): Promise<T> {
  const pool = new pg.Pool({ connectionString: url });
  try {
    return await action(pool);
  } finally {
    await pool.end();
  }
}

/** Inserts `count` rows `ageDays` old, then seals them. */
async function seedSealed(url: string, count: number, ageDays: number): Promise<void> {
  await withPool(url, async (pool) => {
    await pool.query(
      `INSERT INTO audit_event (id, ts, actor, action, subject, outcome, correlation_id, details)
       SELECT gen_random_uuid(), now() - make_interval(days => $2::int), 'actor-' || n, 'tool.call', 'ping', 'ok', 'corr-' || n, '{}'::jsonb
       FROM generate_series(1, $1::int) AS n`,
      [count, ageDays],
    );
    await sealAuditChain(pool);
  });
}

async function cli(argv: string[], url: string, extraEnv: Record<string, string> = {}): Promise<{ code: number; lines: string[] }> {
  const lines: string[] = [];
  const code = await runApiCli(argv, (line) => lines.push(line), {
    env: { DATABASE_URL: url, MANDATE_MASTER_KEYS: `1:${KEY_1}`, ...extraEnv },
    defaultPresetDir: null,
  });
  return { code, lines };
}

/** Stores `dir` as the active revision through `mandate config apply` (CFG-3). */
async function activate(url: string, dir: string): Promise<void> {
  const { code, lines } = await cli(['config', 'apply', dir], url);
  expect(lines.at(-1), lines.join('\n')).toMatch(/^applied revision /);
  expect(code).toBe(0);
}

/** A copy of the audit fixture without `settings.yaml`, so without `audit.retention_days`. */
async function withoutRetention(): Promise<string> {
  const dir = await mkdtemp(join(archiveDir, 'cfg-'));
  await cp(AUDIT_CONFIG, dir, { recursive: true });
  await rm(join(dir, 'settings.yaml'));
  return dir;
}

async function auditCount(url: string): Promise<number> {
  return withPool(url, async (pool) => Number((await pool.query<{ n: string }>("SELECT count(*) AS n FROM audit_event WHERE action = 'tool.call'")).rows[0]?.n));
}

describe('AUD-5 mandate audit verify', () => {
  it('AUD-5 audit verify prints ok with the head and exits 0', async () => {
    const url = await freshDatabase();
    await seedSealed(url, 3, 0);
    const { code, lines } = await cli(['audit', 'verify'], url);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatch(/^ok sealed=3 unsealed=0 from=1 head=3:sha256:[0-9a-f]{64}$/);
    expect(code).toBe(0);
  });

  it('AUD-5 audit verify after one altered row prints failed with that chain_pos and exits 1', async () => {
    const url = await freshDatabase();
    await seedSealed(url, 3, 0);
    await withPool(url, async (pool) => {
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        await client.query('SET LOCAL session_replication_role = replica');
        await client.query("UPDATE audit_event SET actor = 'mallory-id' WHERE chain_pos = 2");
        await client.query('COMMIT');
      } finally {
        client.release();
      }
    });
    const { code, lines } = await cli(['audit', 'verify'], url);
    expect(lines).toEqual(['failed chain_pos=2 reason=hash_mismatch']);
    expect(code).toBe(1);
  });

  it('AUD-5 a database error prints a fixed message with no detail and exits 1', async () => {
    const empty = await postgres.createDatabase();
    const { code, lines } = await cli(['audit', 'verify'], empty);
    expect(code).toBe(1);
    expect(lines).toEqual(['audit verification could not run']);
  });
});

describe('AUD-7 mandate audit retention', () => {
  it('AUD-5 AUD-7 audit verify --archive checks a retention archive', async () => {
    const url = await freshDatabase();
    const dir = await mkdtemp(join(archiveDir, 'ok-'));
    await seedSealed(url, 5, 3);
    // Applied after sealing, so the config.apply row stays outside the sealed prefix.
    await activate(url, AUDIT_CONFIG);
    const run = await cli(['audit', 'retention', '--now'], url, { MANDATE_AUDIT_ARCHIVE_DIR: dir });
    expect(run.lines).toEqual(['archived first=1 last=5 count=5 archive=audit-1-5.jsonl']);
    expect(run.code).toBe(0);

    const verified = await cli(['audit', 'verify', '--archive', join(dir, 'audit-1-5.jsonl')], url);
    expect(verified.lines).toEqual(['ok archive count=5 first=1 last=5']);
    expect(verified.code).toBe(0);

    const missing = await cli(['audit', 'verify', '--archive', join(dir, 'audit-9-9.jsonl')], url);
    expect(missing.code).toBe(1);
    expect(missing.lines).toHaveLength(1);
    expect(missing.lines[0]).toMatch(/^failed archive reason=/);
  });

  it('AUD-7 audit retention --now exits 0 when nothing is due and 1 when the archive directory is missing', async () => {
    const url = await freshDatabase();
    await seedSealed(url, 2, 0);
    await activate(url, AUDIT_CONFIG);
    const none = await cli(['audit', 'retention', '--now'], url, { MANDATE_AUDIT_ARCHIVE_DIR: archiveDir });
    expect(none.lines).toEqual(['nothing due']);
    expect(none.code).toBe(0);

    await seedSealed(url, 2, 3);
    const refused = await cli(['audit', 'retention', '--now'], url, { MANDATE_AUDIT_ARCHIVE_DIR: join(archiveDir, 'does-not-exist') });
    expect(refused.lines).toEqual(['refused reason=archive_unavailable']);
    expect(refused.code).toBe(1);
  });

  it('AUD-7 CFG-3 audit retention --now without audit.retention_days in the active revision says so, whatever MANDATE_CONFIG_DIR holds', async () => {
    const url = await freshDatabase();
    await seedSealed(url, 2, 3);
    await activate(url, await withoutRetention());
    const { code, lines } = await cli(['audit', 'retention', '--now'], url, { MANDATE_CONFIG_DIR: AUDIT_CONFIG, MANDATE_AUDIT_ARCHIVE_DIR: archiveDir });
    expect(lines).toEqual(['nothing due (audit.retention_days is not set)']);
    expect(code).toBe(0);
    expect(await auditCount(url)).toBe(2);
  });

  it('AUD-7 CFG-3 audit retention --now applies the active revision retention_days even when MANDATE_CONFIG_DIR has none', async () => {
    const url = await freshDatabase();
    const dir = await mkdtemp(join(archiveDir, 'active-'));
    await seedSealed(url, 2, 3);
    await activate(url, AUDIT_CONFIG);
    const { code, lines } = await cli(['audit', 'retention', '--now'], url, { MANDATE_CONFIG_DIR: await withoutRetention(), MANDATE_AUDIT_ARCHIVE_DIR: dir });
    expect(lines).toEqual(['archived first=1 last=2 count=2 archive=audit-1-2.jsonl']);
    expect(code).toBe(0);
    expect(await auditCount(url)).toBe(0);
  });

  it('AUD-7 CFG-3 audit retention --now without an active revision exits 2 and deletes nothing', async () => {
    const url = await freshDatabase();
    await seedSealed(url, 2, 3);
    const { code, lines } = await cli(['audit', 'retention', '--now'], url, { MANDATE_CONFIG_DIR: AUDIT_CONFIG, MANDATE_AUDIT_ARCHIVE_DIR: archiveDir });
    expect(lines).toEqual(['no active configuration: start the api once or run mandate config apply']);
    expect(code).toBe(2);
    expect(await auditCount(url)).toBe(2);
  });
});

describe('AUD-5 usage', () => {
  it('AUD-5 usage errors exit 2', async () => {
    const url = await freshDatabase();
    for (const argv of [['audit'], ['audit', 'verify', '--archive'], ['audit', 'retention'], ['audit', 'verify', 'extra'], ['audit', 'retention', '--now', 'x']]) {
      const { code, lines } = await cli(argv, url);
      expect(code, argv.join(' ')).toBe(2);
      expect(lines.join('\n')).toContain('mandate audit verify [--archive <file>]');
    }
  });
});
