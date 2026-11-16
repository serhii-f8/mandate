import { asc } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startPostgres, type StartedPostgres } from '@aiops/testing';
import { DrizzleAuditLog } from '../../src/audit-log.js';
import { createDb, type Database } from '../../src/client.js';
import { runMigrations } from '../../src/migrate.js';
import { auditEvent } from '../../src/schema.js';

let postgres: StartedPostgres;
let database: Database;

beforeAll(async () => {
  postgres = await startPostgres();
  const url = await postgres.createDatabase();
  await runMigrations(url);
  database = createDb(url, { onError: () => undefined });
});

afterAll(async () => {
  await database.close();
  await postgres.stop();
});

describe('AUD-1 audit base schema', () => {
  it('stores appended events in order with every field', async () => {
    const log = new DrizzleAuditLog(database.db);
    await log.append({
      id: '00000000-0000-4000-8000-0000000000a1',
      actor: 'anonymous',
      action: 'tool.call',
      subject: 'ping',
      outcome: 'ok',
      correlationId: 'corr-a',
      details: { durationMs: 2 },
    });
    await log.append({
      id: '00000000-0000-4000-8000-0000000000a2',
      actor: 'alice',
      clientId: 'claude-ai',
      action: 'tool.call',
      subject: 'ping',
      decision: 'allow',
      outcome: 'error',
      correlationId: 'corr-b',
      changesetId: '00000000-0000-4000-8000-0000000000c1',
      details: { durationMs: 5, errorCode: 'handler_failed' },
    });

    const rows = await database.db.select().from(auditEvent).orderBy(asc(auditEvent.seq));
    expect(rows).toHaveLength(2);
    const [first, second] = rows;
    expect(first).toMatchObject({
      id: '00000000-0000-4000-8000-0000000000a1',
      actor: 'anonymous',
      clientId: null,
      action: 'tool.call',
      subject: 'ping',
      decision: null,
      outcome: 'ok',
      correlationId: 'corr-a',
      changesetId: null,
      details: { durationMs: 2 },
      prevHash: null,
      hash: null,
    });
    expect(first?.ts).toBeInstanceOf(Date);
    expect(second).toMatchObject({
      clientId: 'claude-ai',
      decision: 'allow',
      changesetId: '00000000-0000-4000-8000-0000000000c1',
    });
    expect(Number(second?.seq)).toBeGreaterThan(Number(first?.seq));
  });

  describe('AUD-3 audit_event is append-only', () => {
    it.each([
      ["UPDATE audit_event SET actor = 'mallory'"],
      ['DELETE FROM audit_event'],
      ['TRUNCATE audit_event'],
    ])('rejects %s', async (statement) => {
      await expect(database.pool.query(statement)).rejects.toThrow(/append-only/);
    });
  });
});
