import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { drizzle } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import pg from 'pg';

/**
 * Advisory-lock key reserved for schema migrations. Nothing else may use it.
 * (ASCII "aiops-mg" as a signed 64-bit integer.)
 */
export const MIGRATION_LOCK_KEY = 0x6169_6f70_732d_6d67n;

/** Committed SQL migrations, shipped next to `dist/` in the package. */
const migrationsFolder = fileURLToPath(new URL('../migrations', import.meta.url));

/**
 * Applies pending forward migrations (NFR-5). Drizzle's migrator takes no lock,
 * so concurrent starts of several instances serialize on a PostgreSQL advisory
 * lock held by this session for the whole run (ADR 0011).
 */
export async function runMigrations(databaseUrl: string): Promise<{ applied: number }> {
  const client = new pg.Client({ connectionString: databaseUrl });
  await client.connect();
  try {
    await client.query('SELECT pg_advisory_lock($1)', [MIGRATION_LOCK_KEY.toString()]);
    try {
      const before = await appliedCount(client);
      await migrate(drizzle(client), { migrationsFolder });
      return { applied: (await appliedCount(client)) - before };
    } finally {
      await client.query('SELECT pg_advisory_unlock($1)', [MIGRATION_LOCK_KEY.toString()]);
    }
  } finally {
    await client.end();
  }
}

/** Migrations applied versus the ones shipped in this build (NFR-4). */
export async function migrationState(databaseUrl: string): Promise<{ applied: number; expected: number }> {
  const journal = JSON.parse(readFileSync(join(migrationsFolder, 'meta', '_journal.json'), 'utf8')) as {
    entries: unknown[];
  };
  const client = new pg.Client({ connectionString: databaseUrl });
  await client.connect();
  try {
    return { applied: await appliedCount(client), expected: journal.entries.length };
  } finally {
    await client.end();
  }
}

/** Refuses to run against a schema older than this build; the api migrates on start (NFR-4, NFR-5). */
export async function assertMigrated(databaseUrl: string): Promise<void> {
  const { applied, expected } = await migrationState(databaseUrl);
  if (applied < expected) {
    throw new Error(`database schema is not migrated (applied ${applied} of ${expected}); start api first`);
  }
}

async function appliedCount(client: pg.Client): Promise<number> {
  const exists = await client.query<{ present: boolean }>(
    "SELECT to_regclass('drizzle.__drizzle_migrations') IS NOT NULL AS present",
  );
  if (exists.rows[0]?.present !== true) return 0;
  const result = await client.query<{ n: string }>('SELECT count(*)::text AS n FROM drizzle.__drizzle_migrations');
  return Number(result.rows[0]?.n ?? '0');
}
