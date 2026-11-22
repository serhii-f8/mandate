// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Mandate Authors
import { randomUUID } from 'node:crypto';
import { and, asc, eq, inArray, lte, sql } from 'drizzle-orm';
import type { PgUpdateSetSource } from 'drizzle-orm/pg-core';
import type {
  AuditEventInput,
  NewNotification,
  NotificationError,
  NotificationOutbox,
  NotificationRow,
} from '@mandate/core';
import { DrizzleAuditLog } from './audit-log.js';
import type { Db, DbExecutor } from './client.js';
import { guarded } from './errors.js';
import { notificationOutbox } from './schema.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

type OutboxRow = typeof notificationOutbox.$inferSelect;

function toRow(r: OutboxRow): NotificationRow {
  return {
    id: r.id,
    kind: r.kind,
    changesetId: r.changesetId,
    round: r.round,
    step: r.step,
    target: r.target,
    state: r.state,
    attempts: r.attempts,
    nextAttemptAt: r.nextAttemptAt,
    ...(r.lastError === null ? {} : { lastError: r.lastError }),
    createdAt: r.createdAt,
    ...(r.sentAt === null ? {} : { sentAt: r.sentAt }),
  };
}

/**
 * The producer insert (NTF-1, NTF-3): called with the transaction of the event the rows announce,
 * so they commit or roll back with it. A producer retried with the same key inserts nothing.
 */
export async function insertNotifications(
  db: Db | DbExecutor,
  changesetId: string,
  notifications: readonly NewNotification[],
  at: Date,
): Promise<void> {
  if (notifications.length === 0) return;
  await guarded('notification insert', async () => {
    await db
      .insert(notificationOutbox)
      .values(
        notifications.map((n) => ({
          id: randomUUID(),
          kind: n.kind,
          changesetId,
          round: n.round,
          step: n.step,
          target: n.target,
          nextAttemptAt: at,
          createdAt: at,
        })),
      )
      .onConflictDoNothing({
        target: [
          notificationOutbox.changesetId,
          notificationOutbox.kind,
          notificationOutbox.round,
          notificationOutbox.step,
          notificationOutbox.target,
        ],
      });
  });
}

/**
 * PostgreSQL implementation of the core `NotificationOutbox` port (NTF-3, NFR-4). A claim is one
 * statement over `FOR UPDATE SKIP LOCKED`, so concurrent dispatchers never claim the same row; each
 * mark is fenced by the claimed attempt and `state = 'pending'`, so a dispatcher whose lease ran out
 * cannot overwrite the outcome of the one that re-claimed the row.
 */
export class PostgresNotificationOutbox implements NotificationOutbox {
  constructor(private readonly db: Db) {}

  async claim(req: { now: Date; limit: number; leaseMs: number }): Promise<readonly NotificationRow[]> {
    if (req.limit <= 0) return [];
    const due = this.db
      .select({ id: notificationOutbox.id })
      .from(notificationOutbox)
      .where(and(eq(notificationOutbox.state, 'pending'), lte(notificationOutbox.nextAttemptAt, req.now)))
      .orderBy(asc(notificationOutbox.nextAttemptAt), asc(notificationOutbox.id))
      .limit(req.limit)
      .for('update', { skipLocked: true });
    const rows = await guarded('notification claim', () =>
      this.db
        .update(notificationOutbox)
        .set({
          attempts: sql`${notificationOutbox.attempts} + 1`,
          nextAttemptAt: new Date(req.now.getTime() + req.leaseMs),
        })
        .where(inArray(notificationOutbox.id, due))
        .returning(),
    );
    // RETURNING has no order: sort as the claim chose them.
    return rows
      .map(toRow)
      .sort((a, b) => a.nextAttemptAt.getTime() - b.nextAttemptAt.getTime() || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  }

  markSent(req: { id: string; attempt: number; now: Date; audit: AuditEventInput }): Promise<boolean> {
    return this.finish(req.id, req.attempt, { state: 'sent', sentAt: req.now, lastError: null }, req.audit);
  }

  async markRetry(req: { id: string; attempt: number; error: NotificationError; nextAttemptAt: Date }): Promise<boolean> {
    if (!UUID.test(req.id)) return false;
    const rows = await guarded('notification retry', () =>
      this.db
        .update(notificationOutbox)
        .set({ lastError: req.error, nextAttemptAt: req.nextAttemptAt })
        .where(this.fence(req.id, req.attempt))
        .returning({ id: notificationOutbox.id }),
    );
    return rows.length === 1;
  }

  markFailed(req: { id: string; attempt: number; error: NotificationError; audit: AuditEventInput }): Promise<boolean> {
    return this.finish(req.id, req.attempt, { state: 'failed', lastError: req.error }, req.audit);
  }

  async listFor(changesetId: string): Promise<readonly NotificationRow[]> {
    if (!UUID.test(changesetId)) return [];
    const rows = await guarded('notification read', () =>
      this.db
        .select()
        .from(notificationOutbox)
        .where(eq(notificationOutbox.changesetId, changesetId))
        .orderBy(
          asc(notificationOutbox.createdAt),
          // Code-point order, as the in-memory outbox compares strings.
          sql`${notificationOutbox.kind} COLLATE "C"`,
          asc(notificationOutbox.step),
          sql`${notificationOutbox.target} COLLATE "C"`,
        ),
    );
    return rows.map(toRow);
  }

  private fence(id: string, attempt: number): ReturnType<typeof and> {
    return and(
      eq(notificationOutbox.id, id),
      eq(notificationOutbox.attempts, attempt),
      eq(notificationOutbox.state, 'pending'),
    );
  }

  /** The final state and its audit event (AUD-1) in one transaction; no audit row when fenced. */
  private async finish(
    id: string,
    attempt: number,
    set: PgUpdateSetSource<typeof notificationOutbox>,
    audit: AuditEventInput,
  ): Promise<boolean> {
    if (!UUID.test(id)) return false;
    return guarded('notification mark', () =>
      this.db.transaction(async (tx) => {
        const rows = await tx
          .update(notificationOutbox)
          .set(set)
          .where(this.fence(id, attempt))
          .returning({ id: notificationOutbox.id });
        if (rows.length !== 1) return false;
        await new DrizzleAuditLog(tx).append(audit);
        return true;
      }),
    );
  }
}
