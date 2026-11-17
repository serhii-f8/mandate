import { describe, expect, it } from 'vitest';
import type {
  AuditEventInput,
  ChangeItemRecord,
  ChangeSetRepository,
  ChangeSetStats,
  NewChangeSet,
} from '@aiops/core';

export interface ChangeSetRepositoryHarness {
  readonly repository: ChangeSetRepository;
  readonly auditEvents: () => Promise<readonly AuditEventInput[]>;
  /** Makes the audit append of the next state-changing call fail. */
  readonly failNextAudit: () => void;
  readonly close?: () => Promise<void>;
}

const NOW = new Date('2026-01-01T00:00:00.000Z');
const LATER = new Date('2026-01-02T00:00:00.000Z');

function newChangeSet(id = 'cs-1', overrides: Partial<NewChangeSet> = {}): NewChangeSet {
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
    ...overrides,
  };
}

let eventSeq = 0;
function auditEvent(changesetId = 'cs-1'): AuditEventInput {
  eventSeq += 1;
  return {
    id: `evt-${eventSeq}`,
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
    async function withRepo(body: (h: ChangeSetRepositoryHarness) => Promise<void>): Promise<void> {
      const h = await setup();
      try {
        await body(h);
      } finally {
        await h.close?.();
      }
    }

    async function prepared(h: ChangeSetRepositoryHarness): Promise<void> {
      await h.repository.create(newChangeSet(), auditEvent());
      await h.repository.completePreparation(
        'cs-1',
        { status: 'prepared', hash: 'h', stats: stats(), preparedAt: NOW },
        auditEvent(),
      );
    }

    it('create returns a preparing record and writes its audit event', async () =>
      withRepo(async ({ repository, auditEvents }) => {
        const ev = auditEvent();
        const rec = await repository.create(newChangeSet(), ev);
        expect(rec.id).toBe('cs-1');
        expect(rec.status).toBe('preparing');
        expect(rec.stats.total).toBe(0);
        expect(rec.createdAt.getTime()).toBe(NOW.getTime());
        expect(rec.expiresAt.getTime()).toBe(LATER.getTime());
        expect(rec.hash).toBeUndefined();
        expect((await auditEvents()).map((e) => e.id)).toEqual([ev.id]);
        expect((await repository.get('cs-1'))?.status).toBe('preparing');
        expect(await repository.get('nope')).toBeUndefined();
      }));

    it('create is atomic with its audit event', async () =>
      withRepo(async ({ repository, auditEvents, failNextAudit }) => {
        failNextAudit();
        await expect(repository.create(newChangeSet(), auditEvent())).rejects.toThrow();
        expect(await repository.get('cs-1')).toBeUndefined();
        expect(await auditEvents()).toHaveLength(0);
      }));

    it('appendItems dedupes by target and returns the inserted count', async () =>
      withRepo(async ({ repository }) => {
        await repository.create(newChangeSet(), auditEvent());
        expect(await repository.appendItems('cs-1', [item('a'), item('b'), item('a')])).toBe(2);
        expect(await repository.appendItems('cs-1', [item('b'), item('c')])).toBe(1);
        const page = await repository.itemsPage('cs-1', { limit: 10 });
        expect(page.map((i) => i.targetId)).toEqual(['a', 'b', 'c']);
        expect(await repository.appendItems('cs-1', [])).toBe(0);
      }));

    it('appendItems rejects unknown change-sets and non pending/excluded item statuses', async () =>
      withRepo(async ({ repository }) => {
        await expect(repository.appendItems('nope', [item('a')])).rejects.toThrow();
        await repository.create(newChangeSet(), auditEvent());
        await expect(repository.appendItems('cs-1', [item('a', { status: 'written' })])).rejects.toThrow();
        expect(await repository.itemsPage('cs-1', { limit: 10 })).toEqual([]);
      }));

    it('itemsPage orders by code point, pages by keyset and filters by status', async () =>
      withRepo(async ({ repository }) => {
        await repository.create(newChangeSet(), auditEvent());
        await repository.appendItems('cs-1', [
          item('b'),
          item('B', { status: 'excluded', reason: 'no_change' }),
          item('a'),
          item('é'),
          item('Z'),
        ]);
        const all = await repository.itemsPage('cs-1', { limit: 500 });
        expect(all.map((i) => i.targetId)).toEqual(['B', 'Z', 'a', 'b', 'é']);
        const first = await repository.itemsPage('cs-1', { limit: 2 });
        expect(first.map((i) => i.targetId)).toEqual(['B', 'Z']);
        const second = await repository.itemsPage('cs-1', { limit: 2, after: 'Z' });
        expect(second.map((i) => i.targetId)).toEqual(['a', 'b']);
        const excluded = await repository.itemsPage('cs-1', { limit: 10, status: 'excluded' });
        expect(excluded.map((i) => i.targetId)).toEqual(['B']);
        expect(excluded[0]?.reason).toBe('no_change');
        expect(await repository.itemsPage('missing', { limit: 10 })).toEqual([]);
      }));

    it('itemsPage rejects limits outside 1..500', async () =>
      withRepo(async ({ repository }) => {
        await repository.create(newChangeSet(), auditEvent());
        await expect(repository.itemsPage('cs-1', { limit: 501 })).rejects.toThrow();
        await expect(repository.itemsPage('cs-1', { limit: 0 })).rejects.toThrow();
      }));

    it('stats counts items by status and exclusion reason', async () =>
      withRepo(async ({ repository }) => {
        await repository.create(newChangeSet(), auditEvent());
        await repository.appendItems('cs-1', [
          item('a'),
          item('b'),
          item('c', { status: 'excluded', reason: 'not_found' }),
          item('d', { status: 'excluded', reason: 'not_found' }),
          item('e', { status: 'excluded', reason: 'no_change' }),
        ]);
        expect(await repository.stats('cs-1')).toEqual({
          total: 5,
          included: 2,
          excluded: { not_found: 2, no_change: 1 },
          written: 0,
          failed: 0,
          skipped: 0,
        });
      }));

    it('completePreparation prepared stores hash, stats and preparedAt; a second call returns undefined', async () =>
      withRepo(async ({ repository, auditEvents }) => {
        await repository.create(newChangeSet(), auditEvent());
        const st = stats({ total: 2, included: 2 });
        const preparedAt = new Date('2026-01-01T00:00:05.000Z');
        const rec = await repository.completePreparation(
          'cs-1',
          { status: 'prepared', hash: 'h1', stats: st, preparedAt },
          auditEvent(),
        );
        expect(rec?.status).toBe('prepared');
        expect(rec?.hash).toBe('h1');
        expect(rec?.stats).toEqual(st);
        expect(rec?.preparedAt?.getTime()).toBe(preparedAt.getTime());
        expect((await repository.get('cs-1'))?.hash).toBe('h1');
        const before = (await auditEvents()).length;
        const again = await repository.completePreparation(
          'cs-1',
          { status: 'prepared', hash: 'h2', stats: st, preparedAt },
          auditEvent(),
        );
        expect(again).toBeUndefined();
        expect((await repository.get('cs-1'))?.hash).toBe('h1');
        expect(await auditEvents()).toHaveLength(before);
        expect(await repository.completePreparation('nope', { status: 'failed', errorCode: 'x' }, auditEvent())).toBeUndefined();
      }));

    it('completePreparation failed stores the error code', async () =>
      withRepo(async ({ repository }) => {
        await repository.create(newChangeSet(), auditEvent());
        const rec = await repository.completePreparation(
          'cs-1',
          { status: 'failed', errorCode: 'targets_missing' },
          auditEvent(),
        );
        expect(rec?.status).toBe('failed');
        expect(rec?.errorCode).toBe('targets_missing');
        expect(rec?.hash).toBeUndefined();
      }));

    it('appendItems rejects once the change-set has left preparing', async () =>
      withRepo(async (h) => {
        await prepared(h);
        await expect(h.repository.appendItems('cs-1', [item('a')])).rejects.toThrow();
        expect(await h.repository.itemsPage('cs-1', { limit: 10 })).toEqual([]);
      }));

    it('completePreparation is atomic with its audit event', async () =>
      withRepo(async ({ repository, auditEvents, failNextAudit }) => {
        await repository.create(newChangeSet(), auditEvent());
        const before = (await auditEvents()).length;
        failNextAudit();
        await expect(
          repository.completePreparation(
            'cs-1',
            { status: 'prepared', hash: 'h', stats: stats(), preparedAt: NOW },
            auditEvent(),
          ),
        ).rejects.toThrow();
        const rec = await repository.get('cs-1');
        expect(rec?.status).toBe('preparing');
        expect(rec?.hash).toBeUndefined();
        expect(await auditEvents()).toHaveLength(before);
      }));

    it('transition is compare-and-set and writes its audit event only on success', async () =>
      withRepo(async (h) => {
        await prepared(h);
        const { repository, auditEvents } = h;
        const before = (await auditEvents()).length;
        const wrong = await repository.transition('cs-1', ['approved'], 'executing', auditEvent());
        expect(wrong).toBeUndefined();
        expect((await repository.get('cs-1'))?.status).toBe('prepared');
        expect(await auditEvents()).toHaveLength(before);
        const ok = await repository.transition('cs-1', ['approved', 'prepared'], 'pending_approval', auditEvent());
        expect(ok?.status).toBe('pending_approval');
        expect(await auditEvents()).toHaveLength(before + 1);
        expect(await repository.transition('nope', ['prepared'], 'pending_approval', auditEvent())).toBeUndefined();
      }));

    it('transition stores errorCode when given', async () =>
      withRepo(async (h) => {
        await prepared(h);
        const rec = await h.repository.transition('cs-1', ['prepared'], 'failed', auditEvent(), { errorCode: 'boom' });
        expect(rec?.status).toBe('failed');
        expect(rec?.errorCode).toBe('boom');
      }));

    it('transition with expiredBefore applies only when expiresAt <= expiredBefore', async () =>
      withRepo(async (h) => {
        await prepared(h);
        const early = new Date(LATER.getTime() - 1);
        expect(
          await h.repository.transition('cs-1', ['prepared'], 'expired', auditEvent(), { expiredBefore: early }),
        ).toBeUndefined();
        expect((await h.repository.get('cs-1'))?.status).toBe('prepared');
        const exact = await h.repository.transition('cs-1', ['prepared'], 'expired', auditEvent(), {
          expiredBefore: LATER,
        });
        expect(exact?.status).toBe('expired');
      }));

    it('transition is atomic with its audit event', async () =>
      withRepo(async (h) => {
        await prepared(h);
        const before = (await h.auditEvents()).length;
        h.failNextAudit();
        await expect(h.repository.transition('cs-1', ['prepared'], 'cancelled', auditEvent())).rejects.toThrow();
        expect((await h.repository.get('cs-1'))?.status).toBe('prepared');
        expect(await h.auditEvents()).toHaveLength(before);
      }));

    it('recordItemOutcomes updates only pending items and recomputes written/failed/skipped', async () =>
      withRepo(async ({ repository }) => {
        await repository.create(newChangeSet(), auditEvent());
        await repository.appendItems('cs-1', [
          item('a'),
          item('b'),
          item('c'),
          item('d', { status: 'excluded', reason: 'no_change' }),
        ]);
        await repository.recordItemOutcomes('cs-1', [
          { targetId: 'a', status: 'written' },
          { targetId: 'b', status: 'failed', error: 'upstream_5xx' },
          { targetId: 'd', status: 'written' },
          { targetId: 'unknown', status: 'written' },
        ]);
        const items = await repository.itemsPage('cs-1', { limit: 10 });
        const byId = new Map(items.map((i) => [i.targetId, i]));
        expect(byId.get('a')?.status).toBe('written');
        expect(byId.get('b')?.status).toBe('failed');
        expect(byId.get('b')?.error).toBe('upstream_5xx');
        expect(byId.get('c')?.status).toBe('pending');
        expect(byId.get('d')?.status).toBe('excluded');
        // A second outcome for an already settled item changes nothing.
        await repository.recordItemOutcomes('cs-1', [{ targetId: 'a', status: 'skipped' }]);
        expect((await repository.itemsPage('cs-1', { limit: 10, status: 'written' })).map((i) => i.targetId)).toEqual([
          'a',
        ]);
        expect(await repository.stats('cs-1')).toEqual({
          total: 4,
          included: 3,
          excluded: { no_change: 1 },
          written: 1,
          failed: 1,
          skipped: 0,
        });
        expect((await repository.get('cs-1'))?.stats).toMatchObject({ written: 1, failed: 1, skipped: 0 });
      }));
  });
}
