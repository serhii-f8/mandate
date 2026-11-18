import { randomUUID } from 'node:crypto';
import { asc, eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { AuditEventInput } from '@aiops/core';
import { describeNotificationOutboxContract, startPostgres, type StartedPostgres } from '@aiops/testing';
import { PostgresChangeSetRepository } from '../../src/changeset-repository.js';
import { createDb, type Database } from '../../src/client.js';
import { runMigrations } from '../../src/migrate.js';
import { insertNotifications, PostgresNotificationOutbox } from '../../src/notification-outbox.js';
import { auditEvent } from '../../src/schema.js';

let postgres: StartedPostgres;
let shared: Database;

beforeAll(async () => {
  postgres = await startPostgres();
  const url = await postgres.createDatabase();
  await runMigrations(url);
  shared = createDb(url, { onError: () => undefined });
});

afterAll(async () => {
  await shared.close();
  await postgres.stop();
});

async function auditOf(database: Database, changesetId: string): Promise<AuditEventInput[]> {
  const rows = await database.db
    .select()
    .from(auditEvent)
    .where(eq(auditEvent.changesetId, changesetId))
    .orderBy(asc(auditEvent.seq));
  return rows
    .filter((r) => r.action.startsWith('notification.'))
    .map((r) => ({
      id: r.id,
      actor: r.actor,
      action: r.action as AuditEventInput['action'],
      ...(r.subject === null ? {} : { subject: r.subject }),
      outcome: r.outcome as AuditEventInput['outcome'],
      correlationId: r.correlationId,
      ...(r.changesetId === null ? {} : { changesetId: r.changesetId }),
      details: r.details,
    }));
}

async function newChangeSet(database: Database): Promise<string> {
  const id = randomUUID();
  await new PostgresChangeSetRepository(database.db).create(
    {
      id,
      operation: 'catalog.update',
      connection: 'shop',
      requester: 'alice',
      args: {},
      configHash: 'cfg',
      correlationId: 'corr-n',
      createdAt: new Date('2026-03-01T00:00:00.000Z'),
      expiresAt: new Date('2026-03-02T00:00:00.000Z'),
    },
    {
      id: randomUUID(),
      actor: 'alice',
      action: 'changeset.transition',
      outcome: 'ok',
      correlationId: 'corr-n',
      changesetId: id,
      details: {},
    },
  );
  return id;
}

// Claims are global: every case gets a database of its own.
describeNotificationOutboxContract('postgres', async () => {
  const url = await postgres.createDatabase();
  await runMigrations(url);
  const database = createDb(url, { onError: () => undefined });
  return {
    outbox: new PostgresNotificationOutbox(database.db),
    seed: async (notifications, at) => {
      const id = await newChangeSet(database);
      await insertNotifications(database.db, id, notifications, at);
      return id;
    },
    seedInto: (changesetId, notifications, at) => insertNotifications(database.db, changesetId, notifications, at),
    auditEvents: (changesetId) => auditOf(database, changesetId),
    close: () => database.close(),
  };
});

describe('NTF-3 notification_outbox constraints', () => {
  it('NTF-3 the table refuses unknown kinds and states', async () => {
    const id = await newChangeSet(shared);
    const insert = (kind: string, state: string): Promise<unknown> =>
      shared.pool.query(
        `INSERT INTO notification_outbox (id, kind, changeset_id, round, step, target, state, next_attempt_at, created_at)
         VALUES ($1, $2, $3, 1, 1, 'chat', $4, now(), now())`,
        [randomUUID(), kind, id, state],
      );
    await expect(insert('other', 'pending')).rejects.toThrow(/notification_outbox_kind_check/);
    await expect(insert('approval_requested', 'other')).rejects.toThrow(/notification_outbox_state_check/);
    await expect(insert('approval_requested', 'pending')).resolves.toBeDefined();
  });

  it('NTF-3 a row needs an existing change-set', async () => {
    await expect(
      insertNotifications(shared.db, randomUUID(), [{ kind: 'approval_requested', round: 1, step: 1, target: 'chat' }], new Date()),
    ).rejects.toThrow(/sqlstate 23503/);
  });

  it('NTF-3 insertNotifications with no rows does nothing', async () => {
    await expect(insertNotifications(shared.db, 'not-a-uuid', [], new Date())).resolves.toBeUndefined();
  });

  it('SEC-3 an outbox failure throws a fixed message without the target', async () => {
    const message = await insertNotifications(
      shared.db,
      randomUUID(),
      [{ kind: 'approval_requested', round: 1, step: 1, target: 'secret-target-91' }],
      new Date(),
    ).then(
      () => '',
      (error: unknown) => (error instanceof Error ? error.message : String(error)),
    );
    expect(message).toMatch(/sqlstate 23503/);
    expect(message).not.toContain('secret-target-91');
  });

  it('NFR-4 a claim skips the rows another dispatcher holds instead of waiting', async () => {
    const url = await postgres.createDatabase();
    await runMigrations(url);
    const database = createDb(url, { onError: () => undefined });
    const holder = await database.pool.connect();
    try {
      const id = await newChangeSet(database);
      const at = new Date('2026-03-01T00:00:00.000Z');
      await insertNotifications(
        database.db,
        id,
        Array.from({ length: 6 }, (_, i) => ({ kind: 'approval_requested' as const, round: 1, step: 1, target: `t-${String(i)}` })),
        at,
      );
      await holder.query('BEGIN');
      const held = await holder.query<{ id: string }>(
        `SELECT id FROM notification_outbox WHERE target IN ('t-0', 't-1') FOR UPDATE`,
      );
      expect(held.rowCount).toBe(2);
      const outbox = new PostgresNotificationOutbox(database.db);
      const free = await outbox.claim({ now: at, limit: 20, leaseMs: 120_000 });
      expect(free.map((r) => r.target).sort()).toEqual(['t-2', 't-3', 't-4', 't-5']);
      await holder.query('COMMIT');
      const rest = await outbox.claim({ now: at, limit: 20, leaseMs: 120_000 });
      expect(rest.map((r) => r.target).sort()).toEqual(['t-0', 't-1']);
    } finally {
      await holder.query('ROLLBACK').catch(() => undefined);
      holder.release();
      await database.close();
    }
  });
});
