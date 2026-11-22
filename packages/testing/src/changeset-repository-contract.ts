// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Mandate Authors
import { createHash, randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  changesetBatchEvent,
  changesetRollbackBatchEvent,
  changesetVerificationEvent,
  EMPTY_STATS,
  hashStoredItems,
  planCreatedEvent,
  ROLLBACK_REQUEST_MARGIN_MS,
  rollbackRequestEvents,
  startEventFactory,
} from '@mandate/core';
import { recordApproval, submitChangeSet } from './approval-fixtures.js';
import type {
  AuditEventInput,
  BatchSubmission,
  ChangeItemRecord,
  ChangeSetRecord,
  ChangeSetRepository,
  ChangeSetStats,
  ChangeSetStatus,
  CreatePlanRefusal,
  ExecutionLimits,
  ItemOutcome,
  NewChangeSet,
  NewNotification,
  NotificationRow,
  PlanRecord,
  RollbackItemOutcome,
  RollbackRequest,
  VerificationCounts,
} from '@mandate/core';

/**
 * One harness per case from `setup()`, but a PostgreSQL implementation may share one database across
 * all cases and its audit table is append-only. The contract therefore uses fresh UUIDs for every
 * change-set and audit event ID, and never assumes the audit log starts empty: it inspects only
 * events whose `changesetId` is the case's own.
 */
export interface ChangeSetRepositoryHarness {
  readonly repository: ChangeSetRepository;
  readonly auditEvents: () => Promise<readonly AuditEventInput[]>;
  /** Makes the audit append of the next state-changing call fail. */
  readonly failNextAudit: () => void;
  /** Outbox rows of one change-set (NTF-1, NTF-3), ordered by created_at, kind, step, target. */
  readonly notifications: (changesetId: string) => Promise<readonly NotificationRow[]>;
  readonly close?: () => Promise<void>;
}

const NOW = new Date('2026-01-01T00:00:00.000Z');
const LATER = new Date('2026-01-02T00:00:00.000Z');
const HOUR = 3_600_000;
/** Expiry far enough out for the 24-hour window cases. */
const FAR = new Date('2026-02-01T00:00:00.000Z');

function at(hours: number): Date {
  return new Date(NOW.getTime() + hours * HOUR);
}

/** Target IDs t-0001, t-0002, ... */
function targets(n: number): string[] {
  return Array.from({ length: n }, (_, i) => `t-${String(i + 1).padStart(4, '0')}`);
}

/** A requester of its own: a PostgreSQL run shares one database across cases and limits count per requester. */
function requester(name: string): string {
  return `${name}-${randomUUID()}`;
}

function newChangeSet(id: string): NewChangeSet {
  return {
    id,
    operation: 'catalog.update',
    connection: 'shop',
    requester: 'alice',
    args: { sku: 'a' },
    configHash: 'cfg',
    correlationId: 'corr-1',
    createdAt: NOW,
    expiresAt: LATER,
  };
}

function auditEvent(changesetId: string): AuditEventInput {
  return {
    id: randomUUID(),
    actor: 'alice',
    action: 'changeset.transition',
    outcome: 'ok',
    correlationId: 'corr-1',
    changesetId,
    details: {},
  };
}

function item(targetId: string, over: Partial<ChangeItemRecord> = {}): ChangeItemRecord {
  return { targetId, status: 'pending', before: { v: 1 }, after: { v: 2 }, ...over };
}

function stats(over: Partial<ChangeSetStats> = {}): ChangeSetStats {
  return { total: 0, included: 0, excluded: {}, written: 0, failed: 0, skipped: 0, ...over };
}

/** Behavior every ChangeSetRepository implementation must have. */
export function describeChangeSetRepositoryContract(label: string, setup: () => Promise<ChangeSetRepositoryHarness>): void {
  describe(`CS-2 CS-6 change-set repository contract: ${label}`, () => {
    interface Ctx extends ChangeSetRepositoryHarness {
      readonly id: string;
      /** Audit events of this case's change-set only. */
      readonly events: () => Promise<readonly AuditEventInput[]>;
    }

    async function withRepo(body: (c: Ctx) => Promise<void>): Promise<void> {
      const h = await setup();
      const id = randomUUID();
      try {
        await body({
          ...h,
          id,
          events: async () => (await h.auditEvents()).filter((e) => e.changesetId === id),
        });
      } finally {
        await h.close?.();
      }
    }

    async function created(c: Ctx): Promise<void> {
      await c.repository.create(newChangeSet(c.id), auditEvent(c.id));
    }

    async function prepared(c: Ctx): Promise<void> {
      await created(c);
      await c.repository.completePreparation(
        c.id,
        { status: 'prepared', hashVersion: 1, hash: 'h', stats: stats(), preparedAt: NOW },
        auditEvent(c.id),
      );
    }

    it('create returns a preparing record and writes its audit event', async () =>
      withRepo(async (c) => {
        const ev = auditEvent(c.id);
        const rec = await c.repository.create(newChangeSet(c.id), ev);
        expect(rec.id).toBe(c.id);
        expect(rec.status).toBe('preparing');
        expect(rec.stats.total).toBe(0);
        expect(rec.createdAt.getTime()).toBe(NOW.getTime());
        expect(rec.expiresAt.getTime()).toBe(LATER.getTime());
        expect(rec.hash).toBeUndefined();
        expect((await c.events()).map((e) => e.id)).toEqual([ev.id]);
        expect((await c.repository.get(c.id))?.status).toBe('preparing');
        expect(await c.repository.get(randomUUID())).toBeUndefined();
      }));

    it('create is atomic with its audit event', async () =>
      withRepo(async (c) => {
        c.failNextAudit();
        await expect(c.repository.create(newChangeSet(c.id), auditEvent(c.id))).rejects.toThrow();
        expect(await c.repository.get(c.id)).toBeUndefined();
        expect(await c.events()).toHaveLength(0);
      }));

    it('create rejects a duplicate id and writes no second audit event', async () =>
      withRepo(async (c) => {
        await created(c);
        await expect(c.repository.create(newChangeSet(c.id), auditEvent(c.id))).rejects.toThrow();
        expect(await c.events()).toHaveLength(1);
      }));

    it('appendItems dedupes by target, keeps the first copy and returns the inserted count', async () =>
      withRepo(async (c) => {
        await created(c);
        expect(await c.repository.appendItems(c.id, [item('a'), item('b'), item('a')])).toBe(2);
        expect(await c.repository.appendItems(c.id, [item('b', { after: { v: 99 } }), item('c')])).toBe(1);
        const page = await c.repository.itemsPage(c.id, { limit: 10 });
        expect(page.map((i) => i.targetId)).toEqual(['a', 'b', 'c']);
        expect(page.find((i) => i.targetId === 'b')?.after).toEqual({ v: 2 });
        expect(await c.repository.appendItems(c.id, [])).toBe(0);
      }));

    it('appendItems rejects unknown change-sets and non pending/excluded item statuses', async () =>
      withRepo(async (c) => {
        await expect(c.repository.appendItems(randomUUID(), [item('a')])).rejects.toThrow();
        await created(c);
        await expect(c.repository.appendItems(c.id, [item('a', { status: 'written' })])).rejects.toThrow();
        expect(await c.repository.itemsPage(c.id, { limit: 10 })).toEqual([]);
      }));

    it('appendItems is all-or-nothing: a batch with an invalid item stores nothing', async () =>
      withRepo(async (c) => {
        await created(c);
        await expect(
          c.repository.appendItems(c.id, [item('valid'), item('invalid', { status: 'written' })]),
        ).rejects.toThrow();
        expect(await c.repository.itemsPage(c.id, { limit: 10 })).toEqual([]);
      }));

    it('itemsPage orders by code point, pages by keyset and filters by status', async () =>
      withRepo(async (c) => {
        await created(c);
        await c.repository.appendItems(c.id, [
          item('b'),
          item('B', { status: 'excluded', reason: 'no_change' }),
          item('a'),
          item('\u{1F600}'),
          item('é'),
          item('�'),
          item('Z'),
        ]);
        const all = await c.repository.itemsPage(c.id, { limit: 500 });
        // Code-point order: U+FFFD sorts before U+1F600 (UTF-16 code-unit order would reverse them).
        expect(all.map((i) => i.targetId)).toEqual(['B', 'Z', 'a', 'b', 'é', '�', '\u{1F600}']);
        const first = await c.repository.itemsPage(c.id, { limit: 2 });
        expect(first.map((i) => i.targetId)).toEqual(['B', 'Z']);
        const second = await c.repository.itemsPage(c.id, { limit: 2, after: 'Z' });
        expect(second.map((i) => i.targetId)).toEqual(['a', 'b']);
        const tail = await c.repository.itemsPage(c.id, { limit: 10, after: 'é' });
        expect(tail.map((i) => i.targetId)).toEqual(['�', '\u{1F600}']);
        const excluded = await c.repository.itemsPage(c.id, { limit: 10, status: 'excluded' });
        expect(excluded.map((i) => i.targetId)).toEqual(['B']);
        expect(excluded[0]?.reason).toBe('no_change');
        const afterAndStatus = await c.repository.itemsPage(c.id, { limit: 10, after: 'Z', status: 'pending' });
        expect(afterAndStatus.map((i) => i.targetId)).toEqual(['a', 'b', 'é', '�', '\u{1F600}']);
        const none = await c.repository.itemsPage(c.id, { limit: 10, after: 'B', status: 'excluded' });
        expect(none).toEqual([]);
        expect(await c.repository.itemsPage(randomUUID(), { limit: 10 })).toEqual([]);
      }));

    it('itemsPage rejects limits outside 1..500', async () =>
      withRepo(async (c) => {
        await created(c);
        await expect(c.repository.itemsPage(c.id, { limit: 501 })).rejects.toThrow();
        await expect(c.repository.itemsPage(c.id, { limit: 0 })).rejects.toThrow();
      }));

    it('stats counts items by status and exclusion reason', async () =>
      withRepo(async (c) => {
        await created(c);
        await c.repository.appendItems(c.id, [
          item('a'),
          item('b'),
          item('c', { status: 'excluded', reason: 'not_found' }),
          item('d', { status: 'excluded', reason: 'not_found' }),
          item('e', { status: 'excluded', reason: 'no_change' }),
        ]);
        expect(await c.repository.stats(c.id)).toEqual({
          total: 5,
          included: 2,
          excluded: { not_found: 2, no_change: 1 },
          written: 0,
          failed: 0,
          skipped: 0,
        });
      }));

    it('CS-3 stats count check codes, including an Object.prototype member name, as numbers', async () =>
      withRepo(async (c) => {
        await created(c);
        // `valueOf` bypasses the loader, which refuses such a code: the count must still be safe.
        await c.repository.appendItems(c.id, [
          item('a'),
          item('b', { status: 'excluded', reason: 'locked' }),
          item('c', { status: 'excluded', reason: 'locked' }),
          item('d', { status: 'excluded', reason: 'valueOf' }),
          item('e', { status: 'excluded', reason: 'constructor' }),
        ]);
        const stats = await c.repository.stats(c.id);
        expect(stats).toEqual({
          total: 5,
          included: 1,
          excluded: { locked: 2, valueOf: 1, constructor: 1 },
          written: 0,
          failed: 0,
          skipped: 0,
        });
        expect(Object.values(stats.excluded).every((n) => typeof n === 'number')).toBe(true);
      }));

    it('stats of an unknown change-set is a copy of EMPTY_STATS', async () =>
      withRepo(async (c) => {
        const s = await c.repository.stats(randomUUID());
        expect(s).toEqual(EMPTY_STATS);
        expect(s).not.toBe(EMPTY_STATS);
      }));

    it('completePreparation prepared stores hash, stats and preparedAt; a second call returns undefined', async () =>
      withRepo(async (c) => {
        await created(c);
        const st = stats({ total: 2, included: 2 });
        const preparedAt = new Date('2026-01-01T00:00:05.000Z');
        const rec = await c.repository.completePreparation(
          c.id,
          { status: 'prepared', hashVersion: 1, hash: 'h1', stats: st, preparedAt },
          auditEvent(c.id),
        );
        expect(rec?.status).toBe('prepared');
        expect(rec?.hash).toBe('h1');
        expect(rec?.stats).toEqual(st);
        expect(rec?.preparedAt?.getTime()).toBe(preparedAt.getTime());
        expect((await c.repository.get(c.id))?.hash).toBe('h1');
        const before = (await c.events()).length;
        const again = await c.repository.completePreparation(
          c.id,
          { status: 'prepared', hashVersion: 1, hash: 'h2', stats: st, preparedAt },
          auditEvent(c.id),
        );
        expect(again).toBeUndefined();
        expect((await c.repository.get(c.id))?.hash).toBe('h1');
        expect(await c.events()).toHaveLength(before);
        const unknown = randomUUID();
        expect(
          await c.repository.completePreparation(unknown, { status: 'failed', errorCode: 'x' }, auditEvent(unknown)),
        ).toBeUndefined();
      }));

    it('CS-4 completePreparation stores the hash version and action, and get returns them', async () =>
      withRepo(async (c) => {
        await created(c);
        const rec = await c.repository.completePreparation(
          c.id,
          { status: 'prepared', hash: 'h1', hashVersion: 2, action: 'create', stats: stats(), preparedAt: NOW },
          auditEvent(c.id),
        );
        expect(rec?.hashVersion).toBe(2);
        expect(rec?.action).toBe('create');
        const read = await c.repository.get(c.id);
        expect(read?.hashVersion).toBe(2);
        expect(read?.action).toBe('create');
      }));

    it('CS-4 a version 2 change-set without an action (opaque) reads no action', async () =>
      withRepo(async (c) => {
        await created(c);
        await c.repository.completePreparation(
          c.id,
          { status: 'prepared', hash: 'h1', hashVersion: 2, stats: stats(), preparedAt: NOW },
          auditEvent(c.id),
        );
        const read = await c.repository.get(c.id);
        expect(read?.hashVersion).toBe(2);
        expect(read && 'action' in read).toBe(false);
      }));

    it('CS-4 a change-set created and never prepared reads hash version 1 and no action', async () =>
      withRepo(async (c) => {
        const rec = await c.repository.create(newChangeSet(c.id), auditEvent(c.id));
        expect(rec.hashVersion).toBe(1);
        expect('action' in rec).toBe(false);
        const read = await c.repository.get(c.id);
        expect(read?.hashVersion).toBe(1);
        expect(read && 'action' in read).toBe(false);
        await c.repository.completePreparation(c.id, { status: 'failed', errorCode: 'x' }, auditEvent(c.id));
        const failed = await c.repository.get(c.id);
        expect(failed?.hashVersion).toBe(1);
        expect(failed && 'action' in failed).toBe(false);
      }));

    it('completePreparation failed stores the error code', async () =>
      withRepo(async (c) => {
        await created(c);
        const rec = await c.repository.completePreparation(
          c.id,
          { status: 'failed', errorCode: 'targets_missing' },
          auditEvent(c.id),
        );
        expect(rec?.status).toBe('failed');
        expect(rec?.errorCode).toBe('targets_missing');
        expect(rec?.hash).toBeUndefined();
      }));

    it('CS-1 completePreparation failed stores the upstream HTTP status when given', async () =>
      withRepo(async (c) => {
        await created(c);
        const rec = await c.repository.completePreparation(
          c.id,
          { status: 'failed', errorCode: 'http_status', upstreamStatus: 404 },
          auditEvent(c.id),
        );
        expect(rec?.errorStatus).toBe(404);
        expect((await c.repository.get(c.id))?.errorStatus).toBe(404);
      }));

    it('CS-1 completePreparation failed without an upstream status stores none', async () =>
      withRepo(async (c) => {
        await created(c);
        await c.repository.completePreparation(c.id, { status: 'failed', errorCode: 'timeout' }, auditEvent(c.id));
        const rec = await c.repository.get(c.id);
        expect(rec?.errorCode).toBe('timeout');
        expect(rec).not.toHaveProperty('errorStatus');
      }));

    it('parallel completePreparation: exactly one wins and exactly one audit event is written', async () =>
      withRepo(async (c) => {
        await created(c);
        const before = (await c.events()).length;
        const results = await Promise.all(
          ['h1', 'h2'].map((hash) =>
            c.repository.completePreparation(
              c.id,
              { status: 'prepared', hashVersion: 1, hash, stats: stats(), preparedAt: NOW },
              auditEvent(c.id),
            ),
          ),
        );
        expect(results.filter((r) => r !== undefined)).toHaveLength(1);
        expect(await c.events()).toHaveLength(before + 1);
      }));

    it('appendItems rejects once the change-set has left preparing', async () =>
      withRepo(async (c) => {
        await prepared(c);
        await expect(c.repository.appendItems(c.id, [item('a')])).rejects.toThrow();
        expect(await c.repository.itemsPage(c.id, { limit: 10 })).toEqual([]);
      }));

    it('completePreparation is atomic with its audit event', async () =>
      withRepo(async (c) => {
        await created(c);
        const before = (await c.events()).length;
        c.failNextAudit();
        await expect(
          c.repository.completePreparation(
            c.id,
            { status: 'prepared', hashVersion: 1, hash: 'h', stats: stats(), preparedAt: NOW },
            auditEvent(c.id),
          ),
        ).rejects.toThrow();
        const rec = await c.repository.get(c.id);
        expect(rec?.status).toBe('preparing');
        expect(rec?.hash).toBeUndefined();
        expect(await c.events()).toHaveLength(before);
      }));

    it('transition is compare-and-set and writes its audit event only on success', async () =>
      withRepo(async (c) => {
        await prepared(c);
        const before = (await c.events()).length;
        const wrong = await c.repository.transition(c.id, ['approved'], 'executing', auditEvent(c.id));
        expect(wrong).toBeUndefined();
        expect((await c.repository.get(c.id))?.status).toBe('prepared');
        expect(await c.events()).toHaveLength(before);
        const ok = await c.repository.transition(c.id, ['approved', 'prepared'], 'pending_approval', auditEvent(c.id));
        expect(ok?.status).toBe('pending_approval');
        expect(await c.events()).toHaveLength(before + 1);
        const unknown = randomUUID();
        expect(
          await c.repository.transition(unknown, ['prepared'], 'pending_approval', auditEvent(unknown)),
        ).toBeUndefined();
      }));

    it('parallel transitions from the same status: exactly one wins and exactly one audit event is written', async () =>
      withRepo(async (c) => {
        await prepared(c);
        const before = (await c.events()).length;
        const results = await Promise.all([
          c.repository.transition(c.id, ['prepared'], 'cancelled', auditEvent(c.id)),
          c.repository.transition(c.id, ['prepared'], 'pending_approval', auditEvent(c.id)),
        ]);
        expect(results.filter((r) => r !== undefined)).toHaveLength(1);
        expect(await c.events()).toHaveLength(before + 1);
        const winner = results.find((r) => r !== undefined);
        expect((await c.repository.get(c.id))?.status).toBe(winner?.status);
      }));

    it('transition stores errorCode when given', async () =>
      withRepo(async (c) => {
        await prepared(c);
        const rec = await c.repository.transition(c.id, ['prepared'], 'failed', auditEvent(c.id), {
          errorCode: 'boom',
        });
        expect(rec?.status).toBe('failed');
        expect(rec?.errorCode).toBe('boom');
      }));

    it('transition with expiredBefore applies only when expiresAt <= expiredBefore', async () =>
      withRepo(async (c) => {
        await prepared(c);
        const early = new Date(LATER.getTime() - 1);
        expect(
          await c.repository.transition(c.id, ['prepared'], 'expired', auditEvent(c.id), { expiredBefore: early }),
        ).toBeUndefined();
        expect((await c.repository.get(c.id))?.status).toBe('prepared');
        const exact = await c.repository.transition(c.id, ['prepared'], 'expired', auditEvent(c.id), {
          expiredBefore: LATER,
        });
        expect(exact?.status).toBe('expired');
      }));

    it('transition is atomic with its audit event', async () =>
      withRepo(async (c) => {
        await prepared(c);
        const before = (await c.events()).length;
        c.failNextAudit();
        await expect(c.repository.transition(c.id, ['prepared'], 'cancelled', auditEvent(c.id))).rejects.toThrow();
        expect((await c.repository.get(c.id))?.status).toBe('prepared');
        expect(await c.events()).toHaveLength(before);
      }));

    /** Created with the given items, prepared and moved to executing: the only time outcomes are recorded. */
    async function executing(c: Ctx, items: readonly ChangeItemRecord[]): Promise<void> {
      await created(c);
      await c.repository.appendItems(c.id, items);
      await c.repository.completePreparation(
        c.id,
        { status: 'prepared', hashVersion: 1, hash: 'h', stats: await c.repository.stats(c.id), preparedAt: NOW },
        auditEvent(c.id),
      );
      await c.repository.transition(c.id, ['prepared'], 'executing', auditEvent(c.id));
    }

    it('CS-4 recordItemOutcomes is refused unless the change-set is executing or rolling back', async () =>
      withRepo(async (c) => {
        await created(c);
        await c.repository.appendItems(c.id, [item('a')]);
        await expect(c.repository.recordItemOutcomes(c.id, [{ targetId: 'a', status: 'written' }])).rejects.toThrow();
        await c.repository.completePreparation(
          c.id,
          { status: 'prepared', hashVersion: 1, hash: 'h', stats: await c.repository.stats(c.id), preparedAt: NOW },
          auditEvent(c.id),
        );
        for (const status of ['prepared', 'pending_approval', 'approved'] as const) {
          if (status !== 'prepared') await c.repository.transition(c.id, ['prepared', 'pending_approval'], status, auditEvent(c.id));
          await expect(c.repository.recordItemOutcomes(c.id, [{ targetId: 'a', status: 'written' }])).rejects.toThrow();
        }
        await expect(
          c.repository.recordItemOutcomes(randomUUID(), [{ targetId: 'a', status: 'written' }]),
        ).rejects.toThrow();
        expect((await c.repository.itemsPage(c.id, { limit: 10 }))[0]?.status).toBe('pending');
        expect((await c.repository.get(c.id))?.stats.written).toBe(0);
        await c.repository.transition(c.id, ['approved'], 'executing', auditEvent(c.id));
        await c.repository.transition(c.id, ['executing'], 'rolling_back', auditEvent(c.id));
        await c.repository.recordItemOutcomes(c.id, [{ targetId: 'a', status: 'written' }]);
        expect((await c.repository.itemsPage(c.id, { limit: 10 }))[0]?.status).toBe('written');
      }));

    it('MCP-7 updatedAt advances on transition', async () =>
      withRepo(async (c) => {
        await created(c);
        const record = await c.repository.get(c.id);
        await new Promise((resolve) => setTimeout(resolve, 5));
        const next = await c.repository.transition(c.id, ['preparing'], 'cancelled', auditEvent(c.id));
        expect(next?.updatedAt).toBeInstanceOf(Date);
        expect(next?.updatedAt?.getTime()).toBeGreaterThan(record?.createdAt.getTime() ?? 0);
        expect((await c.repository.get(c.id))?.updatedAt?.getTime()).toBe(next?.updatedAt?.getTime());
      }));

    it('CS-7 errorCounts groups item errors', async () =>
      withRepo(async (c) => {
        await executing(c, [item('a'), item('b'), item('c'), item('d')]);
        expect(await c.repository.errorCounts(c.id)).toEqual({});
        await c.repository.recordItemOutcomes(c.id, [
          { targetId: 'a', status: 'skipped', error: 'drift' },
          { targetId: 'b', status: 'skipped', error: 'drift' },
          { targetId: 'c', status: 'failed', error: 'upstream_rejected' },
          { targetId: 'd', status: 'written' },
        ]);
        expect(await c.repository.errorCounts(c.id)).toEqual({ drift: 2, upstream_rejected: 1 });
        expect(await c.repository.errorCounts(randomUUID())).toEqual({});
      }));

    it('recordItemOutcomes updates only pending items and recomputes written/failed/skipped', async () =>
      withRepo(async (c) => {
        await executing(c, [
          item('a'),
          item('b'),
          item('c'),
          item('d', { status: 'excluded', reason: 'no_change' }),
        ]);
        await c.repository.recordItemOutcomes(c.id, [
          { targetId: 'a', status: 'written' },
          { targetId: 'b', status: 'failed', error: 'upstream_5xx' },
          { targetId: 'd', status: 'written' },
          { targetId: 'unknown', status: 'written' },
        ]);
        const items = await c.repository.itemsPage(c.id, { limit: 10 });
        const byId = new Map(items.map((i) => [i.targetId, i]));
        expect(byId.get('a')?.status).toBe('written');
        expect(byId.get('b')?.status).toBe('failed');
        expect(byId.get('b')?.error).toBe('upstream_5xx');
        expect(byId.get('c')?.status).toBe('pending');
        expect(byId.get('d')?.status).toBe('excluded');
        // A second outcome for an already settled item changes nothing.
        await c.repository.recordItemOutcomes(c.id, [{ targetId: 'a', status: 'skipped' }]);
        expect((await c.repository.itemsPage(c.id, { limit: 10, status: 'written' })).map((i) => i.targetId)).toEqual([
          'a',
        ]);
        expect(await c.repository.stats(c.id)).toEqual({
          total: 4,
          included: 3,
          excluded: { no_change: 1 },
          written: 1,
          failed: 1,
          skipped: 0,
        });
        expect((await c.repository.get(c.id))?.stats).toMatchObject({ written: 1, failed: 1, skipped: 0 });
      }));

    /** Created with `n` pending items (t-0001..) plus `extra`, prepared with hash `h`. */
    async function preparedSet(
      c: Ctx,
      id: string,
      n: number,
      over: Partial<NewChangeSet> = {},
      extra: readonly ChangeItemRecord[] = [],
    ): Promise<void> {
      await c.repository.create({ ...newChangeSet(id), ...over }, auditEvent(id));
      await c.repository.appendItems(id, [...extra, ...targets(n).reverse().map((t) => item(t))]);
      await c.repository.completePreparation(
        id,
        { status: 'prepared', hashVersion: 1, hash: 'h', stats: await c.repository.stats(id), preparedAt: NOW },
        auditEvent(id),
      );
    }

    const REQUEST = { actor: 'alice', groups: ['g1'], clientId: 'cli', correlationId: 'corr-x' } as const;

    function start(
      c: Ctx,
      id: string,
      opts: { now?: Date; expectedHash?: string; limits?: ExecutionLimits } = {},
    ): ReturnType<ChangeSetRepository['startExecution']> {
      return c.repository.startExecution({
        changesetId: id,
        expectedHash: opts.expectedHash ?? 'h',
        request: { ...REQUEST, groups: [...REQUEST.groups] },
        ...(opts.limits === undefined ? {} : { limits: opts.limits }),
        now: opts.now ?? NOW,
        event: startEventFactory({ newId: randomUUID, ...REQUEST }),
      });
    }

    async function eventsOf(c: Ctx, id: string): Promise<readonly AuditEventInput[]> {
      return (await c.auditEvents()).filter((e) => e.changesetId === id);
    }

    function batchAudit(id: string, batchNo: number, outcomes: readonly ItemOutcome[]): AuditEventInput {
      const count = (s: ItemOutcome['status']): number => outcomes.filter((o) => o.status === s).length;
      return changesetBatchEvent({
        id: randomUUID(),
        changeset: { id, operation: 'catalog.update' },
        batchNo,
        counts: { written: count('written'), failed: count('failed'), skipped: count('skipped') },
        correlationId: 'corr-x',
      });
    }

    function written(ids: readonly string[]): ItemOutcome[] {
      return ids.map((targetId) => ({ targetId, status: 'written' }));
    }

    async function itemStatuses(c: Ctx, id: string): Promise<Record<string, string>> {
      const page = await c.repository.itemsPage(id, { limit: 500 });
      return Object.fromEntries(page.map((i) => [i.targetId, i.status]));
    }

    it('EXE-11 startExecution applies not found, expiry, missing hash, hash mismatch and status in that order', async () =>
      withRepo(async (c) => {
        expect(await start(c, randomUUID())).toEqual({ ok: false, reason: 'not_found' });

        // Expiry is checked before the hash: a wrong hash on an expired change-set still expires it.
        await preparedSet(c, c.id, 1);
        const before = (await c.events()).length;
        expect(await start(c, c.id, { now: LATER, expectedHash: 'wrong' })).toEqual({ ok: false, reason: 'expired' });
        expect((await c.repository.get(c.id))?.status).toBe('expired');
        const expiredEvents = (await c.events()).slice(before);
        expect(expiredEvents).toHaveLength(1);
        expect(expiredEvents[0]).toMatchObject({ actor: 'system', details: { from: 'prepared', to: 'expired' } });

        // No hash: preparing, and cancelled before it was prepared.
        const preparing = randomUUID();
        await c.repository.create(newChangeSet(preparing), auditEvent(preparing));
        expect(await start(c, preparing, { expectedHash: 'wrong' })).toEqual({ ok: false, reason: 'not_executable' });
        const cancelledEarly = randomUUID();
        await c.repository.create(newChangeSet(cancelledEarly), auditEvent(cancelledEarly));
        await c.repository.transition(cancelledEarly, ['preparing'], 'cancelled', auditEvent(cancelledEarly));
        expect(await start(c, cancelledEarly)).toEqual({ ok: false, reason: 'not_executable' });

        // Hash mismatch is checked before the status.
        const cancelled = randomUUID();
        await preparedSet(c, cancelled, 1);
        await c.repository.transition(cancelled, ['prepared'], 'cancelled', auditEvent(cancelled));
        const cancelledEvents = (await eventsOf(c, cancelled)).length;
        expect(await start(c, cancelled, { expectedHash: 'wrong' })).toEqual({ ok: false, reason: 'hash_mismatch' });
        expect(await start(c, cancelled)).toEqual({ ok: false, reason: 'not_executable' });
        expect(await eventsOf(c, cancelled)).toHaveLength(cancelledEvents);
        expect((await c.repository.get(cancelled))?.status).toBe('cancelled');
      }));

    it('POL-6 startExecution stores the execution request, execution_started_at and the executing event atomically', async () =>
      withRepo(async (c) => {
        await preparedSet(c, c.id, 2);
        const before = (await c.events()).length;
        c.failNextAudit();
        await expect(start(c, c.id)).rejects.toThrow();
        const untouched = await c.repository.get(c.id);
        expect(untouched?.status).toBe('prepared');
        expect(untouched?.executionRequest).toBeUndefined();
        expect(await c.events()).toHaveLength(before);

        const result = await start(c, c.id);
        const expected = { actor: 'alice', groups: ['g1'], clientId: 'cli', correlationId: 'corr-x', startedAt: NOW };
        expect(result.ok).toBe(true);
        if (!result.ok) return;
        expect(result.changeset.status).toBe('executing');
        expect(result.changeset.executionRequest).toEqual(expected);
        const stored = await c.repository.get(c.id);
        expect(stored?.status).toBe('executing');
        expect(stored?.executionRequest).toEqual(expected);
        expect(stored?.cancelRequest).toBeUndefined();
        const added = (await c.events()).slice(before);
        expect(added).toHaveLength(1);
        expect(added[0]).toMatchObject({
          actor: 'alice',
          clientId: 'cli',
          correlationId: 'corr-x',
          details: { from: 'prepared', to: 'executing' },
        });
        // Started once: a second start finds it executing.
        expect(await start(c, c.id)).toEqual({ ok: false, reason: 'not_executable' });
      }));

    it('POL-4 startExecution refuses over records_per_operation and leaves the change-set prepared', async () =>
      withRepo(async (c) => {
        await preparedSet(c, c.id, 3, { requester: requester('alice') }, [
          item('x-excluded', { status: 'excluded', reason: 'no_change' }),
        ]);
        const before = (await c.events()).length;
        expect(await start(c, c.id, { limits: { role: 'editor', recordsPerOperation: 2 } })).toEqual({
          ok: false,
          reason: 'limit_exceeded',
          limit: 'records_per_operation',
        });
        const rec = await c.repository.get(c.id);
        expect(rec?.status).toBe('prepared');
        expect(rec?.executionRequest).toBeUndefined();
        const added = (await c.events()).slice(before);
        expect(added).toHaveLength(1);
        expect(added[0]).toMatchObject({
          action: 'policy.decision',
          decision: 'deny',
          outcome: 'denied',
          changesetId: c.id,
          details: { rule: 'role:editor/limit:records_per_operation', reason: 'limit_exceeded' },
        });
        // Included items count, excluded ones do not.
        expect((await start(c, c.id, { limits: { role: 'editor', recordsPerOperation: 3 } })).ok).toBe(true);
      }));

    it("POL-4 records_per_day counts the requester's executions started in the last 24 hours", async () =>
      withRepo(async (c) => {
        const alice = requester('alice');
        const limits: ExecutionLimits = { role: 'editor', recordsPerDay: 3 };
        await preparedSet(c, c.id, 2, { requester: alice, expiresAt: FAR });
        expect((await start(c, c.id, { now: at(0), limits })).ok).toBe(true);

        const second = randomUUID();
        await preparedSet(c, second, 2, { requester: alice, expiresAt: FAR });
        expect(await start(c, second, { now: at(1), limits })).toEqual({
          ok: false,
          reason: 'limit_exceeded',
          limit: 'records_per_day',
        });
        expect(
          (await eventsOf(c, second)).filter((e) => e.action === 'policy.decision').map((e) => e.details.rule),
        ).toEqual(['role:editor/limit:records_per_day']);
        // The window includes its start: at exactly 24 h the first execution still counts.
        expect(await start(c, second, { now: at(24), limits })).toMatchObject({ ok: false, limit: 'records_per_day' });

        const bobs = randomUUID();
        await preparedSet(c, bobs, 2, { requester: requester('bob'), expiresAt: FAR });
        expect((await start(c, bobs, { now: at(1), limits })).ok).toBe(true);

        expect((await start(c, second, { now: at(25), limits })).ok).toBe(true);
        expect((await c.repository.get(second))?.executionRequest?.startedAt).toEqual(at(25));
      }));

    it("POL-4 concurrent_executions counts the requester's executing change-sets", async () =>
      withRepo(async (c) => {
        const alice = requester('alice');
        const limits: ExecutionLimits = { role: 'editor', concurrentExecutions: 1 };
        await preparedSet(c, c.id, 1, { requester: alice });
        expect((await start(c, c.id)).ok).toBe(true);

        const second = randomUUID();
        await preparedSet(c, second, 1, { requester: alice });
        expect(await start(c, second, { limits })).toEqual({
          ok: false,
          reason: 'limit_exceeded',
          limit: 'concurrent_executions',
        });
        expect((await c.repository.get(second))?.status).toBe('prepared');

        // Another requester's executions do not count.
        const bobs = randomUUID();
        await preparedSet(c, bobs, 1, { requester: requester('bob') });
        expect((await start(c, bobs, { limits })).ok).toBe(true);

        // A finished execution no longer counts.
        await c.repository.transition(c.id, ['executing'], 'completed', auditEvent(c.id));
        expect((await start(c, second, { limits })).ok).toBe(true);
      }));

    it('POL-4 parallel starts of one requester with concurrent_executions 1: exactly one wins', async () =>
      withRepo(async (c) => {
        const alice = requester('alice');
        const other = randomUUID();
        await preparedSet(c, c.id, 1, { requester: alice });
        await preparedSet(c, other, 1, { requester: alice });
        const limits: ExecutionLimits = { role: 'editor', concurrentExecutions: 1 };
        const results = await Promise.all([start(c, c.id, { limits }), start(c, other, { limits })]);
        expect(results.filter((r) => r.ok)).toHaveLength(1);
        expect(results.filter((r) => !r.ok)).toEqual([
          { ok: false, reason: 'limit_exceeded', limit: 'concurrent_executions' },
        ]);
        const statuses = [(await c.repository.get(c.id))?.status, (await c.repository.get(other))?.status];
        expect(statuses.sort()).toEqual(['executing', 'prepared']);
        expect((await c.repository.usage(alice, NOW)).executing).toBe(1);
      }));

    it('EXE-11 parallel starts of one change-set: exactly one wins and exactly one executing event is written', async () =>
      withRepo(async (c) => {
        await preparedSet(c, c.id, 2, { requester: requester('alice') });
        const results = await Promise.all([start(c, c.id), start(c, c.id)]);
        expect(results.filter((r) => r.ok)).toHaveLength(1);
        expect(results.filter((r) => !r.ok)).toEqual([{ ok: false, reason: 'not_executable' }]);
        expect((await c.repository.get(c.id))?.status).toBe('executing');
        const executing = (await c.events()).filter((e) => e.details.to === 'executing');
        expect(executing).toHaveLength(1);
      }));

    it('EXE-7 requestCancel stores the first request only and only while executing', async () =>
      withRepo(async (c) => {
        const bob = { actor: 'bob', correlationId: 'corr-bob', requestedAt: at(1) };
        const carol = { actor: 'carol', correlationId: 'corr-carol', requestedAt: at(2) };
        expect(await c.repository.requestCancel(randomUUID(), bob)).toEqual({ ok: false });
        await preparedSet(c, c.id, 1);
        expect(await c.repository.requestCancel(c.id, bob)).toEqual({ ok: false, status: 'prepared' });
        expect((await c.repository.get(c.id))?.cancelRequest).toBeUndefined();

        expect((await start(c, c.id)).ok).toBe(true);
        const first = await c.repository.requestCancel(c.id, bob);
        expect(first.ok).toBe(true);
        if (first.ok) expect(first.changeset.cancelRequest).toEqual(bob);
        const second = await c.repository.requestCancel(c.id, carol);
        expect(second.ok).toBe(true);
        if (second.ok) {
          expect(second.changeset.cancelRequest).toEqual(bob);
          expect(second.changeset.status).toBe('executing');
        }
        expect((await c.repository.get(c.id))?.cancelRequest).toEqual(bob);

        await c.repository.transition(c.id, ['executing'], 'cancelled', auditEvent(c.id));
        expect(await c.repository.requestCancel(c.id, carol)).toEqual({ ok: false, status: 'cancelled' });
        expect((await c.repository.get(c.id))?.cancelRequest).toEqual(bob);
      }));

    it('EXE-3 NFR-7 claimBatch takes the next pending items in target order and never more than size', async () =>
      withRepo(async (c) => {
        await preparedSet(c, c.id, 5, {}, [item('t-0000', { status: 'excluded', reason: 'no_change' })]);
        expect((await start(c, c.id)).ok).toBe(true);
        await expect(c.repository.claimBatch(c.id, 0, 1, 0)).rejects.toThrow();
        await expect(c.repository.claimBatch(c.id, 0, 1, 1001)).rejects.toThrow();

        const expected = [['t-0001', 't-0002'], ['t-0003', 't-0004'], ['t-0005']];
        for (const [batchNo, ids] of expected.entries()) {
          const claim = await c.repository.claimBatch(c.id, batchNo, 1, 2);
          if (claim.kind !== 'claimed') throw new Error(`batch ${batchNo}: expected claimed, got ${claim.kind}`);
          expect(claim.batch).toEqual({ changesetId: c.id, batchNo, attempt: 1, targetIds: ids });
          expect(claim.items.map((i) => i.targetId)).toEqual(ids);
          expect(claim.items.every((i) => i.status === 'pending')).toBe(true);
          const outcomes = written(ids);
          expect(await c.repository.completeBatch(c.id, batchNo, 1, outcomes, batchAudit(c.id, batchNo, outcomes))).toEqual(
            { ok: true, counts: { written: ids.length, failed: 0, skipped: 0 } },
          );
        }
        expect(await c.repository.claimBatch(c.id, 3, 1, 2)).toEqual({ kind: 'empty' });
        // An empty claim stores nothing: the same claim is empty again, not fenced.
        expect(await c.repository.claimBatch(c.id, 3, 1, 2)).toEqual({ kind: 'empty' });
        expect(await c.repository.claimBatch(randomUUID(), 0, 1, 2)).toEqual({ kind: 'empty' });
      }));

    it('EXE-3 claimBatch fences: an equal or lower attempt is refused, a higher attempt takes over with the same items', async () =>
      withRepo(async (c) => {
        await preparedSet(c, c.id, 3);
        expect((await start(c, c.id)).ok).toBe(true);
        expect((await c.repository.claimBatch(c.id, 0, 2, 2)).kind).toBe('claimed');
        expect(await c.repository.claimBatch(c.id, 0, 2, 2)).toEqual({ kind: 'fenced' });
        expect(await c.repository.claimBatch(c.id, 0, 1, 2)).toEqual({ kind: 'fenced' });
        // The size of a takeover does not matter: the batch keeps its items.
        const takeover = await c.repository.claimBatch(c.id, 0, 3, 3);
        if (takeover.kind !== 'claimed') throw new Error(`expected claimed, got ${takeover.kind}`);
        expect(takeover.batch).toEqual({ changesetId: c.id, batchNo: 0, attempt: 3, targetIds: ['t-0001', 't-0002'] });
        expect(takeover.items.map((i) => i.targetId)).toEqual(['t-0001', 't-0002']);
        expect(await c.repository.claimBatch(c.id, 0, 2, 2)).toEqual({ kind: 'fenced' });
      }));

    it('EXE-3 claimBatch of a done batch returns its stored counts and writes nothing', async () =>
      withRepo(async (c) => {
        await preparedSet(c, c.id, 3);
        expect((await start(c, c.id)).ok).toBe(true);
        await c.repository.claimBatch(c.id, 0, 1, 3);
        const outcomes: ItemOutcome[] = [
          { targetId: 't-0001', status: 'written' },
          { targetId: 't-0002', status: 'failed', error: 'upstream_5xx' },
          { targetId: 't-0003', status: 'skipped' },
        ];
        await c.repository.completeBatch(c.id, 0, 1, outcomes, batchAudit(c.id, 0, outcomes));
        const events = (await c.events()).length;
        const items = await itemStatuses(c, c.id);
        for (const attempt of [1, 5]) {
          expect(await c.repository.claimBatch(c.id, 0, attempt, 3)).toEqual({
            kind: 'done',
            counts: { written: 1, failed: 1, skipped: 1 },
          });
        }
        expect(await c.events()).toHaveLength(events);
        expect(await itemStatuses(c, c.id)).toEqual(items);
        expect(await c.repository.recordSubmission(c.id, 0, 5, { upstreamBatchId: 'late', plan: [] })).toBe(false);
      }));

    it('AUD-1 EXE-11 transition with unlessBatches applies only while no batch of the change-set exists', async () =>
      withRepo(async (c) => {
        await preparedSet(c, c.id, 2);
        expect((await start(c, c.id)).ok).toBe(true);
        expect((await c.repository.claimBatch(c.id, 0, 1, 1)).kind).toBe('claimed');
        const before = (await c.events()).length;
        expect(
          await c.repository.transition(c.id, ['executing'], 'failed', auditEvent(c.id), {
            errorCode: 'executor_unavailable',
            unlessBatches: true,
          }),
        ).toBeUndefined();
        expect(await c.repository.get(c.id)).toMatchObject({ status: 'executing' });
        expect(await c.events()).toHaveLength(before);

        const other = randomUUID();
        await preparedSet(c, other, 1);
        expect((await start(c, other)).ok).toBe(true);
        const failed = await c.repository.transition(other, ['executing'], 'failed', auditEvent(other), {
          errorCode: 'executor_unavailable',
          unlessBatches: true,
        });
        expect(failed).toMatchObject({ status: 'failed', errorCode: 'executor_unavailable' });
        // No batch is claimed once it left executing.
        expect(await c.repository.claimBatch(other, 0, 1, 1)).toEqual({ kind: 'fenced' });
      }));

    it('EXE-3 claimBatch refuses a new claim or a takeover unless the change-set is executing', async () =>
      withRepo(async (c) => {
        // Prepared, not started: no batch is claimed.
        await preparedSet(c, c.id, 3);
        expect(await c.repository.claimBatch(c.id, 0, 1, 2)).toEqual({ kind: 'fenced' });
        expect((await start(c, c.id)).ok).toBe(true);
        // The refused claim stored nothing: batch 0 starts at the first target.
        const claim = await c.repository.claimBatch(c.id, 0, 1, 1);
        if (claim.kind !== 'claimed') throw new Error(`expected claimed, got ${claim.kind}`);
        expect(claim.batch.targetIds).toEqual(['t-0001']);
        const outcomes = written(['t-0001']);
        await c.repository.completeBatch(c.id, 0, 1, outcomes, batchAudit(c.id, 0, outcomes));
        expect((await c.repository.claimBatch(c.id, 1, 1, 1)).kind).toBe('claimed');

        await c.repository.transition(c.id, ['executing'], 'cancelled', auditEvent(c.id));
        // A takeover of the open batch and a new batch are both refused once it left executing.
        expect(await c.repository.claimBatch(c.id, 1, 2, 1)).toEqual({ kind: 'fenced' });
        expect(await c.repository.claimBatch(c.id, 2, 1, 1)).toEqual({ kind: 'fenced' });
        // A done batch still answers its counts.
        expect(await c.repository.claimBatch(c.id, 0, 2, 1)).toEqual({
          kind: 'done',
          counts: { written: 1, failed: 0, skipped: 0 },
        });
        expect(await c.repository.recordSubmission(c.id, 2, 1, { upstreamBatchId: 'none', plan: [] })).toBe(false);
      }));

    it('EXE-3 a takeover racing the completion of the previous attempt answers done or fenced, never throws', async () =>
      withRepo(async (c) => {
        await preparedSet(c, c.id, 8);
        expect((await start(c, c.id)).ok).toBe(true);
        for (let batchNo = 0; batchNo < 4; batchNo += 1) {
          const first = await c.repository.claimBatch(c.id, batchNo, 1, 2);
          if (first.kind !== 'claimed') throw new Error(`batch ${batchNo}: expected claimed, got ${first.kind}`);
          const outcomes = written(first.batch.targetIds);
          const [completed, takeover] = await Promise.all([
            c.repository.completeBatch(c.id, batchNo, 1, outcomes, batchAudit(c.id, batchNo, outcomes)),
            c.repository.claimBatch(c.id, batchNo, 2, 2),
          ]);
          if (completed.ok) {
            expect(['done', 'fenced']).toContain(takeover.kind);
            if (takeover.kind === 'done') expect(takeover.counts).toEqual({ written: 2, failed: 0, skipped: 0 });
          } else {
            expect(takeover.kind).toBe('claimed');
            const settled = written(first.batch.targetIds);
            expect(
              await c.repository.completeBatch(c.id, batchNo, 2, settled, batchAudit(c.id, batchNo, settled)),
            ).toMatchObject({ ok: true });
          }
        }
        expect(Object.values(await itemStatuses(c, c.id)).every((s) => s === 'written')).toBe(true);
        expect((await c.events()).filter((e) => e.action === 'changeset.batch')).toHaveLength(4);
      }));

    it('NFR-2 recordSubmission stores the upstream ID and plan for the owning attempt only', async () =>
      withRepo(async (c) => {
        await preparedSet(c, c.id, 2);
        expect((await start(c, c.id)).ok).toBe(true);
        expect(await c.repository.recordSubmission(c.id, 0, 1, { upstreamBatchId: 'none', plan: [] })).toBe(false);
        await c.repository.claimBatch(c.id, 0, 1, 2);
        const submission: BatchSubmission = {
          upstreamBatchId: 'up-1',
          plan: [
            { targetId: 't-0001', action: 'write' },
            { targetId: 't-0002', action: 'outcome', status: 'skipped', error: 'no_change' },
          ],
        };
        expect(await c.repository.recordSubmission(c.id, 0, 1, submission)).toBe(true);
        const takeover = await c.repository.claimBatch(c.id, 0, 2, 2);
        if (takeover.kind !== 'claimed') throw new Error(`expected claimed, got ${takeover.kind}`);
        expect(takeover.batch.submission).toEqual(submission);
        expect(await c.repository.recordSubmission(c.id, 0, 1, { upstreamBatchId: 'stale', plan: [] })).toBe(false);
        const again = await c.repository.claimBatch(c.id, 0, 3, 2);
        if (again.kind !== 'claimed') throw new Error(`expected claimed, got ${again.kind}`);
        expect(again.batch.submission).toEqual(submission);
      }));

    it('AUD-1 completeBatch records outcomes, done counts and one changeset.batch event in one transaction', async () =>
      withRepo(async (c) => {
        await preparedSet(c, c.id, 3);
        expect((await start(c, c.id)).ok).toBe(true);
        await c.repository.claimBatch(c.id, 0, 1, 2);
        await c.repository.claimBatch(c.id, 0, 2, 2);
        const outcomes: ItemOutcome[] = [
          { targetId: 't-0001', status: 'written' },
          { targetId: 't-0002', status: 'failed', error: 'upstream_5xx' },
        ];
        const before = (await c.events()).length;
        const pending = { 't-0001': 'pending', 't-0002': 'pending', 't-0003': 'pending' };

        expect(await c.repository.completeBatch(c.id, 0, 1, outcomes, batchAudit(c.id, 0, outcomes))).toEqual({ ok: false });
        expect(await itemStatuses(c, c.id)).toEqual(pending);
        expect(await c.events()).toHaveLength(before);

        c.failNextAudit();
        await expect(c.repository.completeBatch(c.id, 0, 2, outcomes, batchAudit(c.id, 0, outcomes))).rejects.toThrow();
        expect(await itemStatuses(c, c.id)).toEqual(pending);
        expect(await c.events()).toHaveLength(before);
        expect((await c.repository.get(c.id))?.stats).toMatchObject({ written: 0, failed: 0 });

        const ev = batchAudit(c.id, 0, outcomes);
        expect(await c.repository.completeBatch(c.id, 0, 2, outcomes, ev)).toEqual({
          ok: true,
          counts: { written: 1, failed: 1, skipped: 0 },
        });
        expect(await itemStatuses(c, c.id)).toEqual({ 't-0001': 'written', 't-0002': 'failed', 't-0003': 'pending' });
        expect((await c.repository.get(c.id))?.stats).toMatchObject({ included: 3, written: 1, failed: 1, skipped: 0 });
        const added = (await c.events()).slice(before);
        expect(added.map((e) => e.id)).toEqual([ev.id]);
        expect(added[0]).toMatchObject({ action: 'changeset.batch', details: { batchNo: 0, written: 1, failed: 1 } });

        // Done: the owning attempt cannot complete twice.
        expect(await c.repository.completeBatch(c.id, 0, 2, outcomes, batchAudit(c.id, 0, outcomes))).toEqual({ ok: false });
        expect(await c.events()).toHaveLength(before + 1);
      }));

    it('EXE-3 completeBatch applies and counts only pending targets of the batch', async () =>
      withRepo(async (c) => {
        await preparedSet(c, c.id, 3);
        expect((await start(c, c.id)).ok).toBe(true);
        await c.repository.claimBatch(c.id, 0, 1, 2);
        // t-0002 is settled before the batch completes; t-0003 belongs to no claimed batch.
        await c.repository.recordItemOutcomes(c.id, [{ targetId: 't-0002', status: 'failed', error: 'upstream_5xx' }]);
        const outcomes: ItemOutcome[] = [
          { targetId: 't-0001', status: 'written' },
          { targetId: 't-0002', status: 'written' },
          { targetId: 't-0003', status: 'skipped' },
          { targetId: 'unknown', status: 'written' },
        ];
        expect(await c.repository.completeBatch(c.id, 0, 1, outcomes, batchAudit(c.id, 0, outcomes))).toEqual({
          ok: true,
          counts: { written: 1, failed: 0, skipped: 0 },
        });
        expect(await itemStatuses(c, c.id)).toEqual({ 't-0001': 'written', 't-0002': 'failed', 't-0003': 'pending' });
        expect(await c.repository.claimBatch(c.id, 0, 2, 2)).toEqual({
          kind: 'done',
          counts: { written: 1, failed: 0, skipped: 0 },
        });
        expect((await c.repository.get(c.id))?.stats).toMatchObject({ written: 1, failed: 1, skipped: 0 });
      }));

    it('EXE-3 completeBatch is refused unless the change-set is executing', async () =>
      withRepo(async (c) => {
        await preparedSet(c, c.id, 1);
        expect((await start(c, c.id)).ok).toBe(true);
        await c.repository.claimBatch(c.id, 0, 1, 1);
        await c.repository.transition(c.id, ['executing'], 'cancelled', auditEvent(c.id));
        const before = (await c.events()).length;
        const outcomes = written(['t-0001']);
        await expect(c.repository.completeBatch(c.id, 0, 1, outcomes, batchAudit(c.id, 0, outcomes))).rejects.toThrow();
        expect(await itemStatuses(c, c.id)).toEqual({ 't-0001': 'pending' });
        expect(await c.events()).toHaveLength(before);
      }));

    it('POL-4 usage sums records started since and counts executing change-sets', async () =>
      withRepo(async (c) => {
        const alice = requester('alice');
        expect(await c.repository.usage(alice, NOW)).toEqual({ recordsSince: 0, executing: 0 });
        await preparedSet(c, c.id, 2, { requester: alice, expiresAt: FAR }, [
          item('x-excluded', { status: 'excluded', reason: 'not_found' }),
        ]);
        expect((await start(c, c.id, { now: at(0) })).ok).toBe(true);
        const second = randomUUID();
        await preparedSet(c, second, 3, { requester: alice, expiresAt: FAR });
        expect((await start(c, second, { now: at(2) })).ok).toBe(true);
        // Prepared but not started: not counted.
        await preparedSet(c, randomUUID(), 4, { requester: alice, expiresAt: FAR });

        expect(await c.repository.usage(alice, at(0))).toEqual({ recordsSince: 5, executing: 2 });
        expect(await c.repository.usage(alice, at(1))).toEqual({ recordsSince: 3, executing: 2 });
        expect(await c.repository.usage(alice, at(3))).toEqual({ recordsSince: 0, executing: 2 });
        await c.repository.transition(c.id, ['executing'], 'completed', auditEvent(c.id));
        // A finished execution still counts towards records, no longer as executing.
        expect(await c.repository.usage(alice, at(0))).toEqual({ recordsSince: 5, executing: 1 });
        expect(await c.repository.usage(requester('bob'), at(0))).toEqual({ recordsSince: 0, executing: 0 });
      }));

    /** A change-set submitted for approval awaiting `awaiting`, submitted at `submittedAt`. */
    async function submittedFor(
      c: Ctx,
      opts: { awaiting: string; requester?: string; at: Date; id?: string },
    ): Promise<ChangeSetRecord> {
      const id = opts.id ?? randomUUID();
      await preparedSet(c, id, 2, { requester: opts.requester ?? requester('alice'), expiresAt: FAR });
      const prepared = await c.repository.get(id);
      if (prepared === undefined) throw new Error('prepared change-set missing');
      return submitChangeSet(c.repository, prepared, { steps: [opts.awaiting], at: opts.at });
    }

    it('UI-7 pendingApprovals lists change-sets awaiting one of the roles, newest submission first', async () =>
      withRepo(async (c) => {
        const role = `lead-${randomUUID()}`;
        const a = await submittedFor(c, { awaiting: role, at: at(1) });
        const b = await submittedFor(c, { awaiting: role, at: at(3) });
        const d = await submittedFor(c, { awaiting: role, at: at(2) });
        await submittedFor(c, { awaiting: `lead-${randomUUID()}`, at: at(4) });
        const rows = await c.repository.pendingApprovals({ roles: [role], excludeRequester: 'nobody', limit: 10 });
        expect(rows.map((r) => r.id)).toEqual([b.id, d.id, a.id]);
      }));

    it('APR-2 pendingApprovals leaves out change-sets the viewer requested', async () =>
      withRepo(async (c) => {
        const role = `lead-${randomUUID()}`;
        const mine = requester('mine');
        const own = await submittedFor(c, { awaiting: role, requester: mine, at: at(1) });
        const other = await submittedFor(c, { awaiting: role, at: at(2) });
        const rows = await c.repository.pendingApprovals({ roles: [role], excludeRequester: mine, limit: 10 });
        expect(rows.map((r) => r.id)).toEqual([other.id]);
        expect(rows.map((r) => r.id)).not.toContain(own.id);
      }));

    it('NFR-8 pendingApprovals pages by (submittedAt, id) without gaps or repeats', async () =>
      withRepo(async (c) => {
        const role = `lead-${randomUUID()}`;
        for (const h of [1, 2, 2, 3, 4]) await submittedFor(c, { awaiting: role, at: at(h) });
        const all = await c.repository.pendingApprovals({ roles: [role], excludeRequester: 'nobody', limit: 10 });
        expect(all).toHaveLength(5);
        const paged: string[] = [];
        let after: { submittedAt: Date; id: string } | undefined;
        for (;;) {
          const page = await c.repository.pendingApprovals({
            roles: [role],
            excludeRequester: 'nobody',
            limit: 2,
            ...(after === undefined ? {} : { after }),
          });
          paged.push(...page.map((r) => r.id));
          const last = page.at(-1);
          if (page.length < 2 || last?.submission === undefined) break;
          after = { submittedAt: last.submission.at, id: last.id };
        }
        expect(paged).toEqual(all.map((r) => r.id));
      }));

    it('UI-7 pendingApprovals ignores other statuses and an empty role list', async () =>
      withRepo(async (c) => {
        const role = `lead-${randomUUID()}`;
        const preparedOnly = randomUUID();
        await preparedSet(c, preparedOnly, 1, { expiresAt: FAR });
        const rejected = await submittedFor(c, { awaiting: role, at: at(1) });
        await recordApproval(c.repository, rejected, { approver: 'dave', decision: 'rejected' });
        const live = await submittedFor(c, { awaiting: role, at: at(2) });
        const rows = await c.repository.pendingApprovals({ roles: [role], excludeRequester: 'nobody', limit: 10 });
        expect(rows.map((r) => r.id)).toEqual([live.id]);
        expect(await c.repository.pendingApprovals({ roles: [], excludeRequester: 'nobody', limit: 10 })).toEqual([]);
        await expect(c.repository.pendingApprovals({ roles: [role], excludeRequester: 'x', limit: 0 })).rejects.toThrow();
        await expect(c.repository.pendingApprovals({ roles: [role], excludeRequester: 'x', limit: 501 })).rejects.toThrow();
      }));

    const SEED = '0123456789abcdef0123456789abcdef';
    const md5Order = (seed: string, ids: readonly string[]): string[] =>
      [...ids].sort((a, b) => {
        const ka = createHash('md5').update(seed + a).digest('hex');
        const kb = createHash('md5').update(seed + b).digest('hex');
        return ka < kb ? -1 : ka > kb ? 1 : a < b ? -1 : a > b ? 1 : 0;
      });

    it('APR-5 sampleItems is deterministic per seed and ordered by md5(seed || targetId)', async () =>
      withRepo(async (c) => {
        const ids = targets(20);
        await created(c);
        await c.repository.appendItems(
          c.id,
          ids.map((t) => (['t-0003', 't-0010', 't-0017'].includes(t) ? item(t, { status: 'excluded', reason: 'not_found' }) : item(t))),
        );
        const included = ids.filter((t) => !['t-0003', 't-0010', 't-0017'].includes(t));
        const first = await c.repository.sampleItems(c.id, SEED, 5);
        const second = await c.repository.sampleItems(c.id, SEED, 5);
        expect(first).toEqual(second);
        expect(first.map((i) => i.targetId)).toEqual(md5Order(SEED, included).slice(0, 5));
        const other = await c.repository.sampleItems(c.id, 'fedcba9876543210fedcba9876543210', 5);
        expect(other.map((i) => i.targetId)).not.toEqual(first.map((i) => i.targetId));
      }));

    it('APR-5 sampleItems returns included items only, at most size', async () =>
      withRepo(async (c) => {
        await created(c);
        await c.repository.appendItems(
          c.id,
          targets(20).map((t) => (['t-0003', 't-0010', 't-0017'].includes(t) ? item(t, { status: 'excluded', reason: 'not_found' }) : item(t))),
        );
        const all = await c.repository.sampleItems(c.id, SEED, 50);
        expect(all).toHaveLength(17);
        expect(all.every((i) => i.status !== 'excluded')).toBe(true);
        await expect(c.repository.sampleItems(c.id, SEED, 0)).rejects.toThrow();
        await expect(c.repository.sampleItems(c.id, SEED, 501)).rejects.toThrow();
      }));

    it('APR-5 sampleItems of an unknown or non-UUID id is empty', async () =>
      withRepo(async (c) => {
        expect(await c.repository.sampleItems(randomUUID(), SEED, 5)).toEqual([]);
        expect(await c.repository.sampleItems('x', SEED, 5)).toEqual([]);
      }));

    describe('CS-5 derived change-sets', () => {
      /** The source: t-0001..t-0003 pending, t-0004 excluded not_found, prepared with hash 'h'. */
      async function source(c: Ctx): Promise<void> {
        await created(c);
        await c.repository.appendItems(c.id, [
          ...targets(3).map((t) => item(t)),
          item('t-0004', { status: 'excluded', reason: 'not_found' }),
        ]);
        await c.repository.completePreparation(
          c.id,
          { status: 'prepared', hashVersion: 1, hash: 'h', stats: await c.repository.stats(c.id), preparedAt: NOW },
          auditEvent(c.id),
        );
      }

      async function createDerived(c: Ctx, from: string): Promise<string> {
        const id = randomUUID();
        await c.repository.create({ ...newChangeSet(id), derivedFrom: from }, auditEvent(id));
        return id;
      }

      /** D: derived from the source with t-0002 excluded by the requester, then prepared. */
      async function derivedD(c: Ctx): Promise<string> {
        await source(c);
        const d = await createDerived(c, c.id);
        expect(await c.repository.copyItems(d, c.id, ['t-0002'], [])).toBe(4);
        await c.repository.completePreparation(
          d,
          { status: 'prepared', hashVersion: 1, hash: 'h2', stats: await c.repository.stats(d), preparedAt: NOW },
          auditEvent(d),
        );
        return d;
      }

      async function allItems(c: Ctx, id: string): Promise<readonly ChangeItemRecord[]> {
        return c.repository.itemsPage(id, { limit: 10 });
      }

      it('CS-5 create stores derivedFrom and get returns it', async () =>
        withRepo(async (c) => {
          await created(c);
          const d = await createDerived(c, c.id);
          expect((await c.repository.get(d))?.derivedFrom).toBe(c.id);
          expect(await c.repository.get(c.id)).not.toHaveProperty('derivedFrom');
        }));

      it('CS-5 deriveCheck counts unknown targets and the included items left', async () =>
        withRepo(async (c) => {
          await source(c);
          expect(await c.repository.deriveCheck(c.id, ['t-0001', 't-0004', 'nope'], [])).toEqual({ unknown: 2, includedAfter: 2 });
          expect(await c.repository.deriveCheck(c.id, ['t-0001', 't-0001'], [])).toEqual({ unknown: 0, includedAfter: 2 });
          expect(await c.repository.deriveCheck(c.id, [], ['t-0004'])).toEqual({ unknown: 1, includedAfter: 3 });
          // A target named in both lists cannot qualify on both sides: it counts once, as unknown.
          expect(await c.repository.deriveCheck(c.id, ['t-0001', 'nope'], ['t-0001', 'nope'])).toEqual({
            unknown: 2,
            includedAfter: 2,
          });
        }));

      it('CS-5 copyItems copies every item with the exclusion applied, and only into an empty preparing change-set', async () =>
        withRepo(async (c) => {
          await source(c);
          const before = await allItems(c, c.id);
          const d = await createDerived(c, c.id);
          expect(await c.repository.copyItems(d, c.id, ['t-0002'], [])).toBe(4);
          expect(await allItems(c, d)).toEqual(
            before.map((i) => (i.targetId === 't-0002' ? { ...i, status: 'excluded', reason: 'requester' } : i)),
          );
          expect(await allItems(c, c.id)).toEqual(before);
          await expect(c.repository.copyItems(d, c.id, ['t-0002'], [])).rejects.toThrow('change-set already has items');
          await expect(c.repository.copyItems(c.id, c.id, [], [])).rejects.toThrow('change-set is not preparing');
          await expect(c.repository.copyItems(randomUUID(), c.id, [], [])).rejects.toThrow();
          expect(await allItems(c, d)).toHaveLength(4);
        }));

      it('CS-5 copyItems applies include only to requester exclusions and exclude only to pending items; exclude wins', async () =>
        withRepo(async (c) => {
          const d = await derivedD(c);
          const e = await createDerived(c, d);
          expect(await c.repository.copyItems(e, d, ['t-0004'], ['t-0002', 't-0004'])).toBe(4);
          const byId = Object.fromEntries((await allItems(c, e)).map((i) => [i.targetId, i]));
          expect(byId['t-0004']).toMatchObject({ status: 'excluded', reason: 'not_found' });
          expect(byId['t-0002']?.status).toBe('pending');
          const f = await createDerived(c, d);
          expect(await c.repository.copyItems(f, d, ['t-0001', 't-0002'], ['t-0001', 't-0002'])).toBe(4);
          const fById = Object.fromEntries((await allItems(c, f)).map((i) => [i.targetId, i]));
          expect(fById['t-0001']).toMatchObject({ status: 'excluded', reason: 'requester' });
          expect(fById['t-0002']).toMatchObject({ status: 'excluded', reason: 'requester' });
        }));

      it('CS-5 an item excluded by the requester can be included back', async () =>
        withRepo(async (c) => {
          const d = await derivedD(c);
          const e = await createDerived(c, d);
          expect(await c.repository.copyItems(e, d, [], ['t-0002'])).toBe(4);
          const t2 = (await allItems(c, e)).find((i) => i.targetId === 't-0002');
          expect(t2?.status).toBe('pending');
          expect(t2).not.toHaveProperty('reason');
          expect(t2).not.toHaveProperty('error');
          expect(await c.repository.deriveCheck(d, [], ['t-0002'])).toEqual({ unknown: 0, includedAfter: 3 });
        }));

      it('CS-5 stats count requester exclusions separately', async () =>
        withRepo(async (c) => {
          const d = await derivedD(c);
          expect(await c.repository.stats(d)).toEqual(stats({ total: 4, included: 2, excluded: { not_found: 1, requester: 1 } }));
        }));

      it('CS-5 deriveCheck of an unknown or non-UUID source counts every target as unknown', async () =>
        withRepo(async (c) => {
          for (const id of [randomUUID(), 'x']) {
            expect(await c.repository.deriveCheck(id, ['a', 'b', 'a'], ['b', 'c'])).toEqual({ unknown: 3, includedAfter: 0 });
          }
        }));
    });

    describe('CS-9 EXE-13 plans', () => {
      type PlanResult = Awaited<ReturnType<ChangeSetRepository['createPlan']>>;

      function makePlan(
        c: Ctx,
        ids: readonly string[],
        opts: { owner: string; id?: string; now?: Date },
      ): Promise<PlanResult> {
        const id = opts.id ?? randomUUID();
        const now = opts.now ?? NOW;
        const plan: PlanRecord = { id, title: 'Launch', requester: opts.owner, createdAt: now };
        return c.repository.createPlan({
          id,
          title: 'Launch',
          requester: opts.owner,
          changesetIds: ids,
          now,
          audit: planCreatedEvent({ id: randomUUID(), plan, steps: ids.length, correlationId: 'corr-plan' }),
        });
      }

      async function planEvents(c: Ctx, planId: string): Promise<readonly AuditEventInput[]> {
        return (await c.auditEvents()).filter((e) => e.action === 'plan.created' && e.details.planId === planId);
      }

      /** `n` prepared change-sets of one requester, one item each, hash `h`. */
      async function preparedSteps(c: Ctx, owner: string, n: number): Promise<string[]> {
        const ids = Array.from({ length: n }, () => randomUUID());
        for (const id of ids) await preparedSet(c, id, 1, { requester: owner });
        return ids;
      }

      /** A plan over two prepared change-sets of `owner`, listed in reverse creation order. */
      async function twoStepPlan(c: Ctx, owner: string): Promise<{ planId: string; first: string; second: string }> {
        const [second, first] = await preparedSteps(c, owner, 2);
        if (first === undefined || second === undefined) throw new Error('two change-sets expected');
        const planId = randomUUID();
        expect((await makePlan(c, [first, second], { owner, id: planId })).ok).toBe(true);
        return { planId, first, second };
      }

      it('CS-9 createPlan puts prepared change-sets of one requester in list order and audits plan.created once', async () =>
        withRepo(async (c) => {
          const owner = requester('alice');
          const [b, a] = await preparedSteps(c, owner, 2);
          if (a === undefined || b === undefined) throw new Error('two change-sets expected');
          const planId = randomUUID();
          const result = await makePlan(c, [a, b], { owner, id: planId });
          expect(result).toEqual({ ok: true, plan: { id: planId, title: 'Launch', requester: owner, createdAt: NOW } });
          expect((await c.repository.get(a))?.plan).toEqual({ id: planId, step: 1 });
          expect((await c.repository.get(b))?.plan).toEqual({ id: planId, step: 2 });
          expect(await c.repository.planSteps(planId)).toEqual({
            plan: { id: planId, title: 'Launch', requester: owner, createdAt: NOW },
            steps: [
              { step: 1, changesetId: a, operation: 'catalog.update', status: 'prepared', executionStarted: false, written: 0 },
              { step: 2, changesetId: b, operation: 'catalog.update', status: 'prepared', executionStarted: false, written: 0 },
            ],
          });
          const events = await planEvents(c, planId);
          expect(events).toHaveLength(1);
          expect(events[0]).toMatchObject({ actor: owner, action: 'plan.created', details: { planId, steps: 2 } });
        }));

      it('CS-9 a change-set outside a plan carries no plan; planSteps of an unknown or non-UUID ID is undefined', async () =>
        withRepo(async (c) => {
          await prepared(c);
          expect(await c.repository.get(c.id)).not.toHaveProperty('plan');
          expect(await c.repository.planSteps(randomUUID())).toBeUndefined();
          expect(await c.repository.planSteps('not-a-uuid')).toBeUndefined();
        }));

      it('CS-9 each createPlan refusal writes nothing', async () =>
        withRepo(async (c) => {
          const owner = requester('alice');
          const a = randomUUID();
          const b = randomUUID();
          const foreign = randomUUID();
          const preparing = randomUUID();
          const late = randomUUID();
          const missing = randomUUID();
          await preparedSet(c, a, 1, { requester: owner });
          await preparedSet(c, b, 1, { requester: owner });
          await preparedSet(c, foreign, 1, { requester: requester('bob') });
          await c.repository.create({ ...newChangeSet(preparing), requester: owner }, auditEvent(preparing));
          await preparedSet(c, late, 1, { requester: owner, expiresAt: at(1) });
          const { second: planned } = await twoStepPlan(c, owner);

          const cases: { list: string[]; now?: Date; expected: { reason: CreatePlanRefusal; changesetId?: string } }[] = [
            { list: [a, missing], expected: { reason: 'not_found', changesetId: missing } },
            { list: [a, 'not-a-uuid'], expected: { reason: 'not_found', changesetId: 'not-a-uuid' } },
            { list: [a, foreign], expected: { reason: 'not_requester', changesetId: foreign } },
            { list: [a, preparing], expected: { reason: 'not_prepared', changesetId: preparing } },
            { list: [a, late], now: at(1), expected: { reason: 'not_prepared', changesetId: late } },
            { list: [a, planned], expected: { reason: 'already_in_plan', changesetId: planned } },
            { list: [a, b, a], expected: { reason: 'duplicate_step' } },
            { list: [a], expected: { reason: 'too_few_steps' } },
            { list: Array.from({ length: 21 }, () => randomUUID()), expected: { reason: 'too_many_steps' } },
          ];
          for (const k of cases) {
            const planId = randomUUID();
            const result = await makePlan(c, k.list, { owner, id: planId, ...(k.now === undefined ? {} : { now: k.now }) });
            expect(result, k.expected.reason).toMatchObject({ ok: false, ...k.expected });
            expect(await c.repository.planSteps(planId)).toBeUndefined();
            expect(await planEvents(c, planId)).toHaveLength(0);
          }
          for (const id of [a, b, foreign, preparing, late]) {
            expect(await c.repository.get(id)).not.toHaveProperty('plan');
          }
          // A refusal for expiry does not expire the change-set: createPlan writes nothing.
          expect((await c.repository.get(late))?.status).toBe('prepared');
        }));

      it('CS-9 createPlan is atomic with its audit event', async () =>
        withRepo(async (c) => {
          const owner = requester('alice');
          const ids = await preparedSteps(c, owner, 2);
          const planId = randomUUID();
          c.failNextAudit();
          await expect(makePlan(c, ids, { owner, id: planId })).rejects.toThrow();
          expect(await c.repository.planSteps(planId)).toBeUndefined();
          for (const id of ids) expect(await c.repository.get(id)).not.toHaveProperty('plan');
          expect((await makePlan(c, ids, { owner, id: planId })).ok).toBe(true);
        }));

      it('CS-9 two concurrent createPlan calls sharing a change-set: exactly one succeeds', async () =>
        withRepo(async (c) => {
          const owner = requester('alice');
          const [shared, x, y] = await preparedSteps(c, owner, 3);
          if (shared === undefined || x === undefined || y === undefined) throw new Error('ids expected');
          const [left, right] = await Promise.all([makePlan(c, [x, shared], { owner }), makePlan(c, [shared, y], { owner })]);
          expect([left.ok, right.ok].filter(Boolean)).toHaveLength(1);
          expect([left, right].filter((r) => !r.ok)).toEqual([{ ok: false, reason: 'already_in_plan', changesetId: shared }]);
          const loser = left.ok ? y : x;
          expect(await c.repository.get(loser)).not.toHaveProperty('plan');
        }));

      it('EXE-13 startExecution refuses a step before the step ahead of it completed, changing nothing', async () =>
        withRepo(async (c) => {
          const owner = requester('alice');
          const { planId, first, second } = await twoStepPlan(c, owner);
          const before = (await eventsOf(c, second)).length;
          expect(await start(c, second)).toEqual({ ok: false, reason: 'plan_blocked' });
          // The gate comes after the hash and status checks and before the limits: no limit_denied row.
          expect(await start(c, second, { expectedHash: 'wrong' })).toEqual({ ok: false, reason: 'hash_mismatch' });
          expect(await start(c, second, { limits: { role: 'editor', recordsPerOperation: 0 } })).toEqual({
            ok: false,
            reason: 'plan_blocked',
          });
          const blocked = await c.repository.get(second);
          expect(blocked?.status).toBe('prepared');
          expect(blocked?.executionRequest).toBeUndefined();
          expect(await eventsOf(c, second)).toHaveLength(before);

          expect((await start(c, first)).ok).toBe(true);
          expect(await start(c, second)).toEqual({ ok: false, reason: 'plan_blocked' });
          await c.repository.transition(first, ['executing'], 'completed', auditEvent(first));
          const result = await start(c, second);
          expect(result.ok).toBe(true);
          expect((await c.repository.planSteps(planId))?.steps).toMatchObject([
            { step: 1, status: 'completed', executionStarted: true },
            { step: 2, status: 'executing', executionStarted: true },
          ]);
        }));

      it('EXE-13 a step whose predecessor completed with errors stays blocked', async () =>
        withRepo(async (c) => {
          const owner = requester('alice');
          const { first, second } = await twoStepPlan(c, owner);
          expect((await start(c, first)).ok).toBe(true);
          await c.repository.transition(first, ['executing'], 'completed_with_errors', auditEvent(first));
          expect(await start(c, second)).toEqual({ ok: false, reason: 'plan_blocked' });
          expect((await c.repository.get(second))?.status).toBe('prepared');
        }));

      /** Rollback requests of a plan step, as the executor sends them; the window is judged on the store's clock. */
      async function requestRollbackOf(c: Ctx, id: string): ReturnType<ChangeSetRepository['requestRollback']> {
        const cs = await c.repository.get(id);
        if (cs === undefined) throw new Error('missing change-set');
        const req: RollbackRequest = { actor: 'alice', correlationId: `corr-rb-${randomUUID()}`, requestedAt: new Date() };
        const audit = rollbackRequestEvents({ newId: randomUUID, changeset: cs, request: req, channel: 'page', count: 1 });
        return c.repository.requestRollback({ changesetId: id, request: req, marginMs: ROLLBACK_REQUEST_MARGIN_MS, audit });
      }

      /** A two-step plan whose step 1 completed with an open rollback window; step 2 is still `prepared`. */
      async function firstCompleted(c: Ctx, owner: string): Promise<{ planId: string; first: string; second: string }> {
        const plan = await twoStepPlan(c, owner);
        expect((await start(c, plan.first)).ok).toBe(true);
        await c.repository.transition(plan.first, ['executing'], 'completed', auditEvent(plan.first));
        await c.repository.openRollbackWindow(plan.first, new Date(Date.now() + HOUR));
        return plan;
      }

      it('EXE-8 EXE-13 requestRollback of a step refuses plan_order while a later step runs or holds writes, writing nothing; admits it once that step is rolled back', async () =>
        withRepo(async (c) => {
          const owner = requester('alice');
          const { planId, first, second } = await firstCompleted(c, owner);
          expect((await start(c, second)).ok).toBe(true);
          const before = (await eventsOf(c, first)).length;
          // Executing, nothing written yet: its writes are still coming.
          expect(await requestRollbackOf(c, first)).toEqual({ ok: false, reason: 'plan_order' });
          const unchanged = await c.repository.get(first);
          expect(unchanged?.status).toBe('completed');
          expect(unchanged?.rollbackRequest).toBeUndefined();
          expect(await eventsOf(c, first)).toHaveLength(before);

          await c.repository.recordItemOutcomes(second, written(targets(1)));
          expect((await c.repository.planSteps(planId))?.steps).toMatchObject([{ step: 1, written: 0 }, { step: 2, written: 1 }]);
          await c.repository.transition(second, ['executing'], 'completed', auditEvent(second));
          await c.repository.openRollbackWindow(second, new Date(Date.now() + HOUR));
          expect(await requestRollbackOf(c, first)).toEqual({ ok: false, reason: 'plan_order' });
          // The later step goes first; once it is rolled back, the earlier one may follow.
          expect((await requestRollbackOf(c, second)).ok).toBe(true);
          expect(await requestRollbackOf(c, first)).toEqual({ ok: false, reason: 'plan_order' });
          await c.repository.transition(second, ['rolling_back'], 'rolled_back', auditEvent(second));
          expect((await requestRollbackOf(c, first)).ok).toBe(true);
          expect((await c.repository.get(first))?.status).toBe('rolling_back');
        }));

      it('EXE-8 EXE-13 a later step that started but wrote nothing does not block; one that ended with writes does', async () =>
        withRepo(async (c) => {
          const owner = requester('alice');
          // Step 2 failed with every item failed: it never gets a rollback window.
          const empty = await firstCompleted(c, owner);
          expect((await start(c, empty.second)).ok).toBe(true);
          await c.repository.recordItemOutcomes(empty.second, targets(1).map((targetId) => ({ targetId, status: 'failed', error: 'x' })));
          await c.repository.transition(empty.second, ['executing'], 'failed', auditEvent(empty.second));
          expect((await requestRollbackOf(c, empty.first)).ok).toBe(true);

          // Step 2 failed after writing an item: that write stands until step 2 is rolled back.
          const wrote = await firstCompleted(c, owner);
          expect((await start(c, wrote.second)).ok).toBe(true);
          await c.repository.recordItemOutcomes(wrote.second, written(targets(1)));
          await c.repository.transition(wrote.second, ['executing'], 'failed', auditEvent(wrote.second));
          expect(await requestRollbackOf(c, wrote.first)).toEqual({ ok: false, reason: 'plan_order' });
        }));

      it('EXE-8 EXE-13 a start of step 2 and a rollback request of step 1 at the same moment do not both succeed', async () =>
        withRepo(async (c) => {
          const owner = requester('alice');
          // PostgreSQL: each call checks out its own pooled connection, so the two transactions really race; several
          // rounds make the interleaving the plan lock closes likely.
          for (let round = 0; round < 8; round += 1) {
            const { first, second } = await firstCompleted(c, owner);
            const [started, rolledBack] = await Promise.all([start(c, second), requestRollbackOf(c, first)]);
            expect([started.ok, rolledBack.ok].filter(Boolean), `round ${String(round)}`).toHaveLength(1);
            if (started.ok) {
              expect(rolledBack).toEqual({ ok: false, reason: 'plan_order' });
              expect((await c.repository.get(first))?.status).toBe('completed');
            } else {
              expect(started).toEqual({ ok: false, reason: 'plan_blocked' });
              expect((await c.repository.get(second))?.status).toBe('prepared');
            }
          }
        }));

      it('EXE-8 a change-set outside a plan is rolled back as before', async () =>
        withRepo(async (c) => {
          await preparedSet(c, c.id, 1);
          expect((await start(c, c.id)).ok).toBe(true);
          await c.repository.transition(c.id, ['executing'], 'completed', auditEvent(c.id));
          await c.repository.openRollbackWindow(c.id, new Date(Date.now() + HOUR));
          expect((await requestRollbackOf(c, c.id)).ok).toBe(true);
        }));

      /** A change-set derived from `source` with its items copied, still `preparing`. */
      async function derivedFrom(c: Ctx, owner: string, source: string): Promise<string> {
        const derived = randomUUID();
        await c.repository.create({ ...newChangeSet(derived), requester: owner, derivedFrom: source }, auditEvent(derived));
        expect(await c.repository.copyItems(derived, source, [], [])).toBe(1);
        return derived;
      }

      function seal(c: Ctx, id: string): Promise<ChangeSetRecord | undefined> {
        return c.repository.completePreparation(
          id,
          { status: 'prepared', hashVersion: 1, hash: 'h', stats: stats({ total: 1, included: 1 }), preparedAt: NOW },
          auditEvent(id),
        );
      }

      it('CS-5 a change-set derived from a prepared step takes its place when it is sealed; the source leaves the plan', async () =>
        withRepo(async (c) => {
          const owner = requester('alice');
          const { planId, first, second } = await twoStepPlan(c, owner);
          const derived = await derivedFrom(c, owner, second);
          // The copy moves nothing: the slot moves with the seal.
          expect(await c.repository.get(derived)).not.toHaveProperty('plan');
          expect((await c.repository.get(second))?.plan).toEqual({ id: planId, step: 2 });
          expect((await seal(c, derived))?.plan).toEqual({ id: planId, step: 2 });
          expect((await c.repository.get(derived))?.plan).toEqual({ id: planId, step: 2 });
          expect(await c.repository.get(second)).not.toHaveProperty('plan');
          expect((await c.repository.planSteps(planId))?.steps.map((s) => [s.step, s.changesetId, s.status])).toEqual([
            [1, first, 'prepared'],
            [2, derived, 'prepared'],
          ]);
        }));

      it('CS-5 a derivation whose preparation fails leaves the source in its plan slot', async () =>
        withRepo(async (c) => {
          const owner = requester('alice');
          const { planId, second } = await twoStepPlan(c, owner);
          const derived = await derivedFrom(c, owner, second);
          await c.repository.completePreparation(derived, { status: 'failed', errorCode: 'cancelled' }, auditEvent(derived));
          expect(await c.repository.get(derived)).not.toHaveProperty('plan');
          expect((await c.repository.get(second))?.plan).toEqual({ id: planId, step: 2 });
        }));

      it('CS-5 the seal and the handover are atomic with the audit event', async () =>
        withRepo(async (c) => {
          const owner = requester('alice');
          const { planId, second } = await twoStepPlan(c, owner);
          const derived = await derivedFrom(c, owner, second);
          c.failNextAudit();
          await expect(seal(c, derived)).rejects.toThrow();
          expect((await c.repository.get(derived))?.status).toBe('preparing');
          expect(await c.repository.get(derived)).not.toHaveProperty('plan');
          expect((await c.repository.get(second))?.plan).toEqual({ id: planId, step: 2 });
        }));

      it('CS-5 a change-set derived from a step that is no longer prepared stays outside the plan', async () =>
        withRepo(async (c) => {
          const owner = requester('alice');
          const { planId, second } = await twoStepPlan(c, owner);
          const derived = await derivedFrom(c, owner, second);
          await c.repository.transition(second, ['prepared'], 'cancelled', auditEvent(second));
          expect(await seal(c, derived)).not.toHaveProperty('plan');
          expect((await c.repository.get(second))?.plan).toEqual({ id: planId, step: 2 });
        }));
    });

    describe('NTF-1 outbox rows commit with the event they announce', () => {
      const ask = (target: string, step = 1): NewNotification => ({ kind: 'approval_requested', round: 1, step, target });

      async function preparedRecord(c: Ctx, id = c.id): Promise<ChangeSetRecord> {
        await preparedSet(c, id, 1);
        const record = await c.repository.get(id);
        if (record === undefined) throw new Error('missing change-set');
        return record;
      }

      it('NTF-1 submitForApproval stores its notifications in the same transaction', async () =>
        withRepo(async (c) => {
          await submitChangeSet(c.repository, await preparedRecord(c), { at: NOW, notifications: [ask('mail'), ask('chat')] });
          const rows = await c.notifications(c.id);
          expect(rows.map((r) => r.target).sort()).toEqual(['chat', 'mail']);
          for (const r of rows) {
            expect(r).toMatchObject({ kind: 'approval_requested', changesetId: c.id, round: 1, step: 1, state: 'pending', attempts: 0 });
            expect(r.lastError).toBeUndefined();
            expect(r.sentAt).toBeUndefined();
          }

          const other = randomUUID();
          const otherRecord = await preparedRecord(c, other);
          c.failNextAudit();
          await expect(submitChangeSet(c.repository, otherRecord, { at: NOW, notifications: [ask('mail')] })).rejects.toThrow();
          expect(await c.notifications(other)).toEqual([]);
          expect((await c.repository.get(other))?.status).toBe('prepared');
        }));

      it('NTF-1 submitForApproval stores no notifications when refused', async () =>
        withRepo(async (c) => {
          const record = await preparedRecord(c);
          await expect(
            submitChangeSet(c.repository, { ...record, hash: 'other' }, { at: NOW, notifications: [ask('mail')] }),
          ).rejects.toThrow(/hash_mismatch/);
          expect(await c.notifications(c.id)).toEqual([]);
        }));

      it('NTF-1 recordDecision stores its notifications; a losing concurrent decision stores none', async () =>
        withRepo(async (c) => {
          const submitted = await submitChangeSet(c.repository, await preparedRecord(c), { steps: ['lead', 'brand'], at: NOW });
          const decided = (target: string): NewNotification => ({ kind: 'approval_decided', round: 1, step: 1, target });
          const results = await Promise.allSettled([
            recordApproval(c.repository, submitted, { approver: 'bob', decision: 'rejected', notifications: [decided('from-bob')] }),
            recordApproval(c.repository, submitted, { approver: 'carol', decision: 'rejected', notifications: [decided('from-carol')] }),
          ]);
          expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
          const [winner] = await c.repository.approvals(c.id);
          const rows = await c.notifications(c.id);
          expect(rows.map((r) => [r.kind, r.round, r.step, r.target])).toEqual([
            ['approval_decided', 1, 1, winner?.approver === 'bob' ? 'from-bob' : 'from-carol'],
          ]);
        }));

      it('NTF-1 recordDecision stores no notifications when its audit append fails', async () =>
        withRepo(async (c) => {
          const submitted = await submitChangeSet(c.repository, await preparedRecord(c), { steps: ['lead', 'brand'], at: NOW });
          c.failNextAudit();
          await expect(
            recordApproval(c.repository, submitted, { approver: 'bob', notifications: [ask('brand-mail', 2)] }),
          ).rejects.toThrow();
          expect(await c.notifications(c.id)).toEqual([]);
          await recordApproval(c.repository, submitted, { approver: 'bob', notifications: [ask('brand-mail', 2)] });
          expect((await c.notifications(c.id)).map((r) => [r.step, r.target])).toEqual([[2, 'brand-mail']]);
        }));

      it('NTF-1 transition stores its notifications only when the compare-and-set succeeds', async () =>
        withRepo(async (c) => {
          await preparedRecord(c);
          const done: NewNotification = { kind: 'execution_finished', round: 0, step: 0, target: 'chat' };
          expect(
            await c.repository.transition(c.id, ['executing'], 'completed', auditEvent(c.id), { notifications: [done] }),
          ).toBeUndefined();
          expect(await c.notifications(c.id)).toHaveLength(0);
          c.failNextAudit();
          await expect(
            c.repository.transition(c.id, ['prepared'], 'executing', auditEvent(c.id), { notifications: [done] }),
          ).rejects.toThrow();
          expect(await c.notifications(c.id)).toHaveLength(0);
          expect(
            await c.repository.transition(c.id, ['prepared'], 'executing', auditEvent(c.id), { notifications: [done] }),
          ).toBeDefined();
          expect((await c.notifications(c.id)).map((r) => [r.kind, r.step, r.target])).toEqual([['execution_finished', 0, 'chat']]);
        }));

      it('NTF-1 startExecution stores its notifications only when it starts', async () =>
        withRepo(async (c) => {
          await preparedRecord(c);
          const row: NewNotification = { kind: 'execution_finished', round: 0, step: 0, target: 'chat' };
          const run = (expectedHash: string): ReturnType<ChangeSetRepository['startExecution']> =>
            c.repository.startExecution({
              changesetId: c.id,
              expectedHash,
              request: { ...REQUEST, groups: [...REQUEST.groups] },
              notifications: [row],
              now: NOW,
              event: startEventFactory({ newId: randomUUID, ...REQUEST }),
            });
          expect(await run('wrong')).toEqual({ ok: false, reason: 'hash_mismatch' });
          expect(await c.notifications(c.id)).toEqual([]);
          expect((await run('h')).ok).toBe(true);
          expect((await c.notifications(c.id)).map((r) => r.target)).toEqual(['chat']);
        }));
    });

    describe('EXE-8 rollback request', () => {
      /** The default run: `a` written, `b` written as already applied, `c` failed. */
      const RUN: readonly ItemOutcome[] = [
        { targetId: 'a', status: 'written' },
        { targetId: 'b', status: 'written', error: 'already_applied' },
        { targetId: 'c', status: 'failed', error: 'upstream_5xx' },
      ];

      /**
       * Created with one pending item per outcome, prepared, started (so `executionRequest` is set), the
       * outcomes recorded, then moved to `status` (`cancelled` through `requestCancel` and the transition).
       */
      async function finished(
        c: Ctx,
        status: 'completed' | 'completed_with_errors' | 'cancelled' | 'failed',
        items: readonly ItemOutcome[] = RUN,
      ): Promise<ChangeSetRecord> {
        await c.repository.create(newChangeSet(c.id), auditEvent(c.id));
        await c.repository.appendItems(c.id, items.map((o) => item(o.targetId)));
        await c.repository.completePreparation(
          c.id,
          { status: 'prepared', hashVersion: 1, hash: 'h', stats: await c.repository.stats(c.id), preparedAt: NOW },
          auditEvent(c.id),
        );
        expect((await start(c, c.id)).ok).toBe(true);
        await c.repository.recordItemOutcomes(c.id, items);
        if (status === 'cancelled') {
          const cancel = await c.repository.requestCancel(c.id, { actor: 'alice', correlationId: 'corr-c', requestedAt: NOW });
          expect(cancel.ok).toBe(true);
        }
        const moved = await c.repository.transition(c.id, ['executing'], status, auditEvent(c.id));
        if (moved === undefined) throw new Error(`could not move to ${status}`);
        return moved;
      }

      /** Wall-clock offsets: the PostgreSQL implementation judges the window on the database clock. */
      const fromNow = (ms: number): Date => new Date(Date.now() + ms);

      function rollbackRequest(over: Partial<RollbackRequest> = {}): RollbackRequest {
        return { actor: 'alice', clientId: 'cli', correlationId: `corr-rb-${randomUUID()}`, requestedAt: new Date(), ...over };
      }

      async function request(
        c: Ctx,
        req: RollbackRequest = rollbackRequest(),
        marginMs = ROLLBACK_REQUEST_MARGIN_MS,
      ): ReturnType<ChangeSetRepository['requestRollback']> {
        const cs = await c.repository.get(c.id);
        const audit =
          cs === undefined
            ? [auditEvent(c.id)]
            : rollbackRequestEvents({ newId: randomUUID, changeset: cs, request: req, channel: 'page', count: 1 });
        return c.repository.requestRollback({ changesetId: c.id, request: req, marginMs, audit });
      }

      it('EXE-8 rollbackableCount counts written items without error only', async () =>
        withRepo(async (c) => {
          await finished(c, 'completed_with_errors');
          expect(await c.repository.rollbackableCount(c.id)).toBe(1);
          expect(await c.repository.rollbackableCount(randomUUID())).toBe(0);
          expect(await c.repository.rollbackableCount('x')).toBe(0);
        }));

      it('EXE-8 openRollbackWindow writes the window once and answers the stored value', async () =>
        withRepo(async (c) => {
          await finished(c, 'completed');
          const t1 = new Date('2026-12-01T00:00:00.000Z');
          const t2 = new Date('2026-12-02T00:00:00.000Z');
          expect(await c.repository.openRollbackWindow(c.id, t1)).toEqual(t1);
          expect(await c.repository.openRollbackWindow(c.id, t2)).toEqual(t1);
          expect((await c.repository.get(c.id))?.rollbackUntil).toEqual(t1);
          expect(await c.repository.openRollbackWindow(randomUUID(), t1)).toBeUndefined();
          expect(await c.repository.openRollbackWindow('x', t1)).toBeUndefined();
        }));

      it('EXE-8 requestRollback moves a completed change-set to rolling_back with the request and both audit rows', async () =>
        withRepo(async (c) => {
          const cs = await finished(c, 'completed');
          await c.repository.openRollbackWindow(c.id, fromNow(HOUR));
          const req = rollbackRequest();
          const before = (await c.events()).length;
          const audit = rollbackRequestEvents({ newId: randomUUID, changeset: cs, request: req, channel: 'page', count: 1 });
          const answer = await c.repository.requestRollback({
            changesetId: c.id,
            request: req,
            marginMs: ROLLBACK_REQUEST_MARGIN_MS,
            audit,
          });
          expect(answer.ok).toBe(true);
          if (!answer.ok) return;
          expect(answer.changeset.status).toBe('rolling_back');
          expect(answer.changeset.rollbackRequest).toEqual(req);
          expect((await c.repository.get(c.id))?.rollbackRequest).toEqual(req);
          expect((await c.events()).slice(before).map((e) => e.id)).toEqual(audit.map((e) => e.id));
        }));

      it('EXE-8 requestRollback refusals write nothing', async () =>
        withRepo(async (c) => {
          const unchanged = async (id: string, status: ChangeSetStatus, events: number): Promise<void> => {
            const cs = await c.repository.get(id);
            expect(cs?.status).toBe(status);
            expect(cs?.rollbackRequest).toBeUndefined();
            expect(await eventsOf(c, id)).toHaveLength(events);
          };

          await finished(c, 'completed');
          let events = (await c.events()).length;
          expect(await request(c)).toEqual({ ok: false, reason: 'window_closed' });
          await unchanged(c.id, 'completed', events);
          await c.repository.openRollbackWindow(c.id, fromNow(30_000));
          expect(await request(c, rollbackRequest(), 60_000)).toEqual({ ok: false, reason: 'window_closed' });
          await unchanged(c.id, 'completed', events);

          const prep = { ...c, id: randomUUID() };
          await preparedSet(c, prep.id, 1);
          events = (await eventsOf(c, prep.id)).length;
          expect(await request(prep)).toEqual({ ok: false, reason: 'not_finished' });
          await unchanged(prep.id, 'prepared', events);

          const neverRan = { ...c, id: randomUUID() };
          await preparedSet(c, neverRan.id, 1);
          await c.repository.transition(neverRan.id, ['prepared'], 'cancelled', auditEvent(neverRan.id));
          await c.repository.openRollbackWindow(neverRan.id, fromNow(HOUR));
          events = (await eventsOf(c, neverRan.id)).length;
          expect(await request(neverRan)).toEqual({ ok: false, reason: 'not_finished' });
          await unchanged(neverRan.id, 'cancelled', events);

          const done = { ...c, id: randomUUID() };
          await finished(done, 'completed');
          await c.repository.openRollbackWindow(done.id, fromNow(HOUR));
          const first = rollbackRequest();
          expect((await request(done, first)).ok).toBe(true);
          events = (await eventsOf(c, done.id)).length;
          expect(await request(done, rollbackRequest({ actor: 'bob' }))).toEqual({ ok: false, reason: 'already_rolled_back' });
          expect((await c.repository.get(done.id))?.rollbackRequest).toEqual(first);
          expect(await eventsOf(c, done.id)).toHaveLength(events);

          for (const id of [randomUUID(), 'x']) {
            expect(await request({ ...c, id })).toEqual({ ok: false, reason: 'not_found' });
            expect(await eventsOf(c, id)).toHaveLength(0);
          }
        }));

      it('EXE-8 only one of two concurrent requests wins', async () =>
        withRepo(async (c) => {
          const cs = await finished(c, 'completed');
          await c.repository.openRollbackWindow(c.id, fromNow(HOUR));
          const before = (await c.events()).length;
          const ask = (actor: string): ReturnType<ChangeSetRepository['requestRollback']> => {
            const req = rollbackRequest({ actor });
            return c.repository.requestRollback({
              changesetId: c.id,
              request: req,
              marginMs: ROLLBACK_REQUEST_MARGIN_MS,
              audit: rollbackRequestEvents({ newId: randomUUID, changeset: cs, request: req, channel: 'page', count: 1 }),
            });
          };
          // PostgreSQL: each transaction checks out its own pooled connection (pg.Pool default max 10, the
          // harness sets none lower), so the two requests really race on the row lock.
          const results = await Promise.all([ask('alice'), ask('bob')]);
          expect(results.filter((r) => r.ok)).toHaveLength(1);
          expect(results.filter((r) => !r.ok)).toEqual([{ ok: false, reason: 'already_rolled_back' }]);
          expect((await c.events()).slice(before)).toHaveLength(2);
          expect((await c.repository.get(c.id))?.status).toBe('rolling_back');
        }));

      it('EXE-8 a cancelled and a failed run that wrote items can be requested', async () =>
        withRepo(async (c) => {
          for (const status of ['cancelled', 'failed'] as const) {
            const run = { ...c, id: randomUUID() };
            const cs = await finished(run, status);
            expect(cs.executionRequest).toBeDefined();
            await c.repository.openRollbackWindow(run.id, fromNow(HOUR));
            const answer = await request(run);
            expect(answer.ok).toBe(true);
            expect((await c.repository.get(run.id))?.status).toBe('rolling_back');
          }
        }));

      it('EXE-8 get and itemsPage carry the rollback fields; stats.rollback appears only once an item has a rollback status', async () =>
        withRepo(async (c) => {
          await finished(c, 'completed');
          const fresh = await c.repository.get(c.id);
          expect(fresh?.rollbackUntil).toBeUndefined();
          expect(fresh?.rollbackRequest).toBeUndefined();
          await c.repository.openRollbackWindow(c.id, fromNow(HOUR));
          const withoutClient: RollbackRequest = { actor: 'alice', correlationId: `corr-rb-${randomUUID()}`, requestedAt: new Date() };
          expect((await request(c, withoutClient)).ok).toBe(true);
          const cs = await c.repository.get(c.id);
          expect(cs?.rollbackRequest).toEqual(withoutClient);
          expect(cs?.rollbackRequest && 'clientId' in cs.rollbackRequest).toBe(false);
          for (const it of await c.repository.itemsPage(c.id, { limit: 10 })) {
            expect(it.rollbackStatus).toBeUndefined();
            expect(it.rollbackError).toBeUndefined();
            expect('rollbackStatus' in it).toBe(false);
          }
          expect((await c.repository.stats(c.id)).rollback).toBeUndefined();
          expect(cs?.stats.rollback).toBeUndefined();
        }));

      describe('EXE-8 rollback batches', () => {
        /** Five items this run wrote (t-1…t-5), one written as already applied and one failed, between them. */
        const BATCH_RUN: readonly ItemOutcome[] = [
          ...written(['t-1', 't-2', 't-3', 't-4', 't-5']),
          { targetId: 't-2a', status: 'written', error: 'already_applied' },
          { targetId: 't-4a', status: 'failed', error: 'upstream_5xx' },
        ];

        /** BATCH_RUN finished `completed`, the window open and the rollback requested. */
        async function rollingBack(c: Ctx): Promise<void> {
          await finished(c, 'completed', BATCH_RUN);
          await c.repository.openRollbackWindow(c.id, fromNow(HOUR));
          expect((await request(c)).ok).toBe(true);
        }

        function rollbackAudit(id: string, batchNo: number, outcomes: readonly RollbackItemOutcome[]): AuditEventInput {
          const count = (s: RollbackItemOutcome['status']): number => outcomes.filter((o) => o.status === s).length;
          return changesetRollbackBatchEvent({
            id: randomUUID(),
            changeset: { id, operation: 'catalog.update' },
            batchNo,
            counts: { restored: count('restored'), skipped: count('skipped'), failed: count('failed') },
            correlationId: 'corr-rb',
          });
        }

        function restored(ids: readonly string[]): RollbackItemOutcome[] {
          return ids.map((targetId) => ({ targetId, status: 'restored' }));
        }

        async function claimedIds(c: Ctx, batchNo: number, attempt: number, size: number): Promise<readonly string[]> {
          const claim = await c.repository.claimRollbackBatch(c.id, batchNo, attempt, size);
          if (claim.kind !== 'claimed') throw new Error(`expected a claim, got ${claim.kind}`);
          expect(claim.batch.targetIds).toEqual(claim.items.map((i) => i.targetId));
          return claim.batch.targetIds;
        }

        it('EXE-8 EXE-3 rollback batches claim only rollbackable items in target order', async () =>
          withRepo(async (c) => {
            await rollingBack(c);
            expect(await claimedIds(c, 1, 1, 2)).toEqual(['t-1', 't-2']);
            expect(await claimedIds(c, 2, 1, 2)).toEqual(['t-3', 't-4']);
            expect(await claimedIds(c, 3, 1, 2)).toEqual(['t-5']);
            expect(await c.repository.claimRollbackBatch(c.id, 4, 1, 2)).toEqual({ kind: 'empty' });
            expect(await c.repository.claimRollbackBatch(randomUUID(), 1, 1, 2)).toEqual({ kind: 'empty' });
            expect(await c.repository.claimRollbackBatch('x', 1, 1, 2)).toEqual({ kind: 'empty' });
            await expect(c.repository.claimRollbackBatch(c.id, 5, 1, 0)).rejects.toThrow();
            // Execution batches are a separate sequence: none was claimed by the rollback claims.
            expect(await c.repository.claimBatch(c.id, 1, 1, 10)).toEqual({ kind: 'fenced' });
          }));

        it('EXE-3 NFR-2 a done rollback batch answers its stored counts; a lower or equal attempt is fenced; a takeover claims the same items', async () =>
          withRepo(async (c) => {
            await rollingBack(c);
            expect(await claimedIds(c, 1, 2, 2)).toEqual(['t-1', 't-2']);
            expect(await c.repository.claimRollbackBatch(c.id, 1, 1, 2)).toEqual({ kind: 'fenced' });
            expect(await c.repository.claimRollbackBatch(c.id, 1, 2, 2)).toEqual({ kind: 'fenced' });
            // A takeover with a different size still claims the batch's own items.
            expect(await claimedIds(c, 1, 3, 5)).toEqual(['t-1', 't-2']);
            // The superseded attempt can neither record nor complete.
            expect(await c.repository.recordRollbackSubmission(c.id, 1, 2, { upstreamBatchId: 'u-old', plan: [] })).toBe(false);
            const outcomes: RollbackItemOutcome[] = [
              { targetId: 't-1', status: 'restored' },
              { targetId: 't-2', status: 'failed', error: 'upstream_5xx' },
            ];
            const stale = await c.repository.completeRollbackBatch(c.id, 1, 2, outcomes, rollbackAudit(c.id, 1, outcomes));
            expect(stale).toEqual({ ok: false });
            expect(await c.repository.completeRollbackBatch(c.id, 1, 3, outcomes, rollbackAudit(c.id, 1, outcomes))).toEqual({
              ok: true,
              counts: { restored: 1, skipped: 0, failed: 1 },
            });
            for (const attempt of [1, 3, 4]) {
              expect(await c.repository.claimRollbackBatch(c.id, 1, attempt, 2)).toEqual({
                kind: 'done',
                counts: { restored: 1, skipped: 0, failed: 1 },
              });
            }
          }));

        it('EXE-3 a rollback batch is not claimed unless the change-set is rolling_back', async () =>
          withRepo(async (c) => {
            await finished(c, 'completed', BATCH_RUN);
            await c.repository.openRollbackWindow(c.id, fromNow(HOUR));
            expect(await c.repository.claimRollbackBatch(c.id, 1, 1, 2)).toEqual({ kind: 'fenced' });
            expect(await c.repository.nextRollbackBatch(c.id)).toBe(1);

            // A takeover after the rollback ended is fenced too; a done batch still answers its counts.
            const ended = { ...c, id: randomUUID() };
            await rollingBack(ended);
            expect(await claimedIds(ended, 1, 1, 2)).toEqual(['t-1', 't-2']);
            expect(await claimedIds(ended, 2, 1, 2)).toEqual(['t-3', 't-4']);
            const outcomes = restored(['t-1', 't-2']);
            const done = await c.repository.completeRollbackBatch(ended.id, 1, 1, outcomes, rollbackAudit(ended.id, 1, outcomes));
            expect(done.ok).toBe(true);
            await c.repository.transition(ended.id, ['rolling_back'], 'failed', auditEvent(ended.id));
            expect(await c.repository.claimRollbackBatch(ended.id, 2, 2, 2)).toEqual({ kind: 'fenced' });
            expect(await c.repository.claimRollbackBatch(ended.id, 3, 1, 2)).toEqual({ kind: 'fenced' });
            expect(await c.repository.claimRollbackBatch(ended.id, 1, 2, 2)).toEqual({
              kind: 'done',
              counts: { restored: 2, skipped: 0, failed: 0 },
            });
          }));

        it('EXE-4 recordRollbackSubmission stores the submission for the owning attempt only', async () =>
          withRepo(async (c) => {
            await rollingBack(c);
            await claimedIds(c, 1, 1, 2);
            const submission: BatchSubmission = {
              upstreamBatchId: 'u-rb-1',
              plan: [
                { targetId: 't-1', action: 'write' },
                { targetId: 't-2', action: 'outcome', status: 'skipped', error: 'drift' },
              ],
            };
            expect(await c.repository.recordRollbackSubmission(c.id, 1, 2, submission)).toBe(false);
            expect(await c.repository.recordRollbackSubmission(c.id, 9, 1, submission)).toBe(false);
            expect(await c.repository.recordRollbackSubmission(randomUUID(), 1, 1, submission)).toBe(false);
            expect(await c.repository.recordRollbackSubmission('x', 1, 1, submission)).toBe(false);
            expect(await c.repository.recordRollbackSubmission(c.id, 1, 1, submission)).toBe(true);
            const takeover = await c.repository.claimRollbackBatch(c.id, 1, 2, 2);
            expect(takeover.kind).toBe('claimed');
            if (takeover.kind !== 'claimed') return;
            expect(takeover.batch.submission).toEqual(submission);
            expect(await c.repository.recordRollbackSubmission(c.id, 1, 1, { upstreamBatchId: 'u-stale', plan: [] })).toBe(false);
            // The execution batch table is untouched.
            expect(await c.repository.recordSubmission(c.id, 1, 1, submission)).toBe(false);
          }));

        it('EXE-8 completeRollbackBatch applies outcomes once and recomputes stats.rollback', async () =>
          withRepo(async (c) => {
            await rollingBack(c);
            const before = await c.repository.itemsPage(c.id, { limit: 10 });
            expect(await claimedIds(c, 1, 1, 3)).toEqual(['t-1', 't-2', 't-3']);
            const outcomes: RollbackItemOutcome[] = [
              { targetId: 't-1', status: 'restored' },
              { targetId: 't-2', status: 'skipped', error: 'drift' },
              { targetId: 't-3', status: 'restored', error: 'already_restored' },
              // Ignored: a second outcome for a target, a target outside the batch, an item never rollbackable.
              { targetId: 't-1', status: 'failed', error: 'upstream_5xx' },
              { targetId: 't-4', status: 'restored' },
              { targetId: 't-2a', status: 'restored' },
            ];
            const audit = rollbackAudit(c.id, 1, outcomes.slice(0, 3));

            // A failed audit append writes nothing.
            const eventsBefore = (await c.events()).length;
            c.failNextAudit();
            await expect(c.repository.completeRollbackBatch(c.id, 1, 1, outcomes, audit)).rejects.toThrow();
            expect(await c.repository.itemsPage(c.id, { limit: 10 })).toEqual(before);
            expect((await c.repository.get(c.id))?.stats.rollback).toBeUndefined();
            expect(await c.events()).toHaveLength(eventsBefore);

            const counts = { restored: 2, skipped: 1, failed: 0 };
            expect(await c.repository.completeRollbackBatch(c.id, 1, 1, outcomes, audit)).toEqual({ ok: true, counts });
            const after = await c.repository.itemsPage(c.id, { limit: 10 });
            const byId = new Map(after.map((i) => [i.targetId, i]));
            expect(byId.get('t-1')).toMatchObject({ rollbackStatus: 'restored' });
            expect('rollbackError' in (byId.get('t-1') ?? {})).toBe(false);
            expect(byId.get('t-2')).toMatchObject({ rollbackStatus: 'skipped', rollbackError: 'drift' });
            expect(byId.get('t-3')).toMatchObject({ rollbackStatus: 'restored', rollbackError: 'already_restored' });
            for (const id of ['t-2a', 't-4', 't-4a', 't-5']) expect(byId.get(id)?.rollbackStatus).toBeUndefined();
            // Execution status and error of every item are unchanged.
            expect(after.map((i) => [i.targetId, i.status, i.error])).toEqual(before.map((i) => [i.targetId, i.status, i.error]));
            const cs = await c.repository.get(c.id);
            expect(cs?.stats.rollback).toEqual(counts);
            expect(cs?.stats).toMatchObject({ written: 6, failed: 1, skipped: 0 });
            expect((await c.repository.stats(c.id)).rollback).toEqual(counts);
            expect(await c.repository.rollbackableCount(c.id)).toBe(2);
            expect((await c.events()).slice(eventsBefore).map((e) => e.id)).toEqual([audit.id]);

            // A second completion of the batch is fenced and writes nothing.
            const again = rollbackAudit(c.id, 1, outcomes);
            expect(await c.repository.completeRollbackBatch(c.id, 1, 1, restored(['t-2']), again)).toEqual({ ok: false });
            expect(await c.repository.itemsPage(c.id, { limit: 10 })).toEqual(after);
            expect(await c.events()).toHaveLength(eventsBefore + 1);
            expect(await c.repository.completeRollbackBatch(randomUUID(), 1, 1, outcomes, again)).toEqual({ ok: false });
            expect(await c.repository.completeRollbackBatch('x', 1, 1, outcomes, again)).toEqual({ ok: false });
          }));

        it('EXE-8 nextRollbackBatch is 1, then the open batch, then highest done + 1', async () =>
          withRepo(async (c) => {
            await rollingBack(c);
            expect(await c.repository.nextRollbackBatch(c.id)).toBe(1);
            await claimedIds(c, 1, 1, 2);
            expect(await c.repository.nextRollbackBatch(c.id)).toBe(1);
            const first = restored(['t-1', 't-2']);
            expect((await c.repository.completeRollbackBatch(c.id, 1, 1, first, rollbackAudit(c.id, 1, first))).ok).toBe(true);
            expect(await c.repository.nextRollbackBatch(c.id)).toBe(2);
            await claimedIds(c, 2, 1, 2);
            expect(await c.repository.nextRollbackBatch(c.id)).toBe(2);
            const second = restored(['t-3', 't-4']);
            expect((await c.repository.completeRollbackBatch(c.id, 2, 1, second, rollbackAudit(c.id, 2, second))).ok).toBe(true);
            expect(await c.repository.nextRollbackBatch(c.id)).toBe(3);
            expect(await c.repository.nextRollbackBatch(randomUUID())).toBe(1);
            expect(await c.repository.nextRollbackBatch('x')).toBe(1);
          }));

        it('EXE-8 completeRollbackBatch is rejected after the change-set left rolling_back', async () =>
          withRepo(async (c) => {
            await rollingBack(c);
            await claimedIds(c, 1, 1, 2);
            const before = await c.repository.itemsPage(c.id, { limit: 10 });
            await c.repository.transition(c.id, ['rolling_back'], 'rolled_back', auditEvent(c.id));
            const events = (await c.events()).length;
            const outcomes = restored(['t-1', 't-2']);
            await expect(
              c.repository.completeRollbackBatch(c.id, 1, 1, outcomes, rollbackAudit(c.id, 1, outcomes)),
            ).rejects.toThrow();
            expect(await c.repository.itemsPage(c.id, { limit: 10 })).toEqual(before);
            expect((await c.repository.get(c.id))?.stats.rollback).toBeUndefined();
            expect(await c.events()).toHaveLength(events);
            expect(await c.repository.nextRollbackBatch(c.id)).toBe(1);
          }));
      });
    });

    describe('EXE-12 verification storage', () => {
      const SCHEDULE = {
        firstAt: new Date('2026-12-01T00:00:30.000Z'),
        until: new Date('2026-12-01T00:10:00.000Z'),
      };

      /** Executing, with `a`, `b`, `c` written, `d` failed and `e` excluded. */
      async function executed(c: Ctx): Promise<void> {
        await c.repository.create(newChangeSet(c.id), auditEvent(c.id));
        await c.repository.appendItems(c.id, [
          item('c'),
          item('a'),
          item('e', { status: 'excluded', reason: 'no_change' }),
          item('b'),
          item('d'),
        ]);
        await c.repository.completePreparation(
          c.id,
          { status: 'prepared', hashVersion: 1, hash: 'h', stats: await c.repository.stats(c.id), preparedAt: NOW },
          auditEvent(c.id),
        );
        expect((await start(c, c.id)).ok).toBe(true);
        await c.repository.recordItemOutcomes(c.id, [
          ...written(['a', 'b', 'c']),
          { targetId: 'd', status: 'failed', error: 'upstream_5xx' },
        ]);
      }

      function finishAudit(c: Ctx): (counts: VerificationCounts) => AuditEventInput {
        return (counts) =>
          changesetVerificationEvent({
            id: randomUUID(),
            changeset: { id: c.id, operation: 'catalog.update' },
            end: 'timeout',
            counts,
            actor: 'system',
            correlationId: 'corr-v',
          });
      }

      async function verificationEvents(c: Ctx): Promise<readonly AuditEventInput[]> {
        return (await c.events()).filter((e) => e.action === 'changeset.verification');
      }

      async function byTarget(c: Ctx): Promise<Record<string, ChangeItemRecord>> {
        return Object.fromEntries((await c.repository.itemsPage(c.id, { limit: 10 })).map((i) => [i.targetId, i]));
      }

      async function ids(c: Ctx, round: number, limit: number): Promise<readonly string[]> {
        return (await c.repository.verificationItems(c.id, round, limit)).map((i) => i.targetId);
      }

      /** What the hash and the execution own: verification must leave all of it as it was. */
      async function sealed(c: Ctx): Promise<{ items: readonly unknown[]; hash: string }> {
        const cs = await c.repository.get(c.id);
        if (cs === undefined) throw new Error('change-set missing');
        const items = (await c.repository.itemsPage(c.id, { limit: 10 })).map((i) => ({
          targetId: i.targetId,
          status: i.status,
          reason: i.reason,
          before: i.before,
          after: i.after,
          error: i.error,
        }));
        return { items, hash: await hashStoredItems(c.repository, cs) };
      }

      it('EXE-12 no verification key in stats and no verification fields before verification began', async () =>
        withRepo(async (c) => {
          await executed(c);
          expect('verification' in (await c.repository.stats(c.id))).toBe(false);
          const cs = await c.repository.get(c.id);
          expect(cs !== undefined && 'verification' in cs.stats).toBe(false);
          expect(cs !== undefined && 'verificationUntil' in cs).toBe(false);
          for (const it of await c.repository.itemsPage(c.id, { limit: 10 })) {
            expect('verificationStatus' in it).toBe(false);
            expect('verificationCode' in it).toBe(false);
          }
        }));

      it('EXE-12 NFR-2 beginVerification marks the written items pending and stores the schedule once', async () =>
        withRepo(async (c) => {
          await executed(c);
          expect(await c.repository.beginVerification(c.id, SCHEDULE)).toEqual({ ...SCHEDULE, round: 0, pending: 3 });
          const counts = { pending: 3, confirmed: 0, unconfirmed: 0 };
          expect((await c.repository.stats(c.id)).verification).toEqual(counts);
          const cs = await c.repository.get(c.id);
          expect(cs?.stats.verification).toEqual(counts);
          expect(cs?.verificationUntil).toEqual(SCHEDULE.until);
          const items = await byTarget(c);
          for (const t of ['a', 'b', 'c']) expect(items[t]?.verificationStatus).toBe('pending');
          for (const t of ['d', 'e']) {
            expect(items[t] !== undefined && 'verificationStatus' in items[t]).toBe(false);
            expect(items[t] !== undefined && 'verificationCode' in items[t]).toBe(false);
          }
          // A retry or a continued run with a later clock answers the stored schedule.
          const later = { firstAt: new Date('2026-12-02T00:00:00.000Z'), until: new Date('2026-12-02T01:00:00.000Z') };
          expect(await c.repository.beginVerification(c.id, later)).toEqual({ ...SCHEDULE, round: 0, pending: 3 });
          expect((await c.repository.get(c.id))?.verificationUntil).toEqual(SCHEDULE.until);
        }));

      it('EXE-12 rounds: items, outcomes, a confirmed item stays confirmed, the finish is written once', async () =>
        withRepo(async (c) => {
          await executed(c);
          const before = await sealed(c);
          await c.repository.beginVerification(c.id, SCHEDULE);
          expect(await ids(c, 1, 2)).toEqual(['a', 'b']);
          expect(
            await c.repository.recordVerification(c.id, 1, [
              { targetId: 'a', confirmed: true },
              { targetId: 'b', confirmed: false, code: 'x' },
            ]),
          ).toEqual({ left: 1, pending: 2 });
          expect(await ids(c, 1, 10)).toEqual(['c']);
          expect(await ids(c, 2, 10)).toEqual(['b', 'c']);
          expect((await c.repository.stats(c.id)).verification).toEqual({ pending: 2, confirmed: 1, unconfirmed: 0 });
          // A continued run finds the highest round an item reached.
          expect((await c.repository.beginVerification(c.id, SCHEDULE))?.round).toBe(1);

          expect(await c.repository.recordVerification(c.id, 2, [{ targetId: 'a', confirmed: false, code: 'y' }])).toEqual({
            left: 2,
            pending: 2,
          });
          const a = (await byTarget(c)).a;
          expect(a?.verificationStatus).toBe('confirmed');
          expect(a !== undefined && 'verificationCode' in a).toBe(false);

          const counts = { pending: 0, confirmed: 1, unconfirmed: 2 };
          expect(await c.repository.finishVerification(c.id, 'verify_timeout', finishAudit(c))).toEqual(counts);
          const items = await byTarget(c);
          expect(items.b).toMatchObject({ verificationStatus: 'unconfirmed', verificationCode: 'x' });
          expect(items.c).toMatchObject({ verificationStatus: 'unconfirmed', verificationCode: 'verify_timeout' });
          expect(items.a?.verificationStatus).toBe('confirmed');
          expect((await c.repository.get(c.id))?.stats.verification).toEqual(counts);
          const events = await verificationEvents(c);
          expect(events).toHaveLength(1);
          expect(events[0]?.details).toMatchObject(counts);

          // A retried finish changes nothing and appends nothing.
          expect(await c.repository.finishVerification(c.id, 'verify_cancelled', finishAudit(c))).toEqual(counts);
          expect((await byTarget(c)).c?.verificationCode).toBe('verify_timeout');
          expect(await verificationEvents(c)).toHaveLength(1);
          expect(await c.repository.recordVerification(c.id, 3, [{ targetId: 'b', confirmed: true }])).toEqual({
            left: 0,
            pending: 0,
          });
          expect((await byTarget(c)).b?.verificationStatus).toBe('unconfirmed');

          // Item status, before, after and the hash inputs are untouched.
          expect(await sealed(c)).toEqual(before);
          expect((await c.repository.get(c.id))?.status).toBe('executing');
        }));

      it('EXE-12 NFR-2 a delayed outcome of an older round neither lowers the round nor replaces a newer code', async () =>
        withRepo(async (c) => {
          await executed(c);
          await c.repository.beginVerification(c.id, SCHEDULE);
          await c.repository.recordVerification(c.id, 3, [{ targetId: 'a', confirmed: false, code: 'newer' }]);
          // A retried look of round 2 arrives late.
          expect(await c.repository.recordVerification(c.id, 2, [{ targetId: 'a', confirmed: false, code: 'older' }])).toMatchObject({
            pending: 3,
          });
          expect((await byTarget(c)).a?.verificationCode).toBe('newer');
          // `a` stays at round 3: not looked at again in round 3, but in round 4.
          expect(await ids(c, 3, 10)).toEqual(['b', 'c']);
          expect(await ids(c, 4, 10)).toEqual(['a', 'b', 'c']);
          expect((await c.repository.beginVerification(c.id, SCHEDULE))?.round).toBe(3);
          // The same round again replaces the code; a confirmation of any round confirms.
          await c.repository.recordVerification(c.id, 3, [{ targetId: 'a', confirmed: false, code: 'again' }]);
          expect((await byTarget(c)).a?.verificationCode).toBe('again');
          await c.repository.recordVerification(c.id, 1, [{ targetId: 'a', confirmed: true }]);
          expect((await byTarget(c)).a?.verificationStatus).toBe('confirmed');
        }));

      it('EXE-12 finishVerification with nothing pending appends the audit row once', async () =>
        withRepo(async (c) => {
          await executed(c);
          await c.repository.beginVerification(c.id, SCHEDULE);
          await c.repository.recordVerification(c.id, 1, [
            { targetId: 'a', confirmed: true },
            { targetId: 'b', confirmed: true },
            { targetId: 'c', confirmed: true },
          ]);
          const counts = { pending: 0, confirmed: 3, unconfirmed: 0 };
          expect(await c.repository.finishVerification(c.id, 'verify_timeout', finishAudit(c))).toEqual(counts);
          expect(await c.repository.finishVerification(c.id, 'verify_timeout', finishAudit(c))).toEqual(counts);
          expect(await verificationEvents(c)).toHaveLength(1);
        }));

      it('EXE-12 finishVerification is atomic with its audit row', async () =>
        withRepo(async (c) => {
          await executed(c);
          await c.repository.beginVerification(c.id, SCHEDULE);
          c.failNextAudit();
          await expect(c.repository.finishVerification(c.id, 'verify_timeout', finishAudit(c))).rejects.toThrow();
          expect((await c.repository.stats(c.id)).verification).toEqual({ pending: 3, confirmed: 0, unconfirmed: 0 });
          expect((await byTarget(c)).a?.verificationStatus).toBe('pending');
          expect(await verificationEvents(c)).toHaveLength(0);
          expect(await c.repository.finishVerification(c.id, 'verify_timeout', finishAudit(c))).toEqual({
            pending: 0,
            confirmed: 0,
            unconfirmed: 3,
          });
          expect(await verificationEvents(c)).toHaveLength(1);
        }));

      it('EXE-12 beginVerification answers undefined unless the change-set is executing; bad IDs are not errors', async () =>
        withRepo(async (c) => {
          await executed(c);
          await c.repository.transition(c.id, ['executing'], 'completed', auditEvent(c.id));
          expect(await c.repository.beginVerification(c.id, SCHEDULE)).toBeUndefined();
          expect((await c.repository.get(c.id))?.verificationUntil).toBeUndefined();
          expect('verification' in (await c.repository.stats(c.id))).toBe(false);
          for (const bad of ['x', "'; select 1; --", randomUUID()]) {
            expect(await c.repository.beginVerification(bad, SCHEDULE)).toBeUndefined();
            expect(await c.repository.verificationItems(bad, 1, 10)).toEqual([]);
            expect(await c.repository.recordVerification(bad, 1, [{ targetId: 'a', confirmed: true }])).toEqual({
              left: 0,
              pending: 0,
            });
            expect(await c.repository.finishVerification(bad, 'verify_timeout', finishAudit(c))).toEqual({
              pending: 0,
              confirmed: 0,
              unconfirmed: 0,
            });
          }
          // Never begun: finishing appends nothing.
          expect(await c.repository.finishVerification(c.id, 'verify_timeout', finishAudit(c))).toEqual({
            pending: 0,
            confirmed: 0,
            unconfirmed: 0,
          });
          expect(await verificationEvents(c)).toHaveLength(0);
        }));

      it('EXE-12 verificationItems rejects limits outside 1..500', async () =>
        withRepo(async (c) => {
          await executed(c);
          for (const limit of [0, 501, 1.5]) {
            await expect(c.repository.verificationItems(c.id, 1, limit)).rejects.toThrow();
          }
        }));
    });
  });
}
