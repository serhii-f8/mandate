// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Mandate Authors
import { readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startPostgres, type StartedPostgres } from '@mandate/testing';
import { assertMigrated, migrationState, runMigrations } from '../../src/migrate.js';

const migrationFiles = readdirSync(fileURLToPath(new URL('../../migrations/', import.meta.url))).filter((f) =>
  f.endsWith('.sql'),
);

let postgres: StartedPostgres;

beforeAll(async () => {
  postgres = await startPostgres();
});

afterAll(async () => {
  await postgres.stop();
});

async function query<T extends pg.QueryResultRow>(url: string, sql: string): Promise<T[]> {
  const client = new pg.Client({ connectionString: url });
  await client.connect();
  try {
    return (await client.query<T>(sql)).rows;
  } finally {
    await client.end();
  }
}

describe('NFR-4 assertMigrated', () => {
  it('NFR-4 assertMigrated refuses a database without migrations and accepts a migrated one', async () => {
    const url = await postgres.createDatabase();
    await expect(assertMigrated(url)).rejects.toThrow(
      `database schema is not migrated (applied 0 of ${migrationFiles.length}); start api first`,
    );
    expect(await migrationState(url)).toEqual({ applied: 0, expected: migrationFiles.length });
    await runMigrations(url);
    await expect(assertMigrated(url)).resolves.toBeUndefined();
    expect(await migrationState(url)).toEqual({ applied: migrationFiles.length, expected: migrationFiles.length });
  });
});

describe('NFR-5 migrations run on start', () => {
  it('apply every migration to a fresh database and create audit_event', async () => {
    const url = await postgres.createDatabase();
    expect(migrationFiles.length).toBeGreaterThanOrEqual(2);
    expect(await runMigrations(url)).toEqual({ applied: migrationFiles.length });
    const tables = await query<{ table_name: string }>(
      url,
      "select table_name from information_schema.tables where table_schema = 'public'",
    );
    expect(tables.map((t) => t.table_name)).toContain('audit_event');
  });

  it('are a no-op when run again', async () => {
    const url = await postgres.createDatabase();
    await runMigrations(url);
    expect(await runMigrations(url)).toEqual({ applied: 0 });
  });

  it('NFR-5 concurrent runMigrations on one database apply each migration exactly once', async () => {
    const url = await postgres.createDatabase();
    const results = await Promise.all([runMigrations(url), runMigrations(url), runMigrations(url)]);
    expect(results.reduce((sum, r) => sum + r.applied, 0)).toBe(migrationFiles.length);
    const rows = await query<{ hash: string }>(url, 'select hash from drizzle.__drizzle_migrations');
    expect(rows).toHaveLength(migrationFiles.length);
    expect(new Set(rows.map((r) => r.hash)).size).toBe(migrationFiles.length);
  });
});
