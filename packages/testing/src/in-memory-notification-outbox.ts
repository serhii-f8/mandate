import { randomUUID } from 'node:crypto';
import type {
  AuditEventInput,
  NewNotification,
  NotificationError,
  NotificationOutbox,
  NotificationRow,
} from '@aiops/core';
import { InMemoryAuditLog } from './in-memory-audit-log.js';

function copy(row: NotificationRow): NotificationRow {
  return structuredClone(row);
}

function keyOf(changesetId: string, n: NewNotification): string {
  return JSON.stringify([changesetId, n.kind, n.round, n.step, n.target]);
}

function compareRows(a: NotificationRow, b: NotificationRow): number {
  const byText = (x: string, y: string): number => (x < y ? -1 : x > y ? 1 : 0);
  return a.createdAt.getTime() - b.createdAt.getTime() || byText(a.kind, b.kind) || a.step - b.step || byText(a.target, b.target);
}

function byDue(a: NotificationRow, b: NotificationRow): number {
  return a.nextAttemptAt.getTime() - b.nextAttemptAt.getTime() || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
}

/**
 * In-memory NotificationOutbox for unit tests (NTF-3). Claims are synchronous, so concurrent
 * claims are disjoint; marks are fenced by `attempt` and `state = 'pending'` like PostgreSQL.
 */
export class InMemoryNotificationOutbox implements NotificationOutbox {
  private readonly rows = new Map<string, NotificationRow>();
  private readonly keys = new Set<string>();

  constructor(private readonly audit: InMemoryAuditLog = new InMemoryAuditLog()) {}

  /** The producer insert: one row per `(changeset, kind, round, step, target)`, later duplicates ignored. */
  enqueue(changesetId: string, notifications: readonly NewNotification[], at: Date): void {
    for (const n of notifications) {
      const key = keyOf(changesetId, n);
      if (this.keys.has(key)) continue;
      this.keys.add(key);
      const id = randomUUID();
      this.rows.set(id, {
        id,
        kind: n.kind,
        changesetId,
        round: n.round,
        step: n.step,
        target: n.target,
        state: 'pending',
        attempts: 0,
        nextAttemptAt: new Date(at.getTime()),
        createdAt: new Date(at.getTime()),
      });
    }
  }

  all(): readonly NotificationRow[] {
    return [...this.rows.values()].sort(compareRows).map(copy);
  }

  claim(req: { now: Date; limit: number; leaseMs: number }): Promise<readonly NotificationRow[]> {
    const due = [...this.rows.values()]
      .filter((r) => r.state === 'pending' && r.nextAttemptAt.getTime() <= req.now.getTime())
      .sort(byDue)
      .slice(0, Math.max(0, req.limit));
    // Sorted again after the lease, as PostgreSQL sorts the RETURNING rows.
    const claimed = due.map((r) => {
      const next: NotificationRow = {
        ...r,
        attempts: r.attempts + 1,
        nextAttemptAt: new Date(req.now.getTime() + req.leaseMs),
      };
      this.rows.set(r.id, next);
      return copy(next);
    });
    return Promise.resolve(claimed.sort(byDue));
  }

  markSent(req: { id: string; attempt: number; now: Date; audit: AuditEventInput }): Promise<boolean> {
    return this.finish(req.id, req.attempt, req.audit, (row) => {
      const { lastError: _dropped, ...rest } = row; // eslint-disable-line @typescript-eslint/no-unused-vars -- cleared on success
      return { ...rest, state: 'sent', sentAt: new Date(req.now.getTime()) };
    });
  }

  markRetry(req: { id: string; attempt: number; error: NotificationError; nextAttemptAt: Date }): Promise<boolean> {
    const row = this.fenced(req.id, req.attempt);
    if (row === undefined) return Promise.resolve(false);
    this.rows.set(row.id, { ...row, lastError: req.error, nextAttemptAt: new Date(req.nextAttemptAt.getTime()) });
    return Promise.resolve(true);
  }

  markFailed(req: { id: string; attempt: number; error: NotificationError; audit: AuditEventInput }): Promise<boolean> {
    return this.finish(req.id, req.attempt, req.audit, (row) => ({ ...row, state: 'failed', lastError: req.error }));
  }

  listFor(changesetId: string): Promise<readonly NotificationRow[]> {
    return Promise.resolve(this.all().filter((r) => r.changesetId === changesetId));
  }

  private fenced(id: string, attempt: number): NotificationRow | undefined {
    const row = this.rows.get(id);
    return row?.state === 'pending' && row.attempts === attempt ? row : undefined;
  }

  /** Applies the final state synchronously, then appends the audit event; undoes the change if the append fails. */
  private async finish(
    id: string,
    attempt: number,
    audit: AuditEventInput,
    apply: (row: NotificationRow) => NotificationRow,
  ): Promise<boolean> {
    const row = this.fenced(id, attempt);
    if (row === undefined) return false;
    const next = apply(row);
    this.rows.set(id, next);
    try {
      await this.audit.append(audit);
    } catch (error) {
      if (this.rows.get(id) === next) this.rows.set(id, row);
      throw error;
    }
    return true;
  }
}
