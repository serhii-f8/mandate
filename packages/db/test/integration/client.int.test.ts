import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startPostgres, type StartedPostgres } from '@aiops/testing';
import { DrizzleAuditLog } from '../../src/audit-log.js';
import { createDb } from '../../src/client.js';
import { runMigrations } from '../../src/migrate.js';

let postgres: StartedPostgres;
let url: string;

beforeAll(async () => {
  postgres = await startPostgres();
  url = await postgres.createDatabase();
  await runMigrations(url);
});

afterAll(async () => {
  await postgres.stop();
});

async function terminateOtherBackends(databaseUrl: string): Promise<number> {
  const admin = new pg.Client({ connectionString: databaseUrl });
  await admin.connect();
  try {
    const result = await admin.query(
      'select pg_terminate_backend(pid) from pg_stat_activity where datname = current_database() and pid <> pg_backend_pid()',
    );
    return result.rowCount ?? 0;
  } finally {
    await admin.end();
  }
}

describe('database client survives PostgreSQL dropping its connections', () => {
  it('reports the idle-client error instead of crashing, and recovers on the next query', async () => {
    const errors: string[] = [];
    const database = createDb(url, { onError: (e) => errors.push(e.message) });
    try {
      await database.pool.query('select 1');
      expect(await terminateOtherBackends(url)).toBeGreaterThan(0);
      await expect.poll(() => errors.length, { timeout: 5_000 }).toBeGreaterThan(0);
      // The pool replaces the dead client; the audit log keeps working.
      await new DrizzleAuditLog(database.db).append({
        id: '00000000-0000-4000-8000-0000000000d1',
        actor: 'anonymous',
        action: 'tool.call',
        subject: 'ping',
        outcome: 'ok',
        correlationId: 'after-terminate',
        details: {},
      });
      const rows = await database.pool.query("select count(*)::int as n from audit_event where correlation_id = 'after-terminate'");
      expect(rows.rows[0]).toEqual({ n: 1 });
    } finally {
      await database.close();
    }
  });

  it('fails fast when the database is unreachable', async () => {
    const unreachable = new URL(url);
    unreachable.hostname = '10.255.255.1'; // non-routable: connection attempts hang without a timeout
    const database = createDb(unreachable.toString(), { onError: () => undefined });
    const started = Date.now();
    try {
      await expect(database.pool.query('select 1')).rejects.toThrow();
      expect(Date.now() - started).toBeLessThan(10_000);
    } finally {
      await database.close();
    }
  });
});
