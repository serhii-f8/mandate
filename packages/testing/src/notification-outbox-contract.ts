import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  notificationAuditEvent,
  type AuditEventInput,
  type NewNotification,
  type NotificationOutbox,
  type NotificationRow,
} from '@aiops/core';

export interface NotificationOutboxHarness {
  readonly outbox: NotificationOutbox;
  /** Creates a change-set of its own and stores `notifications` for it at `at`; returns the change-set ID. */
  seed(notifications: readonly NewNotification[], at: Date): Promise<string>;
  /** Stores `notifications` for an existing change-set (the producer insert, ON CONFLICT DO NOTHING). */
  seedInto(changesetId: string, notifications: readonly NewNotification[], at: Date): Promise<void>;
  auditEvents(changesetId: string): Promise<readonly AuditEventInput[]>;
  readonly close?: () => Promise<void>;
}

const T0 = new Date('2026-03-01T00:00:00.000Z');
const LEASE = 120_000;

function plus(ms: number): Date {
  return new Date(T0.getTime() + ms);
}

function requested(target: string): NewNotification {
  return { kind: 'approval_requested', round: 1, step: 1, target };
}

function audit(row: NotificationRow, outcome: 'sent' | 'failed', error?: 'http_status'): AuditEventInput {
  return notificationAuditEvent({
    id: randomUUID(),
    row,
    outcome,
    ...(error === undefined ? {} : { error }),
    correlationId: 'corr-n',
  });
}

/**
 * Behavior every NotificationOutbox implementation must have (NTF-3, NFR-4). A PostgreSQL harness
 * must give every case an outbox of its own: claims are global, not per change-set.
 */
export function describeNotificationOutboxContract(label: string, setup: () => Promise<NotificationOutboxHarness>): void {
  describe(`${label} NTF-3 NFR-4 notification outbox`, () => {
    async function withOutbox(body: (h: NotificationOutboxHarness) => Promise<void>): Promise<void> {
      const h = await setup();
      try {
        await body(h);
      } finally {
        await h.close?.();
      }
    }

    async function only(rows: readonly NotificationRow[]): Promise<NotificationRow> {
      expect(rows).toHaveLength(1);
      const [row] = rows;
      if (row === undefined) throw new Error('expected one row');
      return Promise.resolve(row);
    }

    it('NTF-3 claim leases a due row for 2 minutes and counts the attempt', async () =>
      withOutbox(async (h) => {
        const changesetId = await h.seed([requested('chat')], T0);
        const row = await only(await h.outbox.claim({ now: T0, limit: 20, leaseMs: LEASE }));
        expect(row).toMatchObject({ changesetId, kind: 'approval_requested', round: 1, step: 1, target: 'chat' });
        expect(row.state).toBe('pending');
        expect(row.attempts).toBe(1);
        expect(row.nextAttemptAt.getTime()).toBe(T0.getTime() + LEASE);
        expect(await h.outbox.claim({ now: plus(LEASE - 1), limit: 20, leaseMs: LEASE })).toEqual([]);
        const again = await only(await h.outbox.claim({ now: plus(LEASE), limit: 20, leaseMs: LEASE }));
        expect(again.id).toBe(row.id);
        expect(again.attempts).toBe(2);
        expect(again.nextAttemptAt.getTime()).toBe(T0.getTime() + 2 * LEASE);
      }));

    it('NTF-3 claim skips rows that are not due, sent or failed', async () =>
      withOutbox(async (h) => {
        const changesetId = await h.seed([requested('a'), requested('b'), requested('c')], T0);
        await h.seedInto(changesetId, [requested('d')], plus(3_600_000));
        const claimed = await h.outbox.claim({ now: T0, limit: 20, leaseMs: LEASE });
        expect(claimed.map((r) => r.target).sort()).toEqual(['a', 'b', 'c']);
        const [a, b, c] = await Promise.all(['a', 'b', 'c'].map((t) => only(claimed.filter((r) => r.target === t))));
        if (a === undefined || b === undefined || c === undefined) throw new Error('missing rows');
        expect(await h.outbox.markSent({ id: a.id, attempt: 1, now: T0, audit: audit(a, 'sent') })).toBe(true);
        expect(await h.outbox.markFailed({ id: b.id, attempt: 1, error: 'http_status', audit: audit(b, 'failed', 'http_status') })).toBe(true);
        expect(await h.outbox.markRetry({ id: c.id, attempt: 1, error: 'timeout', nextAttemptAt: plus(600_000) })).toBe(true);
        expect(await h.outbox.claim({ now: plus(LEASE), limit: 20, leaseMs: LEASE })).toEqual([]);
        const due = await only(await h.outbox.claim({ now: plus(600_000), limit: 20, leaseMs: LEASE }));
        expect(due.target).toBe('c');
        expect(due.attempts).toBe(2);
      }));

    it('NTF-3 claim takes the oldest due rows first, at most limit', async () =>
      withOutbox(async (h) => {
        const changesetId = await h.seed([requested('late')], plus(2_000));
        await h.seedInto(changesetId, [requested('early')], plus(1_000));
        await h.seedInto(changesetId, [requested('earliest')], T0);
        const first = await h.outbox.claim({ now: plus(5_000), limit: 2, leaseMs: LEASE });
        // Claimed rows share the leased next_attempt_at, so they come back ordered by ID.
        expect(first.map((r) => r.target).sort()).toEqual(['earliest', 'early'].sort());
        expect(first.map((r) => r.id)).toEqual(first.map((r) => r.id).sort());
        const rest = await only(await h.outbox.claim({ now: plus(5_000), limit: 2, leaseMs: LEASE }));
        expect(rest.target).toBe('late');
      }));

    it('NFR-4 two concurrent claims never return the same row', async () =>
      withOutbox(async (h) => {
        await h.seed(
          Array.from({ length: 30 }, (_, i) => requested(`t-${String(i).padStart(2, '0')}`)),
          T0,
        );
        const [x, y] = await Promise.all([
          h.outbox.claim({ now: T0, limit: 20, leaseMs: LEASE }),
          h.outbox.claim({ now: T0, limit: 20, leaseMs: LEASE }),
        ]);
        const xs = new Set(x.map((r) => r.id));
        const ys = new Set(y.map((r) => r.id));
        expect([...xs].filter((id) => ys.has(id))).toEqual([]);
        expect(new Set([...xs, ...ys]).size).toBe(30);
        expect([...x, ...y].every((r) => r.attempts === 1)).toBe(true);
      }));

    it('NTF-3 marks are fenced by the attempt', async () =>
      withOutbox(async (h) => {
        const changesetId = await h.seed([requested('chat')], T0);
        await only(await h.outbox.claim({ now: T0, limit: 20, leaseMs: LEASE }));
        const second = await only(await h.outbox.claim({ now: plus(LEASE), limit: 20, leaseMs: LEASE }));
        expect(second.attempts).toBe(2);
        expect(await h.outbox.markSent({ id: second.id, attempt: 1, now: plus(LEASE), audit: audit(second, 'sent') })).toBe(false);
        expect(await h.outbox.markRetry({ id: second.id, attempt: 1, error: 'timeout', nextAttemptAt: plus(LEASE) })).toBe(false);
        expect(await h.outbox.markFailed({ id: second.id, attempt: 1, error: 'timeout', audit: audit(second, 'failed') })).toBe(false);
        expect(await h.outbox.markSent({ id: second.id, attempt: 2, now: plus(LEASE + 5), audit: audit(second, 'sent') })).toBe(true);
        const [stored] = await h.outbox.listFor(changesetId);
        expect(stored?.state).toBe('sent');
        expect(stored?.sentAt?.getTime()).toBe(T0.getTime() + LEASE + 5);
        expect(stored?.lastError).toBeUndefined();
        const events = await h.auditEvents(changesetId);
        expect(events.map((e) => e.action)).toEqual(['notification.sent']);
        expect(await h.outbox.markSent({ id: second.id, attempt: 2, now: plus(LEASE + 6), audit: audit(second, 'sent') })).toBe(false);
        expect(await h.auditEvents(changesetId)).toHaveLength(1);
      }));

    it('NTF-3 markRetry keeps the row pending with the error code and the next attempt time', async () =>
      withOutbox(async (h) => {
        const changesetId = await h.seed([requested('chat')], T0);
        const row = await only(await h.outbox.claim({ now: T0, limit: 20, leaseMs: LEASE }));
        expect(await h.outbox.markRetry({ id: row.id, attempt: 1, error: 'network', nextAttemptAt: plus(30_000) })).toBe(true);
        const [stored] = await h.outbox.listFor(changesetId);
        expect(stored).toMatchObject({ state: 'pending', attempts: 1, lastError: 'network' });
        expect(stored?.nextAttemptAt.getTime()).toBe(T0.getTime() + 30_000);
        expect(stored?.sentAt).toBeUndefined();
        expect(await h.auditEvents(changesetId)).toEqual([]);
        expect(await h.outbox.claim({ now: plus(29_999), limit: 20, leaseMs: LEASE })).toEqual([]);
        const next = await only(await h.outbox.claim({ now: plus(30_000), limit: 20, leaseMs: LEASE }));
        expect(next.attempts).toBe(2);
        expect(next.lastError).toBe('network');
        expect(await h.outbox.markSent({ id: next.id, attempt: 2, now: plus(30_001), audit: audit(next, 'sent') })).toBe(true);
        const [sent] = await h.outbox.listFor(changesetId);
        expect(sent?.lastError).toBeUndefined();
      }));

    it('AUD-1 markFailed sets failed and appends notification.failed once', async () =>
      withOutbox(async (h) => {
        const changesetId = await h.seed([requested('chat')], T0);
        const row = await only(await h.outbox.claim({ now: T0, limit: 20, leaseMs: LEASE }));
        expect(await h.outbox.markFailed({ id: row.id, attempt: 1, error: 'http_status', audit: audit(row, 'failed', 'http_status') })).toBe(true);
        const [stored] = await h.outbox.listFor(changesetId);
        expect(stored).toMatchObject({ state: 'failed', attempts: 1, lastError: 'http_status' });
        expect(stored?.sentAt).toBeUndefined();
        expect(await h.outbox.markFailed({ id: row.id, attempt: 1, error: 'http_status', audit: audit(row, 'failed', 'http_status') })).toBe(false);
        const events = await h.auditEvents(changesetId);
        expect(events).toHaveLength(1);
        expect(events[0]).toMatchObject({
          action: 'notification.failed',
          actor: 'system',
          subject: 'chat',
          outcome: 'error',
          changesetId,
          details: { kind: 'approval_requested', target: 'chat', attempts: 1, error: 'http_status' },
        });
      }));

    it('NTF-3 the same producer key is stored once', async () =>
      withOutbox(async (h) => {
        const changesetId = await h.seed([], T0);
        const rows = [requested('chat'), { kind: 'approval_requested' as const, round: 1, step: 2, target: 'chat' }];
        await h.seedInto(changesetId, rows, T0);
        await h.seedInto(changesetId, rows, plus(1_000));
        const stored = await h.outbox.listFor(changesetId);
        expect(stored.map((r) => [r.step, r.target, r.createdAt.getTime()])).toEqual([
          [1, 'chat', T0.getTime()],
          [2, 'chat', T0.getTime()],
        ]);
        expect(stored.every((r) => r.state === 'pending' && r.attempts === 0)).toBe(true);
      }));

    it('NTF-3 malformed identifiers are not found, never an error', async () =>
      withOutbox(async (h) => {
        expect(await h.outbox.listFor('not-a-uuid')).toEqual([]);
        expect(await h.outbox.listFor(randomUUID())).toEqual([]);
        expect(await h.outbox.markRetry({ id: 'not-a-uuid', attempt: 1, error: 'timeout', nextAttemptAt: T0 })).toBe(false);
        expect(await h.outbox.markRetry({ id: randomUUID(), attempt: 1, error: 'timeout', nextAttemptAt: T0 })).toBe(false);
      }));
  });
}
