import { describe, expect, it } from 'vitest';
import type { AuditEventInput } from '../audit.js';
import type { Caller } from '../caller.js';
import type { ManifestDefinition, OperationDefinition } from '../policy-model.js';
import { compareTargetIds, normalizeArgs } from './canonical.js';
import { ChangeSetHasher } from './hash.js';
import type { ChangeItemRecord, ChangeSetRecord, ChangeSetStats, ExclusionReason } from './model.js';
import type { ChangeSetRepository, ItemsPageQuery, NewChangeSet, ReadPage, UpstreamReader } from './ports.js';
import { prepareChangeSet, type PrepareDeps, type PrepareRequest } from './prepare.js';

/** Minimal Map-based repository with the contract's compare-and-set semantics. */
class FakeRepository implements ChangeSetRepository {
  readonly sets = new Map<string, ChangeSetRecord>();
  readonly items = new Map<string, Map<string, ChangeItemRecord>>();
  readonly audit: AuditEventInput[] = [];
  largestAppend = 0;
  largestPageLimit = 0;

  create(cs: NewChangeSet, audit: AuditEventInput): Promise<ChangeSetRecord> {
    const record: ChangeSetRecord = {
      ...cs,
      status: 'preparing',
      stats: { total: 0, included: 0, excluded: {}, written: 0, failed: 0, skipped: 0 },
    };
    this.sets.set(cs.id, record);
    this.items.set(cs.id, new Map());
    this.audit.push(audit);
    return Promise.resolve(record);
  }
  appendItems(id: string, items: readonly ChangeItemRecord[]): Promise<number> {
    if (this.sets.get(id)?.status !== 'preparing') return Promise.reject(new Error('not preparing'));
    this.largestAppend = Math.max(this.largestAppend, items.length);
    const store = this.items.get(id) ?? new Map<string, ChangeItemRecord>();
    let n = 0;
    for (const item of items) {
      if (!store.has(item.targetId)) {
        store.set(item.targetId, { ...item });
        n++;
      }
    }
    return Promise.resolve(n);
  }
  stats(id: string): Promise<ChangeSetStats> {
    const excluded: Partial<Record<ExclusionReason, number>> = {};
    let included = 0;
    let total = 0;
    for (const item of this.items.get(id)?.values() ?? []) {
      total++;
      if (item.status === 'excluded' && item.reason !== undefined) excluded[item.reason] = (excluded[item.reason] ?? 0) + 1;
      else included++;
    }
    return Promise.resolve({ total, included, excluded, written: 0, failed: 0, skipped: 0 });
  }
  get(id: string): Promise<ChangeSetRecord | undefined> {
    return Promise.resolve(this.sets.get(id));
  }
  itemsPage(id: string, query: ItemsPageQuery): Promise<readonly ChangeItemRecord[]> {
    if (query.limit < 1 || query.limit > 500) return Promise.reject(new Error('limit'));
    this.largestPageLimit = Math.max(this.largestPageLimit, query.limit);
    const all = [...(this.items.get(id)?.values() ?? [])].sort((a, b) => compareTargetIds(a.targetId, b.targetId));
    const after = query.after;
    const rest = after === undefined ? all : all.filter((i) => compareTargetIds(i.targetId, after) > 0);
    return Promise.resolve(rest.slice(0, query.limit));
  }
  completePreparation(
    id: string,
    outcome:
      | { status: 'prepared'; hash: string; stats: ChangeSetStats; preparedAt: Date }
      | { status: 'failed'; errorCode: string },
    audit: AuditEventInput,
  ): Promise<ChangeSetRecord | undefined> {
    const cs = this.sets.get(id);
    if (cs?.status !== 'preparing') return Promise.resolve(undefined);
    const next: ChangeSetRecord =
      outcome.status === 'prepared'
        ? { ...cs, status: 'prepared', hash: outcome.hash, stats: outcome.stats, preparedAt: outcome.preparedAt }
        : { ...cs, status: 'failed', errorCode: outcome.errorCode };
    this.sets.set(id, next);
    this.audit.push(audit);
    return Promise.resolve(next);
  }
  transition(
    id: string,
    from: readonly ChangeSetRecord['status'][],
    to: ChangeSetRecord['status'],
    audit: AuditEventInput,
  ): Promise<ChangeSetRecord | undefined> {
    const cs = this.sets.get(id);
    if (cs === undefined || !from.includes(cs.status)) return Promise.resolve(undefined);
    const next = { ...cs, status: to };
    this.sets.set(id, next);
    this.audit.push(audit);
    return Promise.resolve(next);
  }
  recordItemOutcomes(): Promise<void> {
    return Promise.resolve();
  }
}

interface Call {
  op: string;
  args: Readonly<Record<string, unknown>>;
}

/** Reader that answers by-id reads from a product table and selector reads from a script. */
class ScriptedReader implements UpstreamReader {
  readonly calls: Call[] = [];
  constructor(
    private readonly products: Record<string, Record<string, unknown>>,
    private readonly opts: {
      selector?: (page: number) => ReadPage;
      readOverride?: () => ReadPage;
      beforeAnswer?: () => Promise<void>;
    } = {},
  ) {}
  async read(op: string, args: Readonly<Record<string, unknown>>): Promise<ReadPage> {
    this.calls.push({ op, args });
    if (this.opts.beforeAnswer !== undefined) await this.opts.beforeAnswer();
    if (op === 'catalog.search_products') {
      if (this.opts.selector === undefined) throw new Error('no selector script');
      return this.opts.selector(Number(args.current_page));
    }
    if (this.opts.readOverride !== undefined) return this.opts.readOverride();
    const skus = args.skus as string[];
    return { ok: true, items: skus.flatMap((s) => (this.products[s] ? [this.products[s]] : [])), truncated: false };
  }
  readsOf(op: string): Call[] {
    return this.calls.filter((c) => c.op === op);
  }
}

const baseManifest: ManifestDefinition = {
  idField: 'sku',
  idsArg: 'skus',
  valuesArg: 'changes',
  fields: ['name', 'description'],
  requiredFields: [],
  scopeArgs: { brand: 'brand' },
  readBefore: { operation: 'catalog.get_products_by_sku', idsArg: 'skus', args: { brand: { arg: 'brand' } } },
  selector: {
    operation: 'catalog.search_products',
    args: { brand: { arg: 'brand' } },
    pageArg: 'current_page',
    pageSizeArg: 'page_size',
    pageSize: 2,
  },
  batchSize: 1,
  maxTargets: 10_000,
  rollback: { strategy: 'replay_previous_state' },
};

function operation(manifest: Partial<ManifestDefinition> = {}): OperationDefinition & { manifest: ManifestDefinition } {
  return {
    id: 'catalog.update_content',
    toolName: 'catalog_update_content',
    source: 'config',
    connection: 'magento',
    risk: 'write',
    description: 'Update content',
    inputSchema: { type: 'object' },
    fieldsArg: 'changes',
    manifest: { ...baseManifest, ...manifest },
  };
}

const caller: Caller = { subject: 'alice', clientId: 'client-1', groups: [] };

function product(sku: string, description = 'old'): Record<string, unknown> {
  return { sku, brand: 'acme', description };
}

function setup(reader: ScriptedReader, repository = new FakeRepository()) {
  let n = 0;
  const deps: PrepareDeps = {
    repository,
    reader,
    newId: () => `id-${String(++n)}`,
    now: () => new Date('2026-11-17T10:00:00.000Z'),
  };
  return { deps, repository };
}

function request(
  args: Record<string, unknown>,
  manifest: Partial<ManifestDefinition> = {},
): PrepareRequest {
  return {
    operation: operation(manifest),
    args,
    caller,
    correlationId: 'corr-1',
    configHash: 'cfg-1',
    expireAfterHours: 72,
    readFieldsArg: (op) => (op === 'catalog.get_products_by_sku' || op === 'catalog.search_products' ? 'fields' : undefined),
  };
}

const explicitArgs = { brand: 'acme', skus: ['B', 'A', 'A'], changes: { description: 'new' } };

describe('CS-1 CS-2 CS-4 preparation', () => {
  it('CS-1 CS-2 CS-4 explicit ids are read in sorted chunks and the change-set is prepared with a stable hash', async () => {
    const reader = new ScriptedReader({ A: product('A'), B: product('B') });
    const { deps, repository } = setup(reader);
    const out = await prepareChangeSet(deps, request(explicitArgs));
    expect(out.ok).toBe(true);
    if (!out.ok) return;

    const reads = reader.readsOf('catalog.get_products_by_sku');
    expect(reads.map((c) => c.args.skus)).toEqual([['A'], ['B']]);
    expect(reads[0]?.args).toEqual({ brand: 'acme', skus: ['A'], fields: ['sku', 'brand', 'description'] });

    expect(out.changeset.status).toBe('prepared');
    expect(out.changeset.stats).toMatchObject({ total: 2, included: 2 });
    expect(out.changeset.expiresAt.toISOString()).toBe('2026-11-20T10:00:00.000Z');
    expect(out.changeset.args).toEqual({ ...explicitArgs, skus: ['A', 'B'] });
    expect(out.changeset.requester).toBe('alice');
    expect(out.changeset.clientId).toBe('client-1');

    const hasher = new ChangeSetHasher('catalog.update_content', normalizeArgs(explicitArgs, 'skus'));
    for (const t of ['A', 'B']) {
      hasher.add({ targetId: t, status: 'pending', before: { description: 'old' }, after: { description: 'new' } });
    }
    expect(out.changeset.hash).toBe(hasher.digest());
    expect(out.firstItems.map((i) => i.targetId)).toEqual(['A', 'B']);

    const transitions = repository.audit.map((a) => [a.details.from, a.details.to]);
    expect(transitions).toEqual([
      [null, 'preparing'],
      ['preparing', 'prepared'],
    ]);
    expect(repository.audit[1]?.details).toMatchObject({ included: 2, excluded: 0 });
    expect(repository.audit.every((a) => a.actor === 'alice' && a.clientId === 'client-1')).toBe(true);
  });

  it('CS-4 same input against unchanged upstream gives equal hashes and different ids', async () => {
    const reader = new ScriptedReader({ A: product('A'), B: product('B') });
    const { deps } = setup(reader);
    const a = await prepareChangeSet(deps, request(explicitArgs));
    const b = await prepareChangeSet(deps, request(explicitArgs));
    if (!a.ok || !b.ok) throw new Error('expected prepared');
    expect(a.changeset.hash).toBe(b.changeset.hash);
    expect(a.changeset.id).not.toBe(b.changeset.id);
  });

  it('CS-1 omits the fields argument when the read operation has none', async () => {
    const reader = new ScriptedReader({ A: product('A') });
    const { deps } = setup(reader);
    const out = await prepareChangeSet(deps, { ...request({ ...explicitArgs, skus: ['A'] }), readFieldsArg: () => undefined });
    expect(out.ok).toBe(true);
    expect(reader.calls[0]?.args).toEqual({ brand: 'acme', skus: ['A'] });
  });

  it('CS-3 required fields the call does not touch are requested from the read', async () => {
    const reader = new ScriptedReader({ A: { ...product('A'), name: 'Name A' } });
    const { deps } = setup(reader);
    const out = await prepareChangeSet(deps, request({ ...explicitArgs, skus: ['A'] }, { requiredFields: ['name'] }));
    if (!out.ok) throw new Error(`expected prepared, got ${out.code}`);
    expect(reader.calls[0]?.args.fields).toEqual(['sku', 'brand', 'description', 'name']);
    expect(out.firstItems.map((i) => i.status)).toEqual(['pending']);
  });

  it('CS-2 firstItems holds at most 20 items in item order', async () => {
    const skus = Array.from({ length: 30 }, (_, i) => `S${String(i).padStart(2, '0')}`);
    const reader = new ScriptedReader(Object.fromEntries(skus.map((s) => [s, product(s)])));
    const { deps } = setup(reader);
    const out = await prepareChangeSet(deps, request({ ...explicitArgs, skus: [...skus].reverse() }, { batchSize: 7 }));
    if (!out.ok) throw new Error('expected prepared');
    expect(out.firstItems.map((i) => i.targetId)).toEqual(skus.slice(0, 20));
  });

  it('CS-1 neither ids nor selector gives targets_missing and creates no row', async () => {
    const reader = new ScriptedReader({});
    const { deps, repository } = setup(reader);
    const { selector, ...noSelector } = baseManifest;
    expect(selector).toBeDefined();
    const req = request({ brand: 'acme', changes: { description: 'new' } });
    const out = await prepareChangeSet(deps, { ...req, operation: { ...req.operation, manifest: noSelector } });
    expect(out).toEqual({ ok: false, code: 'targets_missing' });
    expect(repository.sets.size).toBe(0);
    expect(reader.calls).toHaveLength(0);
  });

  it('CS-1 max_targets exceeded fails too_many_targets with the code stored and audited', async () => {
    const skus = ['A', 'B', 'C', 'D', 'E'];
    const reader = new ScriptedReader(Object.fromEntries(skus.map((s) => [s, product(s)])));
    const { deps, repository } = setup(reader);
    const out = await prepareChangeSet(deps, request({ ...explicitArgs, skus }, { maxTargets: 3 }));
    expect(out).toEqual({ ok: false, changesetId: 'id-1', code: 'too_many_targets' });
    expect(repository.sets.get('id-1')).toMatchObject({ status: 'failed', errorCode: 'too_many_targets' });
    expect(repository.audit.at(-1)?.details).toMatchObject({
      from: 'preparing',
      to: 'failed',
      errorCode: 'too_many_targets',
    });
  });

  it('CS-1 a read failure fails the change-set with the read code', async () => {
    const reader = new ScriptedReader({}, { readOverride: () => ({ ok: false, code: 'timeout' }) });
    const { deps, repository } = setup(reader);
    const out = await prepareChangeSet(deps, request(explicitArgs));
    expect(out).toEqual({ ok: false, changesetId: 'id-1', code: 'timeout' });
    expect(repository.sets.get('id-1')).toMatchObject({ status: 'failed', errorCode: 'timeout' });
  });

  it('CS-1 a truncated read fails incomplete_read', async () => {
    const reader = new ScriptedReader({}, { readOverride: () => ({ ok: true, items: [], truncated: true }) });
    const { deps, repository } = setup(reader);
    const out = await prepareChangeSet(deps, request(explicitArgs));
    expect(out).toEqual({ ok: false, changesetId: 'id-1', code: 'incomplete_read' });
    expect(repository.sets.get('id-1')?.status).toBe('failed');
  });

  it('CS-6 cancellation during preparation wins and is never overwritten', async () => {
    const repository = new FakeRepository();
    const reader = new ScriptedReader(
      { A: product('A'), B: product('B') },
      {
        beforeAnswer: async () => {
          await repository.transition('id-1', ['preparing'], 'cancelled', {
            id: 'x',
            actor: 'alice',
            action: 'changeset.transition',
            subject: 'catalog.update_content',
            outcome: 'ok',
            correlationId: 'c',
            details: {},
          });
        },
      },
    );
    const { deps } = setup(reader, repository);
    const out = await prepareChangeSet(deps, request(explicitArgs));
    expect(out).toEqual({ ok: false, changesetId: 'id-1', code: 'cancelled' });
    expect(repository.sets.get('id-1')?.status).toBe('cancelled');
  });

  it('CS-6 cancellation before completion is reported as cancelled', async () => {
    const repository = new FakeRepository();
    const reader = new ScriptedReader({}, { readOverride: () => ({ ok: false, code: 'network' }) });
    const { deps } = setup(reader, repository);
    const original = repository.completePreparation.bind(repository);
    repository.completePreparation = async (id, outcome, audit) => {
      await repository.transition(id, ['preparing'], 'expired', audit);
      return original(id, outcome, audit);
    };
    const out = await prepareChangeSet(deps, request(explicitArgs));
    expect(out).toEqual({ ok: false, changesetId: 'id-1', code: 'cancelled' });
    expect(repository.sets.get('id-1')?.status).toBe('expired');
  });
});

describe('OPS-4 selector targets', () => {
  const selectorArgs = { brand: 'acme', changes: { description: 'new' } };
  const page = (ids: string[], total?: number): ReadPage => ({
    ok: true,
    items: ids.map((sku) => ({ sku })),
    ...(total !== undefined ? { total } : {}),
    truncated: false,
  });
  const all = Object.fromEntries(['A', 'B', 'C', 'D', 'E'].map((s) => [s, product(s)]));

  it('OPS-4 pages through the selector until the reported total', async () => {
    const pages: Record<number, string[]> = { 1: ['A', 'B'], 2: ['C', 'D'], 3: ['E'], 4: ['X'] };
    const reader = new ScriptedReader(all, { selector: (p) => page(pages[p] ?? [], 5) });
    const { deps } = setup(reader);
    const out = await prepareChangeSet(deps, request(selectorArgs, { batchSize: 100 }));
    if (!out.ok) throw new Error(`expected prepared, got ${out.code}`);
    const sel = reader.readsOf('catalog.search_products');
    expect(sel.map((c) => c.args.current_page)).toEqual([1, 2, 3]);
    expect(sel[0]?.args).toEqual({ brand: 'acme', current_page: 1, page_size: 2, fields: ['sku'] });
    expect(out.changeset.stats.total).toBe(5);
  });

  it('OPS-4 stops at the reported total even when pages are full', async () => {
    const pages: Record<number, string[]> = { 1: ['A', 'B'], 2: ['C', 'D'], 3: ['E', 'X'] };
    const reader = new ScriptedReader(all, { selector: (p) => page(pages[p] ?? [], 4) });
    const { deps } = setup(reader);
    const out = await prepareChangeSet(deps, request(selectorArgs));
    if (!out.ok) throw new Error('expected prepared');
    expect(reader.readsOf('catalog.search_products')).toHaveLength(2);
    expect(out.changeset.stats.total).toBe(4);
  });

  it('OPS-4 overlapping selector pages do not create duplicates; selector pages re-chunked to batch size', async () => {
    const pages: Record<number, string[]> = { 1: ['A', 'B'], 2: ['B', 'C'], 3: ['D'] };
    const reader = new ScriptedReader(all, { selector: (p) => page(pages[p] ?? []) });
    const { deps } = setup(reader);
    const out = await prepareChangeSet(deps, request(selectorArgs, { batchSize: 1 }));
    if (!out.ok) throw new Error('expected prepared');
    expect(out.changeset.stats.total).toBe(4);
    expect(reader.readsOf('catalog.get_products_by_sku').every((c) => (c.args.skus as string[]).length === 1)).toBe(
      true,
    );
  });

  it('OPS-4 a selector that returns the same page every time stops once no new ids arrive', async () => {
    const reader = new ScriptedReader(all, { selector: () => page(['A', 'B']) });
    const { deps } = setup(reader);
    const out = await prepareChangeSet(deps, request(selectorArgs));
    if (!out.ok) throw new Error('expected prepared');
    expect(reader.readsOf('catalog.search_products')).toHaveLength(2);
    expect(out.changeset.stats.total).toBe(2);
  });

  it('OPS-4 a selector that finds nothing fails targets_missing', async () => {
    const reader = new ScriptedReader(all, { selector: () => page([]) });
    const { deps, repository } = setup(reader);
    const out = await prepareChangeSet(deps, request(selectorArgs));
    expect(out).toEqual({ ok: false, changesetId: 'id-1', code: 'targets_missing' });
    expect(repository.sets.get('id-1')?.status).toBe('failed');
  });

  it('OPS-4 max_targets applies to selector targets', async () => {
    let n = 0;
    const reader = new ScriptedReader(
      {},
      { selector: () => page([`T${String(n++)}`, `T${String(n++)}`]) },
    );
    const { deps } = setup(reader);
    const out = await prepareChangeSet(deps, request(selectorArgs, { maxTargets: 5 }));
    expect(out).toMatchObject({ ok: false, code: 'too_many_targets' });
  });

  it('OPS-4 a truncated selector page fails incomplete_read', async () => {
    const reader = new ScriptedReader(all, { selector: () => ({ ok: true, items: [{ sku: 'A' }], truncated: true }) });
    const { deps } = setup(reader);
    expect(await prepareChangeSet(deps, request(selectorArgs))).toMatchObject({ ok: false, code: 'incomplete_read' });
  });

  it('OPS-4 a failing selector passes its code through', async () => {
    const reader = new ScriptedReader(all, { selector: () => ({ ok: false, code: 'http_status', status: 500 }) });
    const { deps } = setup(reader);
    expect(await prepareChangeSet(deps, request(selectorArgs))).toMatchObject({ ok: false, code: 'http_status' });
  });
});

describe('NFR-7 preparation streams items in pages', () => {
  it('NFR-7 2 500 targets stay within batch and page bounds', async () => {
    const skus = Array.from({ length: 2500 }, (_, i) => `P${String(i).padStart(5, '0')}`);
    const reader = new ScriptedReader(Object.fromEntries(skus.map((s) => [s, product(s)])));
    const { deps, repository } = setup(reader);
    const out = await prepareChangeSet(deps, request({ ...explicitArgs, skus }, { batchSize: 100 }));
    if (!out.ok) throw new Error('expected prepared');
    expect(out.changeset.stats.total).toBe(2500);
    expect(repository.largestAppend).toBeLessThanOrEqual(100);
    expect(repository.largestPageLimit).toBeLessThanOrEqual(500);
    expect(Math.max(...reader.calls.map((c) => (c.args.skus as string[]).length))).toBeLessThanOrEqual(100);

    const hasher = new ChangeSetHasher('catalog.update_content', normalizeArgs({ ...explicitArgs, skus }, 'skus'));
    for (const t of skus) {
      hasher.add({ targetId: t, status: 'pending', before: { description: 'old' }, after: { description: 'new' } });
    }
    expect(out.changeset.hash).toBe(hasher.digest());
  });
});

describe('CS-1 CS-6 preparation fails closed on internal errors and lost races', () => {
  const cancelAudit = {
    id: 'x',
    actor: 'alice',
    action: 'changeset.transition',
    subject: 'catalog.update_content',
    outcome: 'ok',
    correlationId: 'c',
    details: {},
  } as const;

  it('CS-1 a throwing reader marks the change-set failed with internal', async () => {
    const reader = new ScriptedReader(
      {},
      {
        readOverride: () => {
          throw new Error('socket exploded with secret detail');
        },
      },
    );
    const { deps, repository } = setup(reader);
    const out = await prepareChangeSet(deps, request(explicitArgs));
    expect(out).toEqual({ ok: false, changesetId: 'id-1', code: 'internal' });
    expect(repository.sets.get('id-1')).toMatchObject({ status: 'failed', errorCode: 'internal' });
    expect(repository.audit.at(-1)?.details).toMatchObject({ from: 'preparing', to: 'failed', errorCode: 'internal' });
  });

  it('CS-1 appendItems rejecting while still preparing marks the change-set failed with internal', async () => {
    const reader = new ScriptedReader({ A: product('A'), B: product('B') });
    const { deps, repository } = setup(reader);
    repository.appendItems = () => Promise.reject(new Error('disk full'));
    const out = await prepareChangeSet(deps, request(explicitArgs));
    expect(out).toEqual({ ok: false, changesetId: 'id-1', code: 'internal' });
    expect(repository.sets.get('id-1')).toMatchObject({ status: 'failed', errorCode: 'internal' });
  });

  it('CS-1 when marking failed throws too, the original error propagates', async () => {
    const original = new Error('reader down');
    const reader = new ScriptedReader(
      {},
      {
        readOverride: () => {
          throw original;
        },
      },
    );
    const { deps, repository } = setup(reader);
    repository.completePreparation = () => Promise.reject(new Error('database down'));
    await expect(prepareChangeSet(deps, request(explicitArgs))).rejects.toBe(original);
  });

  it('CS-6 a cancellation landing during hashing is reported as cancelled and not overwritten', async () => {
    const reader = new ScriptedReader({ A: product('A'), B: product('B') });
    const { deps, repository } = setup(reader);
    const page = repository.itemsPage.bind(repository);
    repository.itemsPage = async (id, query) => {
      await repository.transition(id, ['preparing'], 'cancelled', cancelAudit);
      return page(id, query);
    };
    const out = await prepareChangeSet(deps, request(explicitArgs));
    expect(out).toEqual({ ok: false, changesetId: 'id-1', code: 'cancelled' });
    expect(repository.sets.get('id-1')?.status).toBe('cancelled');
    expect(repository.sets.get('id-1')?.hash).toBeUndefined();
  });
});

describe('OPS-4 selector pages are complete or the preparation fails', () => {
  const selectorArgs = { brand: 'acme', changes: { description: 'new' } };
  const all = Object.fromEntries(['A', 'B', 'C'].map((s) => [s, product(s)]));

  it('OPS-4 a selector row without a usable id fails incomplete_read', async () => {
    for (const bad of [{}, { sku: null }, { sku: { nested: 1 } }]) {
      const reader = new ScriptedReader(all, {
        selector: () => ({ ok: true, items: [{ sku: 'A' }, bad], truncated: false }),
      });
      const { deps, repository } = setup(reader);
      const out = await prepareChangeSet(deps, request(selectorArgs));
      expect(out).toEqual({ ok: false, changesetId: 'id-1', code: 'incomplete_read' });
      expect(repository.sets.get('id-1')?.status).toBe('failed');
    }
  });

  it('OPS-4 a short selector page before the reported total fails incomplete_read', async () => {
    const pages: Record<number, string[]> = { 1: ['A', 'B'], 2: ['C'] };
    const reader = new ScriptedReader(all, {
      selector: (p) => ({ ok: true, items: (pages[p] ?? []).map((sku) => ({ sku })), total: 5, truncated: false }),
    });
    const { deps } = setup(reader);
    expect(await prepareChangeSet(deps, request(selectorArgs))).toEqual({
      ok: false,
      changesetId: 'id-1',
      code: 'incomplete_read',
    });
  });

  const totalPage = (ids: string[], total: number): ReadPage => ({
    ok: true,
    items: ids.map((sku) => ({ sku })),
    total,
    truncated: false,
  });
  const four = Object.fromEntries(['A', 'B', 'C', 'D'].map((s) => [s, product(s)]));

  it('OPS-4 the same full page forever with a reported total fails incomplete_read', async () => {
    const reader = new ScriptedReader(all, { selector: () => totalPage(['A', 'B'], 5) });
    const { deps } = setup(reader);
    expect(await prepareChangeSet(deps, request(selectorArgs))).toEqual({
      ok: false,
      changesetId: 'id-1',
      code: 'incomplete_read',
    });
  });

  it('OPS-4 overlapping pages count unique ids against the total and keep paging', async () => {
    const pages: Record<number, string[]> = { 1: ['A', 'B'], 2: ['B', 'C'], 3: ['D'] };
    const reader = new ScriptedReader(four, { selector: (p) => totalPage(pages[p] ?? [], 4) });
    const { deps } = setup(reader);
    const out = await prepareChangeSet(deps, request(selectorArgs));
    if (!out.ok) throw new Error(`expected prepared, got ${out.code}`);
    expect(reader.readsOf('catalog.search_products').map((c) => c.args.current_page)).toEqual([1, 2, 3]);
    expect(out.changeset.stats.total).toBe(4);
  });

  it('OPS-4 overlapping pages that end short of the total fail incomplete_read', async () => {
    const pages: Record<number, string[]> = { 1: ['A', 'B'], 2: ['B', 'C'] };
    const reader = new ScriptedReader(four, { selector: (p) => totalPage(pages[p] ?? [], 4) });
    const { deps } = setup(reader);
    expect(await prepareChangeSet(deps, request(selectorArgs))).toMatchObject({ ok: false, code: 'incomplete_read' });
  });

  it('OPS-4 overlapping pages that reach the total are prepared', async () => {
    const pages: Record<number, string[]> = { 1: ['A', 'B'], 2: ['B', 'C'], 3: ['X'] };
    const reader = new ScriptedReader(four, { selector: (p) => totalPage(pages[p] ?? [], 3) });
    const { deps } = setup(reader);
    const out = await prepareChangeSet(deps, request(selectorArgs));
    if (!out.ok) throw new Error(`expected prepared, got ${out.code}`);
    expect(reader.readsOf('catalog.search_products')).toHaveLength(2);
    expect(out.changeset.stats.total).toBe(3);
  });

  it('OPS-4 an empty selector page before the reported total fails incomplete_read', async () => {
    const pages: Record<number, string[]> = { 1: ['A', 'B'] };
    const reader = new ScriptedReader(all, {
      selector: (p) => ({ ok: true, items: (pages[p] ?? []).map((sku) => ({ sku })), total: 3, truncated: false }),
    });
    const { deps } = setup(reader);
    expect(await prepareChangeSet(deps, request(selectorArgs))).toMatchObject({ ok: false, code: 'incomplete_read' });
  });
});
