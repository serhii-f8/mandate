// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Mandate Authors
import { describe, expect, it } from 'vitest';
import type { AuditEventInput } from '../audit.js';
import type { Caller } from '../caller.js';
import { compareTargetIds } from './canonical.js';
import { deriveChangeSet, isValidTargetId, MAX_DERIVE_TARGETS, type DeriveRepository, type DeriveRequest } from './derive.js';
import { countExclusions, type ChangeItemRecord, type ChangeSetRecord, type ChangeSetStats, type ChangeSetStatus } from './model.js';
import { ChangeSetHasher } from './hash.js';
import type { ItemsPageQuery, NewChangeSet, PreparationCompletion } from './ports.js';
import { hashStoredItems } from './verify.js';

const isRequesterExclusion = (it: ChangeItemRecord) => it.status === 'excluded' && it.reason === 'requester';

/** The copy rules of the repository contract (Task 2, ruling F1): exclude only pending, include only requester exclusions, exclude wins. */
function derivedItem(it: ChangeItemRecord, ex: ReadonlySet<string>, inc: ReadonlySet<string>): ChangeItemRecord {
  const base = { targetId: it.targetId, before: structuredClone(it.before), after: structuredClone(it.after) };
  if (ex.has(it.targetId) && it.status === 'pending') return { ...base, status: 'excluded', reason: 'requester' };
  if (inc.has(it.targetId) && !ex.has(it.targetId) && isRequesterExclusion(it)) return { ...base, status: 'pending' };
  return { ...base, status: it.status, ...(it.reason === undefined ? {} : { reason: it.reason }) };
}

/** Map-based repository with compare-and-set by status and the contract's derivation rules. */
class FakeDeriveRepository implements DeriveRepository {
  readonly sets = new Map<string, ChangeSetRecord>();
  readonly items = new Map<string, Map<string, ChangeItemRecord>>();
  readonly audit: AuditEventInput[] = [];
  /** When set, completePreparation behaves as if the new row expired with its source. */
  expireOnComplete = false;

  create(cs: NewChangeSet, audit: AuditEventInput): Promise<ChangeSetRecord> {
    const record: ChangeSetRecord = {
      ...cs,
      status: 'preparing',
      approvalRound: 0,
      stats: { total: 0, included: 0, excluded: {}, written: 0, failed: 0, skipped: 0 },
    };
    this.sets.set(cs.id, record);
    this.items.set(cs.id, new Map());
    this.audit.push(audit);
    return Promise.resolve(record);
  }
  get(id: string): Promise<ChangeSetRecord | undefined> {
    return Promise.resolve(this.sets.get(id));
  }
  stats(id: string): Promise<ChangeSetStats> {
    const reasons: [string, number][] = [];
    let included = 0;
    let total = 0;
    for (const it of this.items.get(id)?.values() ?? []) {
      total++;
      if (it.status === 'excluded') {
        if (it.reason !== undefined) reasons.push([it.reason, 1]);
      } else included++;
    }
    return Promise.resolve({ total, included, excluded: countExclusions(reasons), written: 0, failed: 0, skipped: 0 });
  }
  itemsPage(id: string, query: ItemsPageQuery): Promise<readonly ChangeItemRecord[]> {
    const all = [...(this.items.get(id)?.values() ?? [])].sort((a, b) => compareTargetIds(a.targetId, b.targetId));
    const after = query.after;
    const rest = after === undefined ? all : all.filter((i) => compareTargetIds(i.targetId, after) > 0);
    return Promise.resolve(rest.slice(0, query.limit));
  }
  transition(
    id: string,
    from: readonly ChangeSetStatus[],
    to: ChangeSetStatus,
    audit: AuditEventInput,
    extra?: { expiredBefore?: Date },
  ): Promise<ChangeSetRecord | undefined> {
    const cs = this.sets.get(id);
    if (cs === undefined || !from.includes(cs.status)) return Promise.resolve(undefined);
    if (extra?.expiredBefore !== undefined && cs.expiresAt.getTime() > extra.expiredBefore.getTime()) {
      return Promise.resolve(undefined);
    }
    const next = { ...cs, status: to };
    this.sets.set(id, next);
    this.audit.push(audit);
    return Promise.resolve(next);
  }
  deriveCheck(sourceId: string, exclude: readonly string[], include: readonly string[]): Promise<{ unknown: number; includedAfter: number }> {
    const ex = new Set(exclude);
    const inc = new Set(include);
    const items = this.items.get(sourceId) ?? new Map<string, ChangeItemRecord>();
    let unknown = 0;
    for (const t of new Set([...ex, ...inc])) {
      const it = items.get(t);
      const qualifies = ex.has(t) ? !inc.has(t) && it?.status === 'pending' : it !== undefined && isRequesterExclusion(it);
      if (!qualifies) unknown++;
    }
    let includedAfter = 0;
    for (const it of items.values()) if (derivedItem(it, ex, inc).status !== 'excluded') includedAfter++;
    return Promise.resolve({ unknown, includedAfter });
  }
  copyItems(newId: string, sourceId: string, exclude: readonly string[], include: readonly string[]): Promise<number> {
    const target = this.items.get(newId);
    if (this.sets.get(newId)?.status !== 'preparing' || target === undefined) return Promise.reject(new Error('change-set is not preparing'));
    if (target.size > 0) return Promise.reject(new Error('change-set already has items'));
    const ex = new Set(exclude);
    const inc = new Set(include);
    const source = this.items.get(sourceId) ?? new Map<string, ChangeItemRecord>();
    for (const it of source.values()) target.set(it.targetId, derivedItem(it, ex, inc));
    return Promise.resolve(source.size);
  }
  completePreparation(
    id: string,
    outcome: PreparationCompletion,
    audit: AuditEventInput,
  ): Promise<ChangeSetRecord | undefined> {
    const cs = this.sets.get(id);
    if (this.expireOnComplete && cs !== undefined) this.sets.set(id, { ...cs, status: 'expired' });
    if (this.expireOnComplete || cs?.status !== 'preparing') return Promise.resolve(undefined);
    const next: ChangeSetRecord =
      outcome.status === 'prepared'
        ? {
            ...cs,
            status: 'prepared',
            hash: outcome.hash,
            hashVersion: outcome.hashVersion,
            ...(outcome.action === undefined ? {} : { action: outcome.action }),
            stats: outcome.stats,
            preparedAt: outcome.preparedAt,
          }
        : { ...cs, status: 'failed', errorCode: outcome.errorCode };
    this.sets.set(id, next);
    this.audit.push(audit);
    return Promise.resolve(next);
  }
}

const SOURCE_ID = '00000000-0000-4000-8000-000000000001';
const CREATED = new Date('2026-11-18T10:00:00.000Z');
const EXPIRES = new Date('2026-11-21T10:00:00.000Z');
const NOW = new Date('2026-11-18T12:00:00.000Z');
const alice: Caller = { subject: 'alice', clientId: 'widget-client', groups: ['editors'] };
const bob: Caller = { subject: 'bob', groups: ['editors'] };

function item(targetId: string, over: Partial<ChangeItemRecord> = {}): ChangeItemRecord {
  return { targetId, status: 'pending', before: { name: `old ${targetId}` }, after: { name: `new ${targetId}` }, ...over };
}

/** The source: t-0001..t-0003 pending, t-0004 excluded not_found, prepared with its real hash. */
async function setup(status: ChangeSetStatus = 'prepared', seal: Pick<ChangeSetRecord, 'hashVersion' | 'action'> = {}) {
  const repo = new FakeDeriveRepository();
  const base: ChangeSetRecord = {
    ...seal,
    id: SOURCE_ID,
    operation: 'catalog.update_content',
    connection: 'magento',
    requester: 'alice',
    clientId: 'chat-client',
    args: { skus: ['t-0001', 't-0002', 't-0003', 't-0004'], changes: { name: 'x' } },
    status,
    stats: { total: 4, included: 3, excluded: { not_found: 1 }, written: 0, failed: 0, skipped: 0 },
    configHash: 'cfg-1',
    correlationId: 'corr-source',
    createdAt: CREATED,
    preparedAt: CREATED,
    expiresAt: EXPIRES,
    approvalRound: 0,
  };
  repo.sets.set(SOURCE_ID, base);
  repo.items.set(
    SOURCE_ID,
    new Map(
      [item('t-0001'), item('t-0002'), item('t-0003'), item('t-0004', { status: 'excluded', reason: 'not_found' })].map((i) => [i.targetId, i]),
    ),
  );
  const hash = await hashStoredItems(repo, base);
  const source: ChangeSetRecord = { ...base, hash };
  repo.sets.set(SOURCE_ID, source);
  let n = 0;
  const deps = {
    repository: repo,
    newId: () => `00000000-0000-4000-8000-${String(100 + n++).padStart(12, '0')}`,
    now: () => NOW,
  };
  const req = (over: Partial<DeriveRequest> = {}): DeriveRequest => ({
    sourceId: SOURCE_ID,
    hash,
    exclude: [],
    include: [],
    caller: alice,
    correlationId: 'corr-derive',
    excludable: () => true,
    ...over,
  });
  return { repo, deps, req, source };
}

describe('CS-5 derived change-sets', () => {
  it('CS-5 refusals come in the fixed order', async () => {
    const s = await setup();
    const derive = (over: Partial<DeriveRequest>) => deriveChangeSet(s.deps, s.req(over));
    expect(await derive({ caller: bob, exclude: ['t-0001'] })).toEqual({ ok: false, reason: 'not_found' });
    expect(await derive({ sourceId: '00000000-0000-4000-8000-0000000000ff', exclude: ['t-0001'] })).toEqual({ ok: false, reason: 'not_found' });

    const late = await setup();
    const lateDeps = { ...late.deps, now: () => new Date(EXPIRES.getTime() + 1) };
    expect(await deriveChangeSet(lateDeps, late.req({ exclude: ['t-0001'] }))).toEqual({ ok: false, reason: 'expired' });
    expect(late.repo.sets.get(SOURCE_ID)?.status).toBe('expired');

    const pending = await setup('pending_approval');
    expect(await deriveChangeSet(pending.deps, pending.req({ exclude: ['t-0001'] }))).toEqual({
      ok: false,
      reason: 'not_prepared',
      status: 'pending_approval',
    });

    expect(await derive({ hash: `sha256:${'0'.repeat(64)}`, exclude: ['t-0001'] })).toEqual({ ok: false, reason: 'hash_mismatch' });

    const many = Array.from({ length: MAX_DERIVE_TARGETS + 1 }, (_, i) => `t-${String(i).padStart(4, '0')}`);
    expect(await derive({ exclude: many.slice(0, 600), include: many.slice(600) })).toEqual({ ok: false, reason: 'invalid_request' });
    for (const bad of ['', 'x'.repeat(513), 'a\u0007', 'a\uD800']) {
      expect(await derive({ exclude: ['t-0001', bad] })).toEqual({ ok: false, reason: 'invalid_request' });
      expect(await derive({ include: [bad] })).toEqual({ ok: false, reason: 'invalid_request' });
    }

    expect(await derive({})).toEqual({ ok: false, reason: 'empty_request' });
    expect(await derive({ exclude: ['t-0004', 'nope'] })).toEqual({ ok: false, reason: 'unknown_items', count: 2 });
    expect(await derive({ exclude: ['t-0001', 't-0002', 't-0003'] })).toEqual({ ok: false, reason: 'nothing_left' });

    // Order: a bad hash wins over an empty request.
    expect(await derive({ hash: `sha256:${'0'.repeat(64)}` })).toEqual({ ok: false, reason: 'hash_mismatch' });
    // No refusal created a row or touched the source.
    expect([...s.repo.sets.keys()]).toEqual([SOURCE_ID]);
    expect(s.repo.sets.get(SOURCE_ID)).toEqual(s.source);
  });

  it('CS-5 isValidTargetId accepts 1..512 well-formed units without control characters', () => {
    expect(isValidTargetId('x')).toBe(true);
    expect(isValidTargetId('x'.repeat(512))).toBe(true);
    expect(isValidTargetId('😀 SKU-1')).toBe(true);
    for (const bad of ['', 'x'.repeat(513), 'a\u0007', 'a\u007f', 'a\n', 'a\uD800', '\uDC00b']) expect(isValidTargetId(bad)).toBe(false);
  });

  it('CS-5 an opaque change-set cannot be derived: not_excludable', async () => {
    const s = await setup();
    const asked: string[] = [];
    const excludable = (id: string) => {
      asked.push(id);
      return false;
    };
    expect(await deriveChangeSet(s.deps, s.req({ exclude: ['t-0001'], excludable }))).toEqual({ ok: false, reason: 'not_excludable' });
    expect(asked).toEqual(['catalog.update_content']);
    expect(s.repo.sets.size).toBe(1);
  });

  it('SEC-1 a foreign opaque change-set still reads not_found', async () => {
    const s = await setup();
    expect(await deriveChangeSet(s.deps, s.req({ caller: bob, exclude: ['t-0001'], excludable: () => false }))).toEqual({
      ok: false,
      reason: 'not_found',
    });
  });

  it('CS-5 CS-4 the derived change-set has its own id and hash, the source is unchanged', async () => {
    const s = await setup();
    const sourceItems = await s.repo.itemsPage(SOURCE_ID, { limit: 10 });
    const r = await deriveChangeSet(s.deps, s.req({ exclude: ['t-0002'] }));
    if (!r.ok) throw new Error(`refused: ${r.reason}`);
    expect(r.changeset.status).toBe('prepared');
    expect(r.changeset.id).not.toBe(SOURCE_ID);
    expect(r.changeset.derivedFrom).toBe(SOURCE_ID);
    expect(r.changeset.hash).not.toBe(s.source.hash);
    expect(r.changeset.hash).toBe(await hashStoredItems(s.repo, r.changeset));
    expect(r.changeset.stats.excluded.requester).toBe(1);
    expect(r.changeset.stats).toEqual({ total: 4, included: 2, excluded: { not_found: 1, requester: 1 }, written: 0, failed: 0, skipped: 0 });
    expect(r.excludedByRequester).toBe(1);
    expect(r.source).toEqual(s.source);
    expect(s.repo.sets.get(SOURCE_ID)).toEqual(s.source);
    expect(await s.repo.itemsPage(SOURCE_ID, { limit: 10 })).toEqual(sourceItems);
  });

  it('CS-5 the new row copies the request and the expiry, and takes client and correlation from the call', async () => {
    const s = await setup();
    const r = await deriveChangeSet(s.deps, s.req({ exclude: ['t-0002'] }));
    if (!r.ok) throw new Error(`refused: ${r.reason}`);
    const c = r.changeset;
    expect(c.expiresAt).toEqual(s.source.expiresAt);
    expect(c.args).toEqual(s.source.args);
    expect(c.operation).toBe(s.source.operation);
    expect(c.connection).toBe(s.source.connection);
    expect(c.requester).toBe(s.source.requester);
    expect(c.configHash).toBe(s.source.configHash);
    expect(c.clientId).toBe('widget-client');
    expect(c.correlationId).toBe('corr-derive');
    expect(c.createdAt).toEqual(NOW);
  });

  it('CS-5 re-including from a derived change-set restores the source hash under a new id', async () => {
    const s = await setup();
    const first = await deriveChangeSet(s.deps, s.req({ exclude: ['t-0001'] }));
    if (!first.ok) throw new Error(`refused: ${first.reason}`);
    const back = await deriveChangeSet(s.deps, s.req({ sourceId: first.changeset.id, hash: first.changeset.hash ?? '', include: ['t-0001'] }));
    if (!back.ok) throw new Error(`refused: ${back.reason}`);
    expect(back.changeset.hash).toBe(s.source.hash);
    expect(back.changeset.id).not.toBe(SOURCE_ID);
    expect(back.changeset.id).not.toBe(first.changeset.id);
    expect(back.changeset.derivedFrom).toBe(first.changeset.id);
    expect(back.excludedByRequester).toBe(0);
    expect(s.repo.sets.get(first.changeset.id)?.status).toBe('prepared');
  });

  it('CS-5 CS-3 an exclusion reason other than requester cannot be included back', async () => {
    const s = await setup();
    expect(await deriveChangeSet(s.deps, s.req({ include: ['t-0004'] }))).toEqual({ ok: false, reason: 'unknown_items', count: 1 });
    // A target named in both lists counts once, as unknown.
    expect(await deriveChangeSet(s.deps, s.req({ exclude: ['t-0001', 'nope'], include: ['t-0001', 'nope'] }))).toEqual({
      ok: false,
      reason: 'unknown_items',
      count: 2,
    });
  });

  it('AUD-1 derivation audits null→preparing and preparing→prepared with derivedFrom and counts, never target ids', async () => {
    const s = await setup();
    const r = await deriveChangeSet(s.deps, s.req({ exclude: ['t-0002'] }));
    if (!r.ok) throw new Error(`refused: ${r.reason}`);
    const events = s.repo.audit;
    expect(events).toHaveLength(2);
    const common = { actor: 'alice', clientId: 'widget-client', action: 'changeset.transition', correlationId: 'corr-derive', changesetId: r.changeset.id };
    expect(events[0]).toMatchObject({ ...common, outcome: 'ok' });
    expect(events[0]?.details).toEqual({ from: null, to: 'preparing', operation: 'catalog.update_content', derivedFrom: SOURCE_ID });
    expect(events[1]).toMatchObject({ ...common, outcome: 'ok' });
    expect(events[1]?.details).toEqual({
      from: 'preparing',
      to: 'prepared',
      operation: 'catalog.update_content',
      included: 2,
      excluded: 2,
      derivedFrom: SOURCE_ID,
      excludedByRequester: 1,
    });
    expect(new Set(events.map((e) => e.id)).size).toBe(2);
    expect(JSON.stringify(events)).not.toContain('t-000');
    expect(JSON.stringify(events)).not.toContain(r.changeset.hash ?? 'no-hash');
  });

  it('CS-6 a source due to expire is refused and moved to expired', async () => {
    const s = await setup();
    const atExpiry = { ...s.deps, now: () => EXPIRES };
    expect(await deriveChangeSet(atExpiry, s.req({ exclude: ['t-0002'] }))).toEqual({ ok: false, reason: 'expired' });
    expect(s.repo.sets.get(SOURCE_ID)?.status).toBe('expired');
    expect([...s.repo.sets.keys()]).toEqual([SOURCE_ID]);
    expect(s.repo.audit).toHaveLength(1);
    expect(s.repo.audit[0]).toMatchObject({
      actor: 'system',
      changesetId: SOURCE_ID,
      correlationId: 'corr-derive',
      details: { from: 'prepared', to: 'expired' },
    });
  });

  describe('CS-4 CS-5 hash version of a derived change-set', () => {
    /** The hash of the derived items (t-0002 excluded by the requester) under one seal. */
    async function expected(seal?: { version: 1 | 2; action?: 'update' | 'create' | 'delete' }): Promise<string> {
      const s = await setup();
      const items = await s.repo.itemsPage(SOURCE_ID, { limit: 10 });
      const h = seal === undefined ? new ChangeSetHasher(s.source.operation, s.source.args) : new ChangeSetHasher(s.source.operation, s.source.args, seal);
      for (const i of items) {
        h.add(i.targetId === 't-0002' ? { ...i, status: 'excluded', reason: 'requester' } : i);
      }
      return h.digest();
    }

    it('CS-4 CS-5 a version 1 source yields a version 1 derived change-set with a version 1 hash', async () => {
      const s = await setup();
      const r = await deriveChangeSet(s.deps, s.req({ exclude: ['t-0002'] }));
      if (!r.ok) throw new Error(`refused: ${r.reason}`);
      expect(r.changeset.hashVersion).toBe(1);
      expect(r.changeset.action).toBeUndefined();
      expect(r.changeset.hash).toBe(await expected());
    });

    it('CS-4 CS-5 a version 2 source yields version 2 and the source action', async () => {
      const s = await setup('prepared', { hashVersion: 2, action: 'create' });
      expect(s.source.hash).toBe(await hashStoredItems(s.repo, { ...s.source, hashVersion: 2, action: 'create' }));
      const r = await deriveChangeSet(s.deps, s.req({ exclude: ['t-0002'] }));
      if (!r.ok) throw new Error(`refused: ${r.reason}`);
      expect(r.changeset.hashVersion).toBe(2);
      expect(r.changeset.action).toBe('create');
      expect(r.changeset.hash).toBe(await expected({ version: 2, action: 'create' }));
      expect(r.changeset.hash).toBe(await hashStoredItems(s.repo, r.changeset));
    });

    it('CS-4 CS-5 a source with an unknown hash version is refused hash_mismatch and creates no row', async () => {
      const s = await setup();
      // A row from a newer release: the type does not admit 3, the database column does.
      const newer = { ...s.source, hashVersion: 4 as never };
      s.repo.sets.set(SOURCE_ID, newer);
      expect(await deriveChangeSet(s.deps, s.req({ exclude: ['t-0002'] }))).toEqual({ ok: false, reason: 'hash_mismatch' });
      expect([...s.repo.sets.keys()]).toEqual([SOURCE_ID]);
    });
  });

  it('CS-6 a derived row that expires with its source before it is prepared answers expired', async () => {
    const s = await setup();
    s.repo.expireOnComplete = true;
    expect(await deriveChangeSet(s.deps, s.req({ exclude: ['t-0002'] }))).toEqual({ ok: false, reason: 'expired' });
  });
});
