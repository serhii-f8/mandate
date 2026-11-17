import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { changesetBatchEvent, EMPTY_STATS, startEventFactory } from '@aiops/core';
import type {
  AuditEventInput,
  BatchSubmission,
  ChangeItemRecord,
  ChangeSetRepository,
  ChangeSetStats,
  ExecutionLimits,
  ItemOutcome,
  NewChangeSet,
} from '@aiops/core';

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
        { status: 'prepared', hash: 'h', stats: stats(), preparedAt: NOW },
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
          { status: 'prepared', hash: 'h1', stats: st, preparedAt },
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
          { status: 'prepared', hash: 'h2', stats: st, preparedAt },
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

    it('parallel completePreparation: exactly one wins and exactly one audit event is written', async () =>
      withRepo(async (c) => {
        await created(c);
        const before = (await c.events()).length;
        const results = await Promise.all(
          ['h1', 'h2'].map((hash) =>
            c.repository.completePreparation(
              c.id,
              { status: 'prepared', hash, stats: stats(), preparedAt: NOW },
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
            { status: 'prepared', hash: 'h', stats: stats(), preparedAt: NOW },
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
        { status: 'prepared', hash: 'h', stats: await c.repository.stats(c.id), preparedAt: NOW },
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
          { status: 'prepared', hash: 'h', stats: await c.repository.stats(c.id), preparedAt: NOW },
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
        { status: 'prepared', hash: 'h', stats: await c.repository.stats(id), preparedAt: NOW },
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
  });
}
