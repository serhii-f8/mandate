import { asc, eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AuditRedactionError } from '@aiops/core';
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

  it('SEC-3 a failing append reports a fixed message without parameter values', async () => {
    const log = new DrizzleAuditLog(database.db);
    const event = {
      id: '00000000-0000-4000-8000-0000000000d1',
      actor: 'secret-actor-value',
      action: 'policy.decision' as const,
      outcome: 'denied' as const,
      correlationId: 'secret-correlation-value',
      details: { rule: 'secret-detail-value' },
    };
    await log.append(event);
    let error: unknown;
    try {
      await log.append(event);
    } catch (e) {
      error = e;
    }
    expect(error).toBeInstanceOf(Error);
    const failure = error as Error & { code?: string };
    expect(failure.message).toBe('audit append failed (sqlstate 23505)');
    expect(failure.code).toBe('23505');
    expect(failure.cause).toBeUndefined();
    const text = `${failure.message} ${String(failure.stack)} ${JSON.stringify(failure)}`;
    for (const value of ['secret-actor-value', 'secret-correlation-value', 'secret-detail-value', event.id]) {
      expect(text).not.toContain(value);
    }
  });
});

describe('AUD-4 audit details are redacted before insert', () => {
  it('AUD-4 an appended row carries redacted details, with the configured sensitive keys', async () => {
    const log = new DrizzleAuditLog(database.db, { sensitiveKeys: () => new Set(['cost']) });
    const id = '00000000-0000-4000-8000-0000000000e1';
    await log.append({
      id,
      actor: 'alice',
      action: 'tool.call',
      outcome: 'ok',
      correlationId: 'corr-e1',
      details: { token: 't', nested: { cost: 5 }, auth: 'Bearer x', count: 2 },
    });
    const [row] = await database.db.select().from(auditEvent).where(eq(auditEvent.id, id));
    expect(row?.details).toEqual({ token: '[redacted]', nested: { cost: '[redacted]' }, auth: '[redacted]', count: 2 });
  });

  it('AUD-4 without configured keys the key pattern and value shapes still apply', async () => {
    const log = new DrizzleAuditLog(database.db);
    const id = '00000000-0000-4000-8000-0000000000e2';
    await log.append({ id, actor: 'alice', action: 'tool.call', outcome: 'ok', correlationId: 'corr-e2', details: { password: 'p', cost: 5 } });
    const [row] = await database.db.select().from(auditEvent).where(eq(auditEvent.id, id));
    expect(row?.details).toEqual({ password: '[redacted]', cost: 5 });
  });

  it('AUD-4 reads the sensitive keys on every append, so a reload applies', async () => {
    let keys: ReadonlySet<string> = new Set();
    const log = new DrizzleAuditLog(database.db, { sensitiveKeys: () => keys });
    const before = '00000000-0000-4000-8000-0000000000e3';
    const after = '00000000-0000-4000-8000-0000000000e5';
    await log.append({ id: before, actor: 'alice', action: 'tool.call', outcome: 'ok', correlationId: 'corr-e3', details: { sku: 'A-1' } });
    keys = new Set(['sku']);
    await log.append({ id: after, actor: 'alice', action: 'tool.call', outcome: 'ok', correlationId: 'corr-e5', details: { sku: 'A-1' } });
    const [first] = await database.db.select().from(auditEvent).where(eq(auditEvent.id, before));
    const [second] = await database.db.select().from(auditEvent).where(eq(auditEvent.id, after));
    expect(first?.details).toEqual({ sku: 'A-1' });
    expect(second?.details).toEqual({ sku: '[redacted]' });
  });

  it('AUD-4 details that cannot be redacted fail closed: AuditRedactionError and no row', async () => {
    const log = new DrizzleAuditLog(database.db);
    const id = '00000000-0000-4000-8000-0000000000e4';
    const details: Record<string, unknown> = { note: 'secret-cyclic-value' };
    details.self = details;
    const failure = await log
      .append({ id, actor: 'alice', action: 'tool.call', outcome: 'ok', correlationId: 'corr-e4', details })
      .then(() => undefined, (error: unknown) => error);
    expect(failure).toBeInstanceOf(AuditRedactionError);
    expect((failure as Error).message).not.toContain('secret-cyclic-value');
    expect(await database.db.select().from(auditEvent).where(eq(auditEvent.id, id))).toHaveLength(0);
  });
});
