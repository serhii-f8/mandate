// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Mandate Authors
import { describe, expect, it } from 'vitest';
import type { AuditEventInput } from '../audit.js';
import type { Caller } from '../caller.js';
import type { ManifestDefinition, ManifestLookup, OperationDefinition } from '../policy-model.js';
import { compareTargetIds, normalizeArgs } from './canonical.js';
import { FileUnavailableError, type FileArgument, type StagedFile } from '../files/index.js';
import { ChangeSetHasher } from './hash.js';
import { hashStoredItems } from './verify.js';
import { countExclusions, type ChangeItemRecord, type ChangeSetRecord, type ChangeSetStats } from './model.js';
import type {
  ItemsPageQuery,
  NewChangeSet,
  PreparationCompletion,
  PreparationRepository,
  ReadPage,
  UpstreamReader,
} from './ports.js';
import {
  createChangeSet,
  prepareChangeSet,
  runPreparation,
  type PrepareDeps,
  type PrepareRequest,
} from './prepare.js';

/** Minimal Map-based repository with the contract's compare-and-set semantics. */
class FakeRepository implements PreparationRepository {
  readonly sets = new Map<string, ChangeSetRecord>();
  readonly items = new Map<string, Map<string, ChangeItemRecord>>();
  readonly audit: AuditEventInput[] = [];
  largestAppend = 0;
  largestPageLimit = 0;
  /** CS-10: what `create` throws, when set (a file lost between the lookup and the insert). */
  createError: Error | undefined;

  create(cs: NewChangeSet, audit: AuditEventInput): Promise<ChangeSetRecord> {
    if (this.createError !== undefined) return Promise.reject(this.createError);
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
    const reasons: [string, number][] = [];
    let included = 0;
    let total = 0;
    for (const item of this.items.get(id)?.values() ?? []) {
      total++;
      if (item.status === 'excluded' && item.reason !== undefined) reasons.push([item.reason, 1]);
      else included++;
    }
    return Promise.resolve({ total, included, excluded: countExclusions(reasons), written: 0, failed: 0, skipped: 0 });
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
    outcome: PreparationCompletion,
    audit: AuditEventInput,
  ): Promise<ChangeSetRecord | undefined> {
    const cs = this.sets.get(id);
    if (cs?.status !== 'preparing') return Promise.resolve(undefined);
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
        : {
            ...cs,
            status: 'failed',
            errorCode: outcome.errorCode,
            ...(outcome.upstreamStatus === undefined ? {} : { errorStatus: outcome.upstreamStatus }),
          };
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

/** The operation of `operation()` without a manifest. */
function bareOperation(): OperationDefinition {
  const op: Partial<ReturnType<typeof operation>> = operation();
  delete op.manifest;
  return op as OperationDefinition;
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
/** The seal of every new preparation of an update manifest (CS-4 hash version 2). */
const V2_UPDATE = { version: 2, action: 'update' } as const;

describe('CS-4 hash version', () => {
  it('CS-4 a newly prepared change-set is sealed with version 2 and its manifest action', async () => {
    const { deps, repository } = setup(new ScriptedReader({ A: product('A'), B: product('B') }));
    const out = await prepareChangeSet(deps, request(explicitArgs));
    if (!out.ok) throw new Error(`expected prepared, got ${out.code}`);
    expect(out.changeset.hashVersion).toBe(2);
    expect(out.changeset.action).toBe('update');
    expect(out.changeset.hash).toBe(await hashStoredItems(repository, out.changeset));
    expect(out.changeset.hash).not.toBe(await hashStoredItems(repository, { ...out.changeset, hashVersion: 1 }));
  });
});

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

    const hasher = new ChangeSetHasher('catalog.update_content', normalizeArgs(explicitArgs, 'skus'), V2_UPDATE);
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

  it('CS-3 the read requests the record fields of the checks; stats count the custom code', async () => {
    const reader = new ScriptedReader({ A: { ...product('A'), status: 'locked' }, B: { ...product('B'), status: 'open' } });
    const { deps } = setup(reader);
    const checks = [{ code: 'locked', require: [{ in: { record: 'status' }, values: ['open'] }] }];
    const out = await prepareChangeSet(deps, request(explicitArgs, { checks }));
    if (!out.ok) throw new Error(`expected prepared, got ${out.code}`);
    expect(reader.calls[0]?.args.fields).toEqual(['sku', 'brand', 'description', 'status']);
    expect(out.changeset.stats).toMatchObject({ total: 2, included: 1, excluded: { locked: 1 } });
    expect(out.firstItems.map((i) => [i.targetId, i.status, i.reason])).toEqual([
      ['A', 'excluded', 'locked'],
      ['B', 'pending', undefined],
    ]);
  });

  it('CS-3 AUD-1 the prepared audit event counts custom codes as a number, even an Object.prototype member name', async () => {
    const reader = new ScriptedReader({ A: { ...product('A'), status: 'locked' }, B: { ...product('B'), status: 'open' } });
    const { deps, repository } = setup(reader);
    // `constructor` bypasses the loader, which refuses it: the count must still be a number.
    const checks = [{ code: 'constructor', require: [{ in: { record: 'status' }, values: ['open'] }] }];
    const out = await prepareChangeSet(deps, request(explicitArgs, { checks }));
    if (!out.ok) throw new Error(`expected prepared, got ${out.code}`);
    expect(out.changeset.stats.excluded).toEqual({ constructor: 1 });
    expect(repository.audit[1]?.details).toMatchObject({ included: 1, excluded: 1 });
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

  it('CS-1 an empty ids argument gives targets_missing without falling back to the selector', async () => {
    const reader = new ScriptedReader({}, { selector: () => ({ ok: true, items: [{ sku: 'A' }], truncated: false }) });
    const { deps, repository } = setup(reader);
    const out = await prepareChangeSet(deps, request({ ...explicitArgs, skus: [] }));
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

  it('CS-1 an upstream HTTP status travels with the failure code', async () => {
    const reader = new ScriptedReader({}, { readOverride: () => ({ ok: false, code: 'http_status', status: 404 }) });
    const { deps, repository } = setup(reader);
    const out = await prepareChangeSet(deps, request(explicitArgs));
    expect(out).toEqual({ ok: false, changesetId: 'id-1', code: 'http_status', status: 404 });
    // Stored with the code, so an answer rebuilt from the change-set names it too (design §5 step 4).
    expect(repository.sets.get('id-1')).toMatchObject({ status: 'failed', errorCode: 'http_status', errorStatus: 404 });
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

describe('CS-2 per-record values', () => {
  /** A records manifest: built without the `valuesArg`, `idsArg` and `selector` keys (exactOptionalPropertyTypes). */
  const recordsManifest: ManifestDefinition = {
    idField: 'sku',
    recordsArg: 'records',
    fields: ['name', 'price'],
    requiredFields: [],
    scopeArgs: { brand: 'brand' },
    readBefore: baseManifest.readBefore,
    batchSize: 1,
    maxTargets: 10_000,
    rollback: { strategy: 'replay_previous_state' },
  };
  const recordsRequest = (args: Record<string, unknown>, patch: Partial<ManifestDefinition> = {}): PrepareRequest => {
    const req = request(args);
    return { ...req, operation: { ...req.operation, fieldsArg: 'records', manifest: { ...recordsManifest, ...patch } } };
  };
  const recordArgs = { brand: 'acme', records: [{ sku: 'b', price: 2 }, { sku: 'a', name: 'A2', price: 1 }] };

  it('CS-2 two records with one identifier refuse the call and create nothing', async () => {
    const reader = new ScriptedReader({});
    const { deps, repository } = setup(reader);
    const args = { brand: 'acme', records: [{ sku: 1, price: 1 }, { sku: '1', price: 2 }] };
    expect(await createChangeSet(deps, recordsRequest(args))).toEqual({ ok: false, code: 'duplicate_targets' });
    expect(repository.sets.size).toBe(0);
    expect(reader.calls).toHaveLength(0);
  });

  it('CS-2 a records call prepares one item per record and reads the union of touched fields', async () => {
    const reader = new ScriptedReader({
      a: { sku: 'a', brand: 'acme', name: 'A1', price: 1 },
      b: { sku: 'b', brand: 'acme', name: 'B', price: 1 },
    });
    const { deps, repository } = setup(reader);
    const out = await prepareChangeSet(deps, recordsRequest(recordArgs));
    if (!out.ok) throw new Error(`expected prepared, got ${out.code}`);
    const reads = reader.readsOf('catalog.get_products_by_sku');
    expect(reads.map((c) => c.args.skus)).toEqual([['a'], ['b']]);
    expect(reads[0]?.args.fields).toEqual(['sku', 'brand', 'name', 'price']);
    expect(repository.sets.get(out.changeset.id)?.args).toEqual({
      brand: 'acme',
      records: [
        { sku: 'a', name: 'A2', price: 1 },
        { sku: 'b', price: 2 },
      ],
    });
    expect(out.firstItems).toEqual([
      { targetId: 'a', status: 'pending', before: { name: 'A1', price: 1 }, after: { name: 'A2', price: 1 } },
      { targetId: 'b', status: 'pending', before: { price: 1 }, after: { price: 2 } },
    ]);
  });

  it('CS-1 more records than max_targets fail too_many_targets', async () => {
    const reader = new ScriptedReader({});
    const { deps } = setup(reader);
    const out = await prepareChangeSet(deps, recordsRequest(recordArgs, { maxTargets: 1 }));
    expect(out).toEqual({ ok: false, changesetId: 'id-1', code: 'too_many_targets' });
    expect(reader.calls).toHaveLength(0);
  });
});

describe('OPS-7 lookups in preparation', () => {
  const SENTINEL = 'erp-sentinel-cost-7f3a';
  /** The catalog of `ScriptedReader`, plus an ERP on another connection that knows only some codes. */
  class CatalogAndErp extends ScriptedReader {
    constructor(
      products: Record<string, Record<string, unknown>>,
      private readonly erp: Record<string, Record<string, unknown>>,
      private readonly erpPage?: ReadPage,
    ) {
      super(products);
    }
    override async read(op: string, args: Readonly<Record<string, unknown>>): Promise<ReadPage> {
      if (op !== 'erp.get_parts') return super.read(op, args);
      this.calls.push({ op, args });
      if (this.erpPage !== undefined) return this.erpPage;
      const codes = args.codes as string[];
      return { ok: true, items: codes.flatMap((c) => (this.erp[c] ? [this.erp[c]] : [])), truncated: false };
    }
  }
  const erpLookup: ManifestLookup = { operation: 'erp.get_parts', idsArg: 'codes', keyField: 'code', key: { target: true }, fields: ['cost'], args: {} };
  const lookups = { erp: erpLookup };
  const checks = [{ code: 'not_in_erp', require: [{ found: 'erp' }] }];
  const products = { A: product('A'), B: product('B'), C: product('C') };
  const erpRecord = (code: string) => ({ code, cost: SENTINEL });
  const args = { brand: 'acme', skus: ['A', 'B', 'C'], changes: { description: 'new' } };
  const lookupRequest = (patch: Partial<ManifestDefinition> = {}): PrepareRequest => ({
    ...request(args, { lookups, checks, batchSize: 10, ...patch }),
    readFieldsArg: (op) => (op === 'catalog.update_content' ? undefined : 'fields'),
  });

  it('OPS-7 CS-3 SEC-3 of three targets the one the ERP does not return is excluded not_in_erp; no ERP value is stored, audited or returned', async () => {
    const reader = new CatalogAndErp(products, { A: erpRecord('A'), C: erpRecord('C') });
    const { deps, repository } = setup(reader);
    const out = await prepareChangeSet(deps, lookupRequest());
    if (!out.ok) throw new Error(`expected prepared, got ${out.code}`);
    expect(reader.readsOf('erp.get_parts').map((c) => c.args)).toEqual([{ codes: ['A', 'B', 'C'], fields: ['code', 'cost'] }]);
    expect(out.firstItems.map((i) => [i.targetId, i.status, i.reason])).toEqual([
      ['A', 'pending', undefined],
      ['B', 'excluded', 'not_in_erp'],
      ['C', 'pending', undefined],
    ]);
    expect(out.changeset.stats).toMatchObject({ total: 3, included: 2, excluded: { not_in_erp: 1 } });
    const stored = [...(repository.items.get(out.changeset.id)?.values() ?? [])];
    expect(stored).toHaveLength(3);
    for (const leaked of [stored, repository.audit, out.changeset, out.firstItems, [...repository.sets.values()]]) {
      expect(JSON.stringify(leaked)).not.toContain(SENTINEL);
    }
  });

  it('OPS-7 a lookup reads only for items still pending, keyed by a record field the read_before read requests', async () => {
    const reader = new CatalogAndErp(
      { A: { ...product('A'), mpn: 'M-A' }, B: { ...product('B', 'new'), mpn: 'M-B' }, C: { ...product('C'), mpn: 'M-C' } },
      { 'M-A': erpRecord('M-A') },
    );
    const { deps } = setup(reader);
    const out = await prepareChangeSet(deps, lookupRequest({ lookups: { erp: { ...erpLookup, key: { record: 'mpn' } } } }));
    if (!out.ok) throw new Error(`expected prepared, got ${out.code}`);
    expect(reader.readsOf('catalog.get_products_by_sku')[0]?.args.fields).toEqual(['sku', 'brand', 'description', 'mpn']);
    // B would not change (no_change), so only A and C are looked up.
    expect(reader.readsOf('erp.get_parts').map((c) => c.args.codes)).toEqual([['M-A', 'M-C']]);
    expect(out.firstItems.map((i) => [i.targetId, i.status, i.reason])).toEqual([
      ['A', 'pending', undefined],
      ['B', 'excluded', 'no_change'],
      ['C', 'excluded', 'not_in_erp'],
    ]);
  });

  it('OPS-7 a lookup field reference reads the result of the item', async () => {
    const reader = new CatalogAndErp(products, { A: { code: 'A', cost: 5 }, B: { code: 'B', cost: 0 }, C: { code: 'C', cost: 5 } });
    const { deps } = setup(reader);
    const priced = [{ code: 'no_cost', require: [{ in: { lookup: 'erp', field: 'cost' }, values: [5] }] }];
    const out = await prepareChangeSet(deps, lookupRequest({ checks: priced }));
    if (!out.ok) throw new Error(`expected prepared, got ${out.code}`);
    expect(out.firstItems.map((i) => i.reason)).toEqual([undefined, 'no_cost', undefined]);
  });

  it('OPS-7 a failing ERP read fails the change-set lookup_failed with the upstream status', async () => {
    const reader = new CatalogAndErp(products, {}, { ok: false, code: 'http_status', status: 503 });
    const { deps, repository } = setup(reader);
    const out = await prepareChangeSet(deps, lookupRequest());
    expect(out).toEqual({ ok: false, changesetId: 'id-1', code: 'lookup_failed', status: 503 });
    const record = repository.sets.get('id-1');
    expect(record?.status).toBe('failed');
    expect(record?.errorCode).toBe('lookup_failed');
    expect(record?.errorStatus).toBe(503);
    expect(record?.hash).toBeUndefined();
  });

  it('OPS-7 a truncated ERP read fails the change-set incomplete_read instead of excluding', async () => {
    const reader = new CatalogAndErp(products, {}, { ok: true, items: [], truncated: true });
    const { deps, repository } = setup(reader);
    const out = await prepareChangeSet(deps, lookupRequest());
    expect(out).toEqual({ ok: false, changesetId: 'id-1', code: 'incomplete_read' });
    expect(repository.sets.get('id-1')?.status).toBe('failed');
  });
});

describe('OPS-2 CS-4 create and delete', () => {
  it('OPS-2 CS-4 a create over three records of which one exists prepares two pending and one already_exists, sealed v2 create', async () => {
    const createManifest: ManifestDefinition = {
      action: 'create',
      idField: 'sku',
      recordsArg: 'records',
      fields: ['brand', 'name'],
      requiredFields: [],
      scopeArgs: { brand: 'brand' },
      readBefore: baseManifest.readBefore,
      batchSize: 10,
      maxTargets: 10_000,
      rollback: { strategy: 'none' },
    };
    const reader = new ScriptedReader({ n2: { sku: 'n2', brand: 'acme', name: 'Old' } });
    const { deps, repository } = setup(reader);
    const req = request({
      brand: 'acme',
      records: [
        { sku: 'n3', brand: 'acme', name: 'N3' },
        { sku: 'n1', brand: 'acme', name: 'N1' },
        { sku: 'n2', brand: 'acme', name: 'N2' },
      ],
    });
    const out = await prepareChangeSet(deps, { ...req, operation: { ...req.operation, fieldsArg: 'records', manifest: createManifest } });
    if (!out.ok) throw new Error(`expected prepared, got ${out.code}`);
    expect(reader.calls[0]?.args.fields).toEqual(['sku', 'brand', 'name']);
    expect(out.firstItems).toEqual([
      { targetId: 'n1', status: 'pending', before: null, after: { brand: 'acme', name: 'N1' } },
      {
        targetId: 'n2',
        status: 'excluded',
        reason: 'already_exists',
        before: { brand: 'acme', name: 'Old' },
        after: { brand: 'acme', name: 'N2' },
      },
      { targetId: 'n3', status: 'pending', before: null, after: { brand: 'acme', name: 'N3' } },
    ]);
    expect(out.changeset.stats).toMatchObject({ total: 3, included: 2, excluded: { already_exists: 1 } });
    expect(out.changeset.hashVersion).toBe(2);
    expect(out.changeset.action).toBe('create');
    expect(out.changeset.hash).toBe(await hashStoredItems(repository, out.changeset));
  });

  it('OPS-2 a delete by ids reads every manifest field in read_before', async () => {
    const deleteManifest: ManifestDefinition = {
      action: 'delete',
      idField: 'sku',
      idsArg: 'skus',
      fields: ['name', 'description'],
      requiredFields: [],
      scopeArgs: { brand: 'brand' },
      readBefore: baseManifest.readBefore,
      batchSize: 10,
      maxTargets: 10_000,
      rollback: { strategy: 'none' },
    };
    const reader = new ScriptedReader({ A: product('A') });
    const { deps } = setup(reader);
    const req = request({ brand: 'acme', skus: ['A'] });
    const out = await prepareChangeSet(deps, { ...req, operation: { ...req.operation, manifest: deleteManifest } });
    if (!out.ok) throw new Error(`expected prepared, got ${out.code}`);
    expect(reader.calls[0]?.args.fields).toEqual(['sku', 'brand', 'name', 'description']);
    expect(out.firstItems).toEqual([
      { targetId: 'A', status: 'pending', before: { name: null, description: 'old' }, after: null },
    ]);
    expect(out.changeset.action).toBe('delete');
  });
});

describe('OPS-2 CS-7 POL-2 create and delete read existence without the scope filter', () => {
  /** What the loader admits for a create or delete: a read_before without the scope argument (ADR 0071). */
  const unscopedRead = { operation: 'catalog.get_products_by_sku', idsArg: 'skus', args: {} };
  const createManifest: ManifestDefinition = {
    action: 'create',
    idField: 'sku',
    recordsArg: 'records',
    fields: ['brand', 'name'],
    requiredFields: [],
    scopeArgs: { brand: 'brand' },
    readBefore: unscopedRead,
    batchSize: 10,
    maxTargets: 10_000,
    rollback: { strategy: 'none' },
  };
  const deleteManifest: ManifestDefinition = {
    action: 'delete',
    idField: 'sku',
    idsArg: 'skus',
    fields: ['name', 'description'],
    requiredFields: [],
    scopeArgs: { brand: 'brand' },
    readBefore: unscopedRead,
    batchSize: 10,
    maxTargets: 10_000,
    rollback: { strategy: 'none' },
  };
  const prepare = async (reader: ScriptedReader, args: Record<string, unknown>, manifest: ManifestDefinition, fieldsArg: string) => {
    const { deps } = setup(reader);
    const req = request(args);
    const out = await prepareChangeSet(deps, { ...req, operation: { ...req.operation, fieldsArg, manifest } });
    if (!out.ok) throw new Error(`expected prepared, got ${out.code}`);
    return out;
  };

  it('OPS-2 SEC-3 a create of an identifier that exists outside the scope is already_exists with before null', async () => {
    const reader = new ScriptedReader({ n1: { sku: 'n1', brand: 'other', name: 'Foreign' } });
    const out = await prepare(reader, { brand: 'acme', records: [{ sku: 'n1', brand: 'acme', name: 'N1' }] }, createManifest, 'records');
    expect(reader.calls[0]?.args).toEqual({ skus: ['n1'], fields: ['sku', 'brand', 'name'] });
    expect(out.firstItems).toEqual([
      { targetId: 'n1', status: 'excluded', reason: 'already_exists', before: null, after: { brand: 'acme', name: 'N1' } },
    ]);
    expect(JSON.stringify(out.firstItems)).not.toContain('Foreign');
  });

  it('POL-2 a delete of a target outside the scope is out_of_scope and stores no values', async () => {
    const reader = new ScriptedReader({ A: { sku: 'A', brand: 'other', name: 'Foreign', description: 'd' } });
    const out = await prepare(reader, { brand: 'acme', skus: ['A'] }, deleteManifest, 'changes');
    expect(reader.calls[0]?.args).toEqual({ skus: ['A'], fields: ['sku', 'brand', 'name', 'description'] });
    expect(out.firstItems).toEqual([{ targetId: 'A', status: 'excluded', reason: 'out_of_scope', before: null, after: null }]);
  });
});

describe('CS-7 a short read_before page fails a create or delete preparation closed', () => {
  const createManifest: ManifestDefinition = {
    action: 'create',
    idField: 'sku',
    recordsArg: 'records',
    fields: ['name'],
    requiredFields: [],
    scopeArgs: {},
    readBefore: { operation: 'catalog.get_products_by_sku', idsArg: 'skus', args: {} },
    batchSize: 10,
    maxTargets: 10_000,
    rollback: { strategy: 'none' },
  };
  const deleteManifest: ManifestDefinition = {
    action: 'delete',
    idField: 'sku',
    idsArg: 'skus',
    fields: ['name'],
    requiredFields: [],
    scopeArgs: {},
    readBefore: { operation: 'catalog.get_products_by_sku', idsArg: 'skus', args: {} },
    batchSize: 10,
    maxTargets: 10_000,
    rollback: { strategy: 'none' },
  };
  const createArgs = { records: [{ sku: 'n1', name: 'N1' }, { sku: 'n2', name: 'N2' }] };
  const deleteArgs = { skus: ['A', 'B'] };
  /** One record of the two asked for, while the upstream reports two: a default page size cut the answer. */
  const short = (sku: string): ReadPage => ({ ok: true, items: [{ sku, name: 'x' }], total: 2, truncated: false });
  const prepare = (page: ReadPage, args: Record<string, unknown>, manifest: ManifestDefinition, fieldsArg = 'changes') => {
    const { deps } = setup(new ScriptedReader({}, { readOverride: () => page }));
    const req = request(args);
    return prepareChangeSet(deps, { ...req, operation: { ...req.operation, fieldsArg, manifest } });
  };

  it('CS-7 a create whose read answers fewer records than the reported total fails incomplete_read', async () => {
    expect(await prepare(short('n1'), createArgs, createManifest, 'records')).toMatchObject({ ok: false, code: 'incomplete_read' });
  });

  it('CS-7 a delete whose read answers fewer records than the reported total fails incomplete_read', async () => {
    expect(await prepare(short('A'), deleteArgs, deleteManifest)).toMatchObject({ ok: false, code: 'incomplete_read' });
  });

  it('CS-7 a create or delete whose read returns a record without a readable identifier fails incomplete_read', async () => {
    const unidentified: ReadPage = { ok: true, items: [{ sku: 'n1', name: 'x' }, { name: 'y' }], truncated: false };
    expect(await prepare(unidentified, createArgs, createManifest, 'records')).toMatchObject({ ok: false, code: 'incomplete_read' });
    const unidentifiedDelete: ReadPage = { ok: true, items: [{ sku: 'A', name: 'x' }, { sku: { id: 'B' }, name: 'y' }], truncated: false };
    expect(await prepare(unidentifiedDelete, deleteArgs, deleteManifest)).toMatchObject({ ok: false, code: 'incomplete_read' });
  });

  it('CS-7 an update with the same short page prepares as before: the missing target is not_found', async () => {
    const out = await prepare(
      { ok: true, items: [product('A')], total: 2, truncated: false },
      { brand: 'acme', skus: ['A', 'B'], changes: { description: 'new' } },
      { ...baseManifest, batchSize: 10 },
    );
    if (!out.ok) throw new Error(`expected prepared, got ${out.code}`);
    expect(out.changeset.stats).toMatchObject({ total: 2, included: 1, excluded: { not_found: 1 } });
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

    const hasher = new ChangeSetHasher('catalog.update_content', normalizeArgs({ ...explicitArgs, skus }, 'skus'), V2_UPDATE);
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

describe('EXE-1 preparation split', () => {
  function runRequest(id: string, args: Record<string, unknown> = explicitArgs) {
    const r = request(args);
    return {
      changesetId: id,
      operation: r.operation,
      readFieldsArg: r.readFieldsArg,
      actor: 'alice',
      clientId: 'client-1',
      correlationId: 'corr-1',
    };
  }

  it('CS-6 a one-minute expiry is exactly 60000 ms after creation', async () => {
    const { deps } = setup(new ScriptedReader({ A: product('A') }));
    const out = await createChangeSet(deps, { ...request({ ...explicitArgs, skus: ['A'] }), expireAfterHours: 1 / 60 });
    if (!out.ok) throw new Error(`expected created, got ${out.code}`);
    expect(out.changeset.expiresAt.getTime() - out.changeset.createdAt.getTime()).toBe(60000);
  });

  it('EXE-1 createChangeSet stores a preparing row with its audit and reads nothing', async () => {
    const reader = new ScriptedReader({ A: product('A'), B: product('B') });
    const { deps, repository } = setup(reader);
    const out = await createChangeSet(deps, request(explicitArgs));
    if (!out.ok) throw new Error(`expected created, got ${out.code}`);
    expect(reader.calls).toHaveLength(0);
    expect(repository.sets.get(out.changeset.id)?.status).toBe('preparing');
    expect(repository.audit.map((a) => [a.details.from, a.details.to])).toEqual([[null, 'preparing']]);
  });

  it('EXE-1 createChangeSet refuses an empty ids argument without creating a row', async () => {
    const { deps, repository } = setup(new ScriptedReader({}));
    expect(await createChangeSet(deps, request({ ...explicitArgs, skus: [] }))).toEqual({
      ok: false,
      code: 'targets_missing',
    });
    expect(repository.sets.size).toBe(0);
  });

  it('CS-1 createChangeSet accepts an opaque operation without targets and stores the arguments', async () => {
    const reader = new ScriptedReader({});
    const { deps, repository } = setup(reader);
    const opaqueArgs = { order: '100', lines: [{ sku: 'B' }, { sku: 'A' }] };
    const out = await createChangeSet(deps, {
      ...request(opaqueArgs),
      operation: { ...bareOperation(), id: 'orders.cancel', risk: 'write_opaque' },
    });
    if (!out.ok) throw new Error(`expected created, got ${out.code}`);
    expect(out.changeset.status).toBe('preparing');
    expect(out.changeset.operation).toBe('orders.cancel');
    expect(out.changeset.args).toEqual(opaqueArgs);
    expect(repository.sets.get(out.changeset.id)?.args).toEqual(opaqueArgs);
    expect(reader.calls).toHaveLength(0);
  });

  it('CS-1 createChangeSet refuses a non-opaque operation without a manifest with operation_unavailable', async () => {
    const { deps, repository } = setup(new ScriptedReader({}));
    expect(await createChangeSet(deps, { ...request(explicitArgs), operation: bareOperation() })).toEqual({
      ok: false,
      code: 'operation_unavailable',
    });
    expect(repository.sets.size).toBe(0);
  });

  it('CS-1 a write operation with a manifest still takes the manifest path in createChangeSet', async () => {
    const { deps, repository } = setup(new ScriptedReader({}));
    const out = await createChangeSet(deps, request({ ...explicitArgs, skus: ['B', 'A', 'A'] }));
    if (!out.ok) throw new Error(`expected created, got ${out.code}`);
    expect(out.changeset.args).toEqual({ ...explicitArgs, skus: ['A', 'B'] });
    expect(await createChangeSet(deps, request({ ...explicitArgs, skus: [] }))).toEqual({
      ok: false,
      code: 'targets_missing',
    });
    expect(repository.sets.size).toBe(1);
  });

  it('EXE-1 runPreparation prepares a created change-set with the same hash as prepareChangeSet', async () => {
    const products = { A: product('A'), B: product('B') };
    const one = setup(new ScriptedReader(products));
    const two = setup(new ScriptedReader(products));
    const whole = await prepareChangeSet(one.deps, request(explicitArgs));
    const created = await createChangeSet(two.deps, request(explicitArgs));
    if (!whole.ok || !created.ok) throw new Error('expected prepared');
    const split = await runPreparation(two.deps, runRequest(created.changeset.id));
    if (!split.ok) throw new Error(`expected prepared, got ${split.code}`);
    expect(split.changeset.hash).toBe(whole.changeset.hash);
    expect(split.changeset.stats).toEqual(whole.changeset.stats);
  });

  it('NFR-2 runPreparation on a change-set that is already prepared returns it without reading', async () => {
    const reader = new ScriptedReader({ A: product('A'), B: product('B') });
    const { deps } = setup(reader);
    const first = await prepareChangeSet(deps, request(explicitArgs));
    if (!first.ok) throw new Error('expected prepared');
    const readsBefore = reader.calls.length;
    const again = await runPreparation(deps, runRequest(first.changeset.id));
    expect(again.ok).toBe(true);
    expect(reader.calls).toHaveLength(readsBefore);
  });

  it('NFR-2 runPreparation on a cancelled change-set returns cancelled', async () => {
    const reader = new ScriptedReader({ A: product('A'), B: product('B') });
    const { deps, repository } = setup(reader);
    const created = await createChangeSet(deps, request(explicitArgs));
    if (!created.ok) throw new Error('expected created');
    repository.sets.set(created.changeset.id, { ...created.changeset, status: 'cancelled' });
    expect(await runPreparation(deps, runRequest(created.changeset.id))).toMatchObject({ ok: false, code: 'cancelled' });
    expect(reader.calls).toHaveLength(0);
  });

  it('NFR-2 runPreparation fails preparation_interrupted when items from an earlier attempt exist', async () => {
    const reader = new ScriptedReader({ A: product('A'), B: product('B') });
    const { deps, repository } = setup(reader);
    const created = await createChangeSet(deps, request(explicitArgs));
    if (!created.ok) throw new Error('expected created');
    const id = created.changeset.id;
    await repository.appendItems(id, [{ targetId: 'A', status: 'pending', before: {}, after: {} }]);
    expect(await runPreparation(deps, runRequest(id))).toMatchObject({ ok: false, code: 'preparation_interrupted' });
    expect(repository.sets.get(id)?.status).toBe('failed');
    expect(reader.calls).toHaveLength(0);
  });
});

describe('CS-10 createChangeSet with files', () => {
  const FILE_ID = '11111111-1111-4111-8111-111111111111';
  const sha = `sha256:${'a'.repeat(64)}`;
  const staged = (over: Partial<StagedFile> = {}): StagedFile => ({
    id: FILE_ID,
    owner: 'alice',
    name: 'logo.png',
    mediaType: 'image/png',
    size: 100,
    sha256: sha,
    preview: 'image',
    createdAt: new Date('2026-11-17T09:00:00.000Z'),
    ...over,
  });
  const entry: FileArgument = {
    pointer: '/attachment',
    path: ['attachment'],
    send: 'base64',
    mediaTypes: ['image/png'],
    maxBytes: 1000,
  };
  const fileOp = (): OperationDefinition => ({
    ...bareOperation(),
    id: 'orders.attach',
    risk: 'write_opaque',
    files: [entry],
  });
  const store = (file: StagedFile | undefined) => ({ get: (id: string) => Promise.resolve(id === FILE_ID ? file : undefined) });
  const call = (deps: ReturnType<typeof setup>['deps'], files: { get: (id: string) => Promise<StagedFile | undefined> } | undefined, args: Record<string, unknown>, operation = fileOp()) =>
    createChangeSet(files === undefined ? deps : { ...deps, files }, { ...request(args), operation });
  const descriptor = { id: FILE_ID, name: 'logo.png', media_type: 'image/png', size: 100, sha256: sha };

  it('CS-10 the caller\'s staged file becomes a descriptor in the arguments and a link', async () => {
    const { deps, repository } = setup(new ScriptedReader({}));
    const out = await call(deps, store(staged()), { order: '1', attachment: FILE_ID.toUpperCase() });
    if (!out.ok) throw new Error(`expected created, got ${out.code}`);
    expect(out.changeset.args).toEqual({ order: '1', attachment: { $file: descriptor } });
    expect(out.changeset.files).toEqual([{ pointer: '/attachment', fileId: FILE_ID }]);
    expect(repository.sets.get(out.changeset.id)?.files).toEqual([{ pointer: '/attachment', fileId: FILE_ID }]);
  });

  it.each([
    ['another user\'s file', staged({ owner: 'bob' }), FILE_ID, 'file_not_found'],
    ['an unknown id', undefined, FILE_ID, 'file_not_found'],
    ['a purged file', staged({ purgedAt: new Date('2026-11-17T09:30:00.000Z') }), FILE_ID, 'file_not_found'],
    ['an id that is not a uuid', staged(), 'x\u0000y', 'file_not_found'],
    ['a too large file', staged({ size: 1001 }), FILE_ID, 'file_too_large'],
    ['a type outside the list', staged({ mediaType: 'text/html' }), FILE_ID, 'file_type_not_allowed'],
  ])('CS-10 %s is refused and creates nothing', async (_n, file, id, code) => {
    const { deps, repository } = setup(new ScriptedReader({}));
    expect(await call(deps, store(file), { order: '1', attachment: id })).toEqual({ ok: false, code, pointer: '/attachment' });
    expect(repository.sets.size).toBe(0);
    expect(repository.audit).toHaveLength(0);
  });

  it('CS-10 an operation with files and no file store fails closed with file_not_found', async () => {
    const { deps, repository } = setup(new ScriptedReader({}));
    expect(await call(deps, undefined, { attachment: FILE_ID })).toEqual({ ok: false, code: 'file_not_found', pointer: '/attachment' });
    expect(repository.sets.size).toBe(0);
  });

  it('CS-10 a file lost between the lookup and the insert refuses the creation with its pointer', async () => {
    const { deps, repository } = setup(new ScriptedReader({}));
    repository.createError = new FileUnavailableError('/attachment');
    expect(await call(deps, store(staged()), { attachment: FILE_ID })).toEqual({ ok: false, code: 'file_not_found', pointer: '/attachment' });
  });

  it('CS-10 any other error from the repository propagates', async () => {
    const { deps, repository } = setup(new ScriptedReader({}));
    repository.createError = new Error('db down');
    await expect(call(deps, store(staged()), { attachment: FILE_ID })).rejects.toThrow('db down');
  });

  it('CS-10 an operation without files passes an argument that looks like a descriptor through untouched', async () => {
    const { deps } = setup(new ScriptedReader({}));
    const args = { attachment: { $file: descriptor } };
    const out = await call(deps, undefined, args, { ...fileOp(), files: [] });
    if (!out.ok) throw new Error(`expected created, got ${out.code}`);
    expect(out.changeset.args).toEqual(args);
    expect(out.changeset.files).toBeUndefined();
    const plain = await call(deps, store(staged()), args, { ...bareOperation(), id: 'orders.plain', risk: 'write_opaque' });
    if (!plain.ok) throw new Error(`expected created, got ${plain.code}`);
    expect(plain.changeset.args).toEqual(args);
    expect(plain.changeset.files).toBeUndefined();
  });
});
