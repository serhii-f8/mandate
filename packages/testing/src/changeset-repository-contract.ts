import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { EMPTY_STATS } from '@aiops/core';
import type {
  AuditEventInput,
  ChangeItemRecord,
  ChangeSetRepository,
  ChangeSetStats,
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

    it('recordItemOutcomes updates only pending items and recomputes written/failed/skipped', async () =>
      withRepo(async (c) => {
        await created(c);
        await c.repository.appendItems(c.id, [
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
  });
}
