// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Mandate Authors
import { describe, expect, it } from 'vitest';
import type { AuditEventInput } from '../audit.js';
import type { Caller } from '../caller.js';
import type { ManifestDefinition, OperationDefinition, RiskClass } from '../policy-model.js';
import type { FileArgument, StagedFile } from '../files/index.js';
import { compareTargetIds } from './canonical.js';
import { ChangeSetHasher } from './hash.js';
import type { ChangeItemRecord, ChangeSetRecord, ChangeSetStats } from './model.js';
import { OPAQUE_TARGET_ID, changesetKind, isOpaque, runOpaquePreparation } from './opaque.js';
import type { ItemsPageQuery, NewChangeSet, PreparationCompletion, PreparationRepository } from './ports.js';
import { createChangeSet } from './prepare.js';
import { hashStoredItems } from './verify.js';

const MANIFEST: ManifestDefinition = {
  idField: 'sku',
  idsArg: 'skus',
  valuesArg: 'changes',
  fields: ['name'],
  requiredFields: [],
  scopeArgs: {},
  readBefore: { operation: 'catalog.get_products', idsArg: 'skus', args: {} },
  batchSize: 50,
  maxTargets: 500,
  rollback: { strategy: 'none' },
};

type Row = [string, RiskClass, ManifestDefinition | undefined, boolean];

const rows: Row[] = [
  ['write_opaque without manifest', 'write_opaque', undefined, true],
  ['destructive without manifest', 'destructive', undefined, true],
  ['destructive with manifest', 'destructive', MANIFEST, false],
  ['write with manifest', 'write', MANIFEST, false],
  ['read', 'read', undefined, false],
];

describe('POL-5 opaque operations', () => {
  it.each(rows)('POL-5 %s', (_name, risk, manifest, expected) => {
    const op = { risk, ...(manifest === undefined ? {} : { manifest }) };
    expect(isOpaque(op)).toBe(expected);
    expect(changesetKind(op)).toBe(expected ? 'opaque' : 'diff');
  });

  it('POL-5 an operation missing from the snapshot is a diff change-set', () => {
    expect(changesetKind(undefined)).toBe('diff');
  });

  it('POL-5 the one item of an opaque change-set is named call', () => {
    expect(OPAQUE_TARGET_ID).toBe('call');
  });
});

/** Map-based preparation store with the contract's semantics: idempotent append, compare-and-set completion. */
class FakeRepository implements PreparationRepository {
  readonly sets = new Map<string, ChangeSetRecord>();
  readonly items = new Map<string, Map<string, ChangeItemRecord>>();
  readonly audit: AuditEventInput[] = [];
  /** Runs inside appendItems before the store checks the status (a concurrent cancel). */
  onAppend: (() => void) | undefined;

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
  appendItems(id: string, items: readonly ChangeItemRecord[]): Promise<number> {
    this.onAppend?.();
    if (this.sets.get(id)?.status !== 'preparing') return Promise.reject(new Error('not preparing'));
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
    const total = this.items.get(id)?.size ?? 0;
    return Promise.resolve({ total, included: total, excluded: {}, written: 0, failed: 0, skipped: 0 });
  }
  get(id: string): Promise<ChangeSetRecord | undefined> {
    return Promise.resolve(this.sets.get(id));
  }
  itemsPage(id: string, query: ItemsPageQuery): Promise<readonly ChangeItemRecord[]> {
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
        : { ...cs, status: 'failed', errorCode: outcome.errorCode };
    this.sets.set(id, next);
    this.audit.push(audit);
    return Promise.resolve(next);
  }
}

const OPAQUE_OP: OperationDefinition = {
  id: 'orders.cancel',
  toolName: 'orders_cancel',
  source: 'config',
  connection: 'shop',
  risk: 'write_opaque',
  description: 'Cancel an order',
  inputSchema: { type: 'object' },
};

const caller: Caller = { subject: 'alice', clientId: 'client-1', groups: [] };
const ARGS = { order: '100', reason: { code: 'customer', note: 'asked twice' }, lines: [2, 1] };

function setup(repository = new FakeRepository()) {
  let n = 0;
  const deps = { repository, newId: () => `id-${String(++n)}`, now: () => new Date('2026-11-19T10:00:00.000Z') };
  return { deps, repository };
}

async function created(deps: ReturnType<typeof setup>['deps'], args: Record<string, unknown> = ARGS, op = OPAQUE_OP) {
  const out = await createChangeSet(deps, {
    operation: op,
    args,
    caller,
    correlationId: 'corr-1',
    configHash: 'cfg-1',
    expireAfterHours: 72,
  });
  if (!out.ok) throw new Error(`expected created, got ${out.code}`);
  return out.changeset;
}

function runRequest(changesetId: string, operation: OperationDefinition = OPAQUE_OP) {
  return { changesetId, operation, actor: 'alice', clientId: 'client-1', correlationId: 'corr-1' };
}

function expectedHash(args: Record<string, unknown>): string {
  // A new opaque preparation seals version 2 with no action (CS-4).
  const hasher = new ChangeSetHasher(OPAQUE_OP.id, args, { version: 2 });
  hasher.add({ targetId: 'call', status: 'pending', before: null, after: args });
  return hasher.digest();
}

describe('CS-1 CS-4 opaque preparation', () => {
  it('CS-1 CS-4 an opaque preparation stores one call item with before null and the stored arguments', async () => {
    const { deps, repository } = setup();
    const cs = await created(deps);
    const out = await runOpaquePreparation(deps, runRequest(cs.id));
    if (!out.ok) throw new Error(`expected prepared, got ${out.code}`);
    expect(out.changeset.status).toBe('prepared');
    expect(out.changeset.stats).toMatchObject({ total: 1, included: 1 });
    expect(out.changeset.preparedAt?.toISOString()).toBe('2026-11-19T10:00:00.000Z');
    // CS-4: sealed with version 2 and no action (an opaque change-set has no manifest).
    expect(out.changeset.hashVersion).toBe(2);
    expect(out.changeset.action).toBeUndefined();
    const items = [{ targetId: 'call', status: 'pending', before: null, after: ARGS }];
    expect(out.firstItems).toEqual(items);
    expect([...(repository.items.get(cs.id)?.values() ?? [])]).toEqual(items);
    expect(repository.audit.map((a) => [a.details.from, a.details.to])).toEqual([
      [null, 'preparing'],
      ['preparing', 'prepared'],
    ]);
    expect(repository.audit[1]?.details).toMatchObject({ included: 1, excluded: 0 });
    expect(repository.audit.every((a) => a.actor === 'alice' && a.clientId === 'client-1')).toBe(true);
  });

  it('CS-4 SEC-9 the hash binds the raw arguments', async () => {
    const { deps } = setup();
    const a = await runOpaquePreparation(deps, runRequest((await created(deps)).id));
    const b = await runOpaquePreparation(deps, runRequest((await created(deps)).id));
    const changed = { ...ARGS, reason: { ...ARGS.reason, note: 'asked once' } };
    const c = await runOpaquePreparation(deps, runRequest((await created(deps, changed)).id));
    if (!a.ok || !b.ok || !c.ok) throw new Error('expected prepared');
    expect(a.changeset.hash).toBe(expectedHash(ARGS));
    expect(b.changeset.hash).toBe(a.changeset.hash);
    expect(b.changeset.id).not.toBe(a.changeset.id);
    expect(c.changeset.hash).toBe(expectedHash(changed));
    expect(c.changeset.hash).not.toBe(a.changeset.hash);
  });

  it('NFR-2 a re-run after the item was stored completes with the same hash', async () => {
    const { deps, repository } = setup();
    const cs = await created(deps);
    // A crash after the append and before completion leaves the item stored and the row preparing (R5).
    await repository.appendItems(cs.id, [{ targetId: 'call', status: 'pending', before: null, after: ARGS }]);
    const out = await runOpaquePreparation(deps, runRequest(cs.id));
    if (!out.ok) throw new Error(`expected prepared, got ${out.code}`);
    expect(out.changeset.hash).toBe(expectedHash(ARGS));
    expect(out.changeset.stats).toMatchObject({ total: 1, included: 1 });
    expect(repository.items.get(cs.id)?.size).toBe(1);
  });

  it('NFR-2 a re-run on a prepared change-set returns it with its first items', async () => {
    const { deps, repository } = setup();
    const cs = await created(deps);
    const first = await runOpaquePreparation(deps, runRequest(cs.id));
    const again = await runOpaquePreparation(deps, runRequest(cs.id));
    if (!first.ok || !again.ok) throw new Error('expected prepared');
    expect(again.changeset.hash).toBe(first.changeset.hash);
    expect(again.firstItems).toEqual(first.firstItems);
    expect(repository.audit).toHaveLength(2);
  });

  it('CS-1 an unknown change-set answers not_found', async () => {
    const { deps } = setup();
    expect(await runOpaquePreparation(deps, runRequest('missing'))).toEqual({ ok: false, code: 'not_found' });
  });

  it.each(['cancelled', 'expired'] as const)('CS-6 a %s change-set answers cancelled and stores nothing', async (status) => {
    const { deps, repository } = setup();
    const cs = await created(deps);
    repository.sets.set(cs.id, { ...cs, status });
    expect(await runOpaquePreparation(deps, runRequest(cs.id))).toEqual({ ok: false, changesetId: cs.id, code: 'cancelled' });
    expect(repository.items.get(cs.id)?.size).toBe(0);
  });

  it('CS-1 a change-set in another state answers its error code, or internal', async () => {
    const { deps, repository } = setup();
    const failed = await created(deps);
    repository.sets.set(failed.id, { ...failed, status: 'failed', errorCode: 'operation_unavailable' });
    expect(await runOpaquePreparation(deps, runRequest(failed.id))).toEqual({
      ok: false,
      changesetId: failed.id,
      code: 'operation_unavailable',
    });
    const approved = await created(deps);
    repository.sets.set(approved.id, { ...approved, status: 'approved' });
    expect(await runOpaquePreparation(deps, runRequest(approved.id))).toEqual({
      ok: false,
      changesetId: approved.id,
      code: 'internal',
    });
  });

  it('CS-1 an operation that is not opaque marks the change-set failed with operation_unavailable', async () => {
    const { deps, repository } = setup();
    const cs = await created(deps);
    const out = await runOpaquePreparation(deps, runRequest(cs.id, { ...OPAQUE_OP, risk: 'write' }));
    expect(out).toEqual({ ok: false, changesetId: cs.id, code: 'operation_unavailable' });
    expect(repository.sets.get(cs.id)).toMatchObject({ status: 'failed', errorCode: 'operation_unavailable' });
    expect(repository.items.get(cs.id)?.size).toBe(0);
    expect(repository.audit[1]?.details).toMatchObject({ from: 'preparing', to: 'failed', errorCode: 'operation_unavailable' });
  });

  it('CS-6 a cancellation landing before the append is reported as cancelled and not overwritten', async () => {
    const { deps, repository } = setup();
    const cs = await created(deps);
    repository.onAppend = () => {
      const current = repository.sets.get(cs.id);
      if (current !== undefined) repository.sets.set(cs.id, { ...current, status: 'cancelled' });
    };
    expect(await runOpaquePreparation(deps, runRequest(cs.id))).toEqual({ ok: false, changesetId: cs.id, code: 'cancelled' });
    expect(repository.sets.get(cs.id)?.status).toBe('cancelled');
    expect(repository.audit).toHaveLength(1);
  });

  it('CS-6 a cancellation landing after the append is reported as cancelled and not overwritten', async () => {
    const { deps, repository } = setup();
    const cs = await created(deps);
    const append = repository.appendItems.bind(repository);
    repository.appendItems = async (id, items) => {
      const n = await append(id, items);
      const current = repository.sets.get(cs.id);
      if (current !== undefined) repository.sets.set(cs.id, { ...current, status: 'cancelled' });
      return n;
    };
    expect(await runOpaquePreparation(deps, runRequest(cs.id))).toEqual({ ok: false, changesetId: cs.id, code: 'cancelled' });
    expect(repository.sets.get(cs.id)?.status).toBe('cancelled');
  });

  it('CS-1 an append failing while still preparing marks the change-set failed with internal', async () => {
    const { deps, repository } = setup();
    const cs = await created(deps);
    repository.appendItems = () => Promise.reject(new Error('db down'));
    expect(await runOpaquePreparation(deps, runRequest(cs.id))).toEqual({ ok: false, changesetId: cs.id, code: 'internal' });
    expect(repository.sets.get(cs.id)).toMatchObject({ status: 'failed', errorCode: 'internal' });
  });

  it('CS-1 when marking failed throws too, the original error propagates', async () => {
    const { deps, repository } = setup();
    const cs = await created(deps);
    repository.appendItems = () => Promise.reject(new Error('db down'));
    repository.completePreparation = () => Promise.reject(new Error('db still down'));
    await expect(runOpaquePreparation(deps, runRequest(cs.id))).rejects.toThrow('db down');
  });
});

describe('CS-4 CS-10 opaque preparation with files', () => {
  const FILE_ID = '11111111-1111-4111-8111-111111111111';
  const sha = `sha256:${'b'.repeat(64)}`;
  const file: StagedFile = {
    id: FILE_ID,
    owner: 'alice',
    name: 'a.txt',
    mediaType: 'text/plain',
    size: 5,
    sha256: sha,
    preview: 'text',
    createdAt: new Date('2026-11-19T09:00:00.000Z'),
  };
  const entry: FileArgument = { pointer: '/doc', path: ['doc'], send: 'base64', mediaTypes: ['text/plain'], maxBytes: 100 };
  const FILE_OP: OperationDefinition = { ...OPAQUE_OP, files: [entry] };
  const descriptor = { $file: { id: FILE_ID, name: 'a.txt', media_type: 'text/plain', size: 5, sha256: sha } };

  it('CS-4 CS-10 a change-set with files is sealed with hash version 3 over the descriptor', async () => {
    const { deps, repository } = setup();
    const out = await createChangeSet(
      { ...deps, files: { get: () => Promise.resolve(file) } },
      { operation: FILE_OP, args: { order: '1', doc: FILE_ID }, caller, correlationId: 'corr-1', configHash: 'cfg-1', expireAfterHours: 72 },
    );
    if (!out.ok) throw new Error(`expected created, got ${out.code}`);
    const prepared = await runOpaquePreparation(deps, runRequest(out.changeset.id, FILE_OP));
    if (!prepared.ok) throw new Error(`expected prepared, got ${prepared.code}`);
    expect(prepared.changeset.hashVersion).toBe(3);
    expect(prepared.changeset.action).toBeUndefined();
    expect(prepared.firstItems).toEqual([
      { targetId: 'call', status: 'pending', before: null, after: { order: '1', doc: descriptor } },
    ]);
    expect(prepared.changeset.hash).toBe(await hashStoredItems(repository, prepared.changeset));
    const hasher = new ChangeSetHasher(FILE_OP.id, { order: '1', doc: descriptor }, { version: 3 });
    hasher.add({ targetId: 'call', status: 'pending', before: null, after: { order: '1', doc: descriptor } });
    expect(prepared.changeset.hash).toBe(hasher.digest());
  });

  it('CS-4 an opaque change-set without files still seals version 2 with the same hash', async () => {
    const { deps } = setup();
    const cs = await created(deps);
    const out = await runOpaquePreparation(deps, runRequest(cs.id));
    if (!out.ok) throw new Error(`expected prepared, got ${out.code}`);
    expect(out.changeset.hashVersion).toBe(2);
    expect(out.changeset.hash).toBe(expectedHash(ARGS));
  });
});
