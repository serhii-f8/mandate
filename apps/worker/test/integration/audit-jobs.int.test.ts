// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The AI Operations Layer Authors
import { randomUUID } from 'node:crypto';
import { DrizzleAuditLog, PostgresRateCounter, runAuditRetention, sealAuditChain, verifyAuditChain } from '@aiops/db';
import type { Logger } from 'pino';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createAuditJobs } from '../../src/audit-jobs.js';
import { startTestPostgres, type TestPostgres } from '../support/postgres.js';

let postgres: TestPostgres;

beforeAll(async () => {
  postgres = await startTestPostgres();
});

afterAll(async () => {
  await postgres.stop();
});

const silent: Pick<Logger, 'info' | 'warn' | 'error'> = { info: () => undefined, warn: () => undefined, error: () => undefined };

async function unsealed(): Promise<number> {
  const result = await postgres.database.pool.query<{ n: number }>('SELECT count(*)::int AS n FROM audit_event WHERE chain_pos IS NULL');
  return result.rows[0]?.n ?? -1;
}

describe('AUD-3 worker audit jobs against PostgreSQL', () => {
  it('AUD-3 rows written while the jobs run become sealed', async () => {
    const { pool, db } = postgres.database;
    const audit = new DrizzleAuditLog(db);
    const jobs = createAuditJobs({
      seal: () => sealAuditChain(pool),
      retain: () =>
        runAuditRetention({
          pool,
          audit,
          rateCounter: new PostgresRateCounter(db),
          retentionDays: undefined,
          archiveDir: undefined,
          actor: 'system',
          now: () => new Date(),
          newId: randomUUID,
        }),
      logger: silent,
      sealIntervalMs: 50,
    }).start();
    try {
      for (let n = 1; n <= 20; n += 1) {
        await audit.append({
          id: randomUUID(),
          actor: `actor-${String(n)}`,
          action: 'tool.call',
          subject: 'ping',
          outcome: 'ok',
          correlationId: `corr-${String(n)}`,
          details: { durationMs: n },
        });
      }
      // Waits on observable state: the count of unsealed rows, for at most 30 s.
      const deadline = Date.now() + 30_000;
      while ((await unsealed()) > 0 && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
      expect(await unsealed()).toBe(0);
    } finally {
      await jobs.stop();
    }
    const report = await verifyAuditChain(pool);
    expect(report.ok).toBe(true);
    expect(report).toMatchObject({ ok: true, sealed: 20, unsealed: 0 });
  });
});
