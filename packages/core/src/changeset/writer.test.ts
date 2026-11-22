// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Mandate Authors
import { describe, expect, it } from 'vitest';
import type { ManifestDefinition, OperationDefinition } from '../policy-model.js';
import type { ChangeItemRecord, ChangeSetRecord } from './model.js';
import { BatchFenced, type BatchContext, type BatchSubmission, type ReadPage, type UpstreamReader } from './ports.js';
import {
  type BulkItemState,
  type BulkWriter,
  type Clock,
  type DirectRecordState,
  type DirectWriter,
  ManifestBatchWriter,
  POLL_GIVE_UP_MS,
  RetryableWriteError,
  UnsupportedWriter,
  type WriteDirection,
  type WriteOutcomeCode,
} from './writer.js';

// ---- Shared fakes: every port writes into one ordered `events` log. ----

type SubmitResult = Awaited<ReturnType<BulkWriter['submit']>>;
type StatusResult = Awaited<ReturnType<BulkWriter['status']>>;

class FakeReader implements UpstreamReader {
  readonly calls: { operationId: string; args: Readonly<Record<string, unknown>> }[] = [];
  /** One answer per call; the last one repeats. */
  pages: (ReadPage | ((args: Readonly<Record<string, unknown>>) => ReadPage))[] = [];
  constructor(private readonly events: string[]) {}
  read(operationId: string, args: Readonly<Record<string, unknown>>): Promise<ReadPage> {
    this.events.push('read');
    this.calls.push({ operationId, args });
    const next = this.pages.length > 1 ? this.pages.shift() : this.pages[0];
    if (next === undefined) return Promise.resolve({ ok: true, items: [], truncated: false });
    return Promise.resolve(typeof next === 'function' ? next(args) : next);
  }
}

class FakeBulk implements BulkWriter {
  readonly submitted: Readonly<Record<string, unknown>>[][] = [];
  readonly statusCalls: string[] = [];
  readonly statusKeys: (readonly string[])[] = [];
  submits: SubmitResult[] = [{ ok: true, batchId: 'u-1' }];
  statuses: StatusResult[] = [{ ok: true, items: [{ index: 0, state: 'ok' }] }];
  constructor(private readonly events: string[]) {}
  submit(records: readonly Readonly<Record<string, unknown>>[]): Promise<SubmitResult> {
    this.events.push('submit');
    this.submitted.push([...records]);
    const next = this.submits.length > 1 ? this.submits.shift() : this.submits[0];
    if (next === undefined) throw new Error('FakeBulk: no submit answer');
    return Promise.resolve(next);
  }
  status(batchId: string, keys: readonly string[]): Promise<StatusResult> {
    this.events.push('status');
    this.statusCalls.push(batchId);
    this.statusKeys.push([...keys]);
    const next = this.statuses.length > 1 ? this.statuses.shift() : this.statuses[0];
    if (next === undefined) throw new Error('FakeBulk: no status answer');
    return Promise.resolve(next);
  }
}

class FakeClock implements Clock {
  readonly sleeps: number[] = [];
  private t = 0;
  constructor(private readonly events: string[]) {}
  now(): number {
    return this.t;
  }
  sleep(ms: number): Promise<void> {
    this.events.push('sleep');
    this.sleeps.push(ms);
    this.t += ms;
    return Promise.resolve();
  }
}

class FakeBatch implements BatchContext {
  readonly key = 'cs-1:1';
  submission?: BatchSubmission;
  readonly recorded: BatchSubmission[] = [];
  heartbeats = 0;
  constructor(private readonly events: string[]) {}
  recordSubmission(s: BatchSubmission): Promise<void> {
    this.events.push('record');
    this.recorded.push(s);
    this.submission = s;
    return Promise.resolve();
  }
  heartbeat(): void {
    this.events.push('heartbeat');
    this.heartbeats++;
  }
}

// ---- Fixtures ----

const manifest: ManifestDefinition = {
  idField: 'sku',
  idsArg: 'skus',
  valuesArg: 'changes',
  fields: ['name', 'description'],
  requiredFields: [],
  scopeArgs: { brand: 'brand' },
  readBefore: { operation: 'catalog.get_products_by_sku', args: { brand: { arg: 'brand' } }, idsArg: 'skus' },
  write: { carryFields: ['status'] },
  batchSize: 100,
  maxTargets: 1000,
  rollback: { strategy: 'replay_previous_state' },
};

const operation: OperationDefinition & { manifest: ManifestDefinition } = {
  id: 'catalog.update_content',
  toolName: 'catalog_update_content',
  source: 'config',
  connection: 'magento',
  risk: 'write',
  description: 'Update content',
  inputSchema: { type: 'object' },
  fieldsArg: 'changes',
  manifest,
};

function changesetFor(skus: readonly string[]): ChangeSetRecord {
  return {
    id: 'cs-1',
    operation: operation.id,
    connection: 'magento',
    requester: 'alice',
    args: { brand: 'acme', skus: [...skus], changes: { description: 'new' } },
    hash: 'h-1',
    status: 'executing',
    stats: { total: 0, included: 0, excluded: {}, written: 0, failed: 0, skipped: 0 },
    configHash: 'cfg-1',
    correlationId: 'corr-1',
    createdAt: new Date('2026-11-17T10:00:00.000Z'),
    expiresAt: new Date('2026-11-20T10:00:00.000Z'),
    approvalRound: 0,
  };
}

function item(targetId: string): ChangeItemRecord {
  return { targetId, status: 'pending', before: { description: 'old' }, after: { description: 'new' } };
}

function product(sku: string, description: unknown, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return { sku, brand: 'acme', description, ...extra };
}

function page(...items: Record<string, unknown>[]): ReadPage {
  return { ok: true, items, truncated: false };
}

const FIXED_CODES: readonly WriteOutcomeCode[] = [
  'already_applied',
  'drift',
  'gone',
  'upstream_rejected',
  'upstream_failed',
  'upstream_retriable',
  'no_outcome',
  'write_mode_unsupported',
];

function setup(op: OperationDefinition & { manifest: ManifestDefinition } = operation, direction?: WriteDirection) {
  const events: string[] = [];
  const reader = new FakeReader(events);
  const bulk = new FakeBulk(events);
  const clock = new FakeClock(events);
  const batch = new FakeBatch(events);
  const writer = new ManifestBatchWriter({
    operation: op,
    readFieldsArg: 'fields',
    readerFor: () => reader,
    bulkFor: () => bulk,
    clock,
    ...(direction === undefined ? {} : { direction }),
  });
  return { events, reader, bulk, clock, batch, writer };
}

const OPEN: StatusResult = { ok: true, items: [{ index: 0, state: 'open' }] };
const states = (...s: BulkItemState[]): StatusResult => ({ ok: true, items: s.map((state, index) => ({ index, state })) });

describe('EXE-4 CS-7 NFR-2 manifest batch writer', () => {
  it('EXE-4 reads once, submits the to-write items with carry fields, records the submission with the plan before polling, then verifies', async () => {
    const { events, reader, bulk, batch, writer } = setup();
    reader.pages = [
      page(product('A', 'old', { status: 2 }), product('B', 'new'), product('C', 'other')),
      page(product('A', 'new', { status: 2 })),
    ];
    bulk.statuses = [OPEN, { ok: true, items: [{ index: 0, state: 'ok' }] }];
    const [A, B, C, D] = ['A', 'B', 'C', 'D'].map(item) as [ChangeItemRecord, ChangeItemRecord, ChangeItemRecord, ChangeItemRecord];
    const outcomes = await writer.writeBatch({ changeset: changesetFor(['A', 'B', 'C', 'D']), items: [A, B, C, D], batch });
    expect(bulk.submitted).toEqual([[{ sku: 'A', status: 2, description: 'new' }]]);
    expect(batch.recorded).toEqual([
      {
        upstreamBatchId: 'u-1',
        plan: [
          { targetId: 'A', action: 'write' },
          { targetId: 'B', action: 'outcome', status: 'written', error: 'already_applied' },
          { targetId: 'C', action: 'outcome', status: 'skipped', error: 'drift' },
          { targetId: 'D', action: 'outcome', status: 'skipped', error: 'gone' },
        ],
      },
    ]);
    expect(events.indexOf('record')).toBeLessThan(events.indexOf('status'));
    expect(events.filter((e) => e === 'read')).toHaveLength(2);
    expect(reader.calls[0]?.operationId).toBe('catalog.get_products_by_sku');
    expect(reader.calls[0]?.args).toMatchObject({
      brand: 'acme',
      skus: ['A', 'B', 'C', 'D'],
      fields: ['sku', 'description', 'brand', 'status'],
    });
    expect(reader.calls[1]?.args).toMatchObject({ brand: 'acme', skus: ['A'], fields: ['sku', 'description'] });
    expect(outcomes).toEqual([
      { targetId: 'A', status: 'written' },
      { targetId: 'B', status: 'written', error: 'already_applied' },
      { targetId: 'C', status: 'skipped', error: 'drift' },
      { targetId: 'D', status: 'skipped', error: 'gone' },
    ]);
  });

  it('NFR-2 a batch with nothing to write neither submits nor records (Review Focus 3)', async () => {
    const { events, reader, bulk, batch, writer } = setup();
    reader.pages = [page(product('A', 'new'), product('B', 'other'))];
    const outcomes = await writer.writeBatch({ changeset: changesetFor(['A', 'B']), items: [item('A'), item('B')], batch });
    expect(bulk.submitted).toEqual([]);
    expect(batch.recorded).toEqual([]);
    expect(events).toEqual(['read']);
    expect(outcomes).toEqual([
      { targetId: 'A', status: 'written', error: 'already_applied' },
      { targetId: 'B', status: 'skipped', error: 'drift' },
    ]);
  });

  it('EXE-5 maps item states by index from a shuffled status: failed → upstream_failed, retriable → upstream_retriable, absent → no_outcome', async () => {
    const { reader, bulk, batch, writer } = setup();
    const ids = ['A', 'B', 'C', 'D'];
    reader.pages = [page(...ids.map((s) => product(s, 'old'))), page(product('B', 'new'))];
    bulk.statuses = [
      {
        ok: true,
        items: [
          { index: 2, state: 'retriable' },
          { index: 1, state: 'ok' },
          { index: 0, state: 'failed' },
        ],
      },
    ];
    const outcomes = await writer.writeBatch({ changeset: changesetFor(ids), items: ids.map(item), batch });
    expect(reader.calls[1]?.args).toMatchObject({ skus: ['B'] });
    expect(outcomes).toEqual([
      { targetId: 'A', status: 'failed', error: 'upstream_failed' },
      { targetId: 'B', status: 'written' },
      { targetId: 'C', status: 'failed', error: 'upstream_retriable' },
      { targetId: 'D', status: 'failed', error: 'no_outcome' },
    ]);
  });

  it('EXE-5 a duplicated index takes the worst state (failed > retriable > open > ok) and an out-of-range index is ignored (Review Focus 1)', async () => {
    const { reader, bulk, batch, writer } = setup();
    const ids = ['A', 'B', 'C'];
    reader.pages = [page(...ids.map((s) => product(s, 'old'))), page(...ids.map((s) => product(s, 'new')))];
    bulk.statuses = [
      // B: ok then open means still open, so one more round.
      {
        ok: true,
        items: [
          { index: 0, state: 'ok' },
          { index: 0, state: 'failed' },
          { index: 1, state: 'ok' },
          { index: 1, state: 'open' },
          { index: 2, state: 'ok' },
        ],
      },
      {
        ok: true,
        items: [
          { index: 0, state: 'ok' },
          { index: 0, state: 'failed' },
          { index: 1, state: 'retriable' },
          { index: 1, state: 'ok' },
          { index: 2, state: 'ok' },
          { index: 3, state: 'failed' },
          { index: 99, state: 'open' },
        ],
      },
    ];
    const outcomes = await writer.writeBatch({ changeset: changesetFor(ids), items: ids.map(item), batch });
    expect(bulk.statusCalls).toEqual(['u-1', 'u-1']);
    expect(outcomes).toEqual([
      { targetId: 'A', status: 'failed', error: 'upstream_failed' },
      { targetId: 'B', status: 'failed', error: 'upstream_retriable' },
      { targetId: 'C', status: 'written' },
    ]);
  });

  it('CS-7 the verify read turns a value changed after the upstream applied it into drift', async () => {
    const { reader, batch, writer } = setup();
    reader.pages = [page(product('A', 'old')), page(product('A', 'edited'))];
    const outcomes = await writer.writeBatch({ changeset: changesetFor(['A']), items: [item('A')], batch });
    expect(outcomes).toEqual([{ targetId: 'A', status: 'skipped', error: 'drift' }]);
  });

  it('CS-7 an ok item missing from the verify read is skipped as gone (F20)', async () => {
    const { reader, bulk, batch, writer } = setup();
    reader.pages = [page(product('A', 'old'), product('B', 'old')), page(product('A', 'new'))];
    bulk.statuses = [states('ok', 'ok')];
    const outcomes = await writer.writeBatch({ changeset: changesetFor(['A', 'B']), items: [item('A'), item('B')], batch });
    expect(outcomes).toEqual([
      { targetId: 'A', status: 'written' },
      { targetId: 'B', status: 'skipped', error: 'gone' },
    ]);
  });

  it('EXE-4 a failed or truncated verify read throws a retryable error after the submission was recorded', async () => {
    const failed = setup();
    failed.reader.pages = [page(product('A', 'old')), { ok: false, code: 'network' }];
    await expect(
      failed.writer.writeBatch({ changeset: changesetFor(['A']), items: [item('A')], batch: failed.batch }),
    ).rejects.toMatchObject({ name: 'RetryableWriteError', code: 'read_failed' });
    expect(failed.batch.recorded).toHaveLength(1);

    const truncated = setup();
    truncated.reader.pages = [page(product('A', 'old')), { ok: true, items: [], truncated: true }];
    await expect(
      truncated.writer.writeBatch({ changeset: changesetFor(['A']), items: [item('A')], batch: truncated.batch }),
    ).rejects.toMatchObject({ name: 'RetryableWriteError', code: 'incomplete_read' });
  });

  it('EXE-5 a rejected submit fails every to-write item with upstream_rejected and records nothing', async () => {
    const { events, reader, bulk, batch, writer } = setup();
    reader.pages = [page(product('A', 'old'), product('B', 'new'), product('C', 'old'))];
    bulk.submits = [{ ok: false, code: 'rejected', retriable: false }];
    const outcomes = await writer.writeBatch({
      changeset: changesetFor(['A', 'B', 'C']),
      items: [item('A'), item('B'), item('C')],
      batch,
    });
    expect(batch.recorded).toEqual([]);
    expect(events).not.toContain('status');
    expect(outcomes).toEqual([
      { targetId: 'A', status: 'failed', error: 'upstream_rejected' },
      { targetId: 'B', status: 'written', error: 'already_applied' },
      { targetId: 'C', status: 'failed', error: 'upstream_rejected' },
    ]);
  });

  it('EXE-4 a retriable submit failure throws RetryableWriteError(submit_failed) and records nothing', async () => {
    const { reader, bulk, batch, writer } = setup();
    reader.pages = [page(product('A', 'old'))];
    bulk.submits = [{ ok: false, code: 'busy', retriable: true }];
    const run = writer.writeBatch({ changeset: changesetFor(['A']), items: [item('A')], batch });
    await expect(run).rejects.toBeInstanceOf(RetryableWriteError);
    await expect(run).rejects.toMatchObject({
      name: 'RetryableWriteError',
      code: 'submit_failed',
      message: 'batch write interrupted: submit_failed',
    });
    expect(batch.recorded).toEqual([]);
  });

  it('EXE-4 an invalid_response submit (accepted, batch ID unusable) fails every to-write item no_outcome and never resubmits', async () => {
    const { events, reader, bulk, batch, writer } = setup();
    reader.pages = [page(product('A', 'old'), product('B', 'new'), product('C', 'old'))];
    bulk.submits = [{ ok: false, code: 'invalid_response', retriable: false }];
    const outcomes = await writer.writeBatch({
      changeset: changesetFor(['A', 'B', 'C']),
      items: [item('A'), item('B'), item('C')],
      batch,
    });
    expect(bulk.submitted).toHaveLength(1);
    expect(batch.recorded).toEqual([]);
    expect(events).not.toContain('status');
    expect(outcomes).toEqual([
      { targetId: 'A', status: 'failed', error: 'no_outcome' },
      { targetId: 'B', status: 'written', error: 'already_applied' },
      { targetId: 'C', status: 'failed', error: 'no_outcome' },
    ]);
  });

  it.each(['mapping', 'egress_denied', 'credential_missing', 'credential_unusable', 'http_status'])(
    'EXE-4 a non-retriable %s submit failure fails every to-write item upstream_rejected without resubmitting',
    async (code) => {
      const { events, reader, bulk, batch, writer } = setup();
      reader.pages = [page(product('A', 'old'), product('B', 'new'))];
      bulk.submits = [{ ok: false, code, retriable: false }];
      const outcomes = await writer.writeBatch({ changeset: changesetFor(['A', 'B']), items: [item('A'), item('B')], batch });
      expect(bulk.submitted).toHaveLength(1);
      expect(batch.recorded).toEqual([]);
      expect(events).not.toContain('status');
      expect(outcomes).toEqual([
        { targetId: 'A', status: 'failed', error: 'upstream_rejected' },
        { targetId: 'B', status: 'written', error: 'already_applied' },
      ]);
    },
  );

  it('EXE-4 NFR-2 a retry after a timed-out submit re-reads: items the upstream applied are already_applied, the rest is submitted again', async () => {
    const { reader, bulk, batch, writer } = setup();
    const ids = ['A', 'B'];
    // First attempt: the submit timed out, but the upstream applied A before the retry.
    reader.pages = [
      page(product('A', 'old'), product('B', 'old')),
      page(product('A', 'new'), product('B', 'old')),
      page(product('B', 'new')),
    ];
    bulk.submits = [{ ok: false, code: 'timeout', retriable: true }, { ok: true, batchId: 'u-2' }];
    await expect(writer.writeBatch({ changeset: changesetFor(ids), items: ids.map(item), batch })).rejects.toMatchObject({
      code: 'submit_failed',
    });
    expect(batch.submission).toBeUndefined();
    const outcomes = await writer.writeBatch({ changeset: changesetFor(ids), items: ids.map(item), batch });
    expect(reader.calls.map((c) => c.args.skus)).toEqual([ids, ids, ['B']]);
    expect(bulk.submitted).toEqual([
      [
        { sku: 'A', description: 'new' },
        { sku: 'B', description: 'new' },
      ],
      [{ sku: 'B', description: 'new' }],
    ]);
    expect(batch.recorded).toEqual([
      {
        upstreamBatchId: 'u-2',
        plan: [
          { targetId: 'A', action: 'outcome', status: 'written', error: 'already_applied' },
          { targetId: 'B', action: 'write' },
        ],
      },
    ]);
    expect(outcomes).toEqual([
      { targetId: 'A', status: 'written', error: 'already_applied' },
      { targetId: 'B', status: 'written' },
    ]);
  });

  it('EXE-4 a failed pre-write read throws read_failed before any submit; a truncated read throws incomplete_read', async () => {
    const failed = setup();
    failed.reader.pages = [{ ok: false, code: 'http_status', status: 500 }];
    await expect(
      failed.writer.writeBatch({ changeset: changesetFor(['A']), items: [item('A')], batch: failed.batch }),
    ).rejects.toMatchObject({ name: 'RetryableWriteError', code: 'read_failed', message: 'batch write interrupted: read_failed' });
    expect(failed.bulk.submitted).toEqual([]);

    const truncated = setup();
    truncated.reader.pages = [{ ok: true, items: [product('A', 'old')], truncated: true }];
    await expect(
      truncated.writer.writeBatch({ changeset: changesetFor(['A']), items: [item('A')], batch: truncated.batch }),
    ).rejects.toMatchObject({ name: 'RetryableWriteError', code: 'incomplete_read' });
    expect(truncated.bulk.submitted).toEqual([]);
  });

  it('EXE-4 a fenced recordSubmission propagates as BatchFenced and polls nothing', async () => {
    const { reader, bulk, batch, writer } = setup();
    reader.pages = [page(product('A', 'old'))];
    batch.recordSubmission = () => Promise.reject(new BatchFenced());
    await expect(writer.writeBatch({ changeset: changesetFor(['A']), items: [item('A')], batch })).rejects.toBeInstanceOf(
      BatchFenced,
    );
    expect(bulk.statusCalls).toEqual([]);
    expect(batch.heartbeats).toBe(0);
    expect(batch.submission).toBeUndefined();
  });

  it('OPS-6 a carry field missing from the current record is not sent', async () => {
    const { reader, bulk, batch, writer } = setup();
    reader.pages = [page(product('A', 'old'), product('B', 'old', { status: 1 })), page(product('A', 'new'), product('B', 'new'))];
    bulk.statuses = [states('ok', 'ok')];
    await writer.writeBatch({ changeset: changesetFor(['A', 'B']), items: [item('A'), item('B')], batch });
    expect(bulk.submitted).toEqual([
      [
        { sku: 'A', description: 'new' },
        { sku: 'B', status: 1, description: 'new' },
      ],
    ]);
  });

  it('CS-7 a current value canonical JSON cannot compare is drift, not a thrown batch', async () => {
    const { reader, bulk, batch, writer } = setup();
    reader.pages = [page(product('A', Number.NaN), product('B', 'old')), page(product('B', new Date(0)))];
    bulk.statuses = [states('ok')];
    const outcomes = await writer.writeBatch({ changeset: changesetFor(['A', 'B']), items: [item('A'), item('B')], batch });
    expect(bulk.submitted).toEqual([[{ sku: 'B', description: 'new' }]]);
    expect(outcomes).toEqual([
      { targetId: 'A', status: 'skipped', error: 'drift' },
      { targetId: 'B', status: 'skipped', error: 'drift' },
    ]);
  });

  it('CS-7 a change-set that touches no field fails every item with a fixed code instead of already_applied', async () => {
    const { events, batch, writer } = setup();
    const cs = { ...changesetFor(['A']), args: { brand: 'acme', skus: ['A'], changes: { unknown_field: 'x' } } };
    const outcomes = await writer.writeBatch({ changeset: cs, items: [item('A')], batch });
    expect(events).toEqual([]);
    expect(outcomes).toEqual([{ targetId: 'A', status: 'failed', error: 'write_mode_unsupported' }]);
  });

  describe('CS-2 per-record values', () => {
    const recordsManifest: ManifestDefinition = {
      idField: 'sku',
      recordsArg: 'records',
      fields: ['name', 'price'],
      requiredFields: [],
      scopeArgs: { brand: 'brand' },
      readBefore: { operation: 'catalog.get_products_by_sku', args: { brand: { arg: 'brand' } }, idsArg: 'skus' },
      write: { carryFields: ['status'] },
      batchSize: 100,
      maxTargets: 1000,
      rollback: { strategy: 'replay_previous_state' },
    };
    const recordsOperation = { ...operation, fieldsArg: 'records', manifest: recordsManifest };
    const recordsChangeset: ChangeSetRecord = {
      ...changesetFor([]),
      args: {
        brand: 'acme',
        records: [
          { sku: 'a2', name: 'A2' },
          { sku: 'b', price: 2 },
        ],
      },
    };
    const a2: ChangeItemRecord = { targetId: 'a2', status: 'pending', before: { name: 'A1' }, after: { name: 'A2' } };
    const b: ChangeItemRecord = { targetId: 'b', status: 'pending', before: { price: 1 }, after: { price: 2 } };

    it('CS-2 CS-7 each record carries only its own fields and is verified over them', async () => {
      const { reader, bulk, batch, writer } = setup(recordsOperation);
      reader.pages = [
        page({ sku: 'a2', brand: 'acme', name: 'A1', price: 9 }, { sku: 'b', brand: 'acme', name: 'other', price: 1 }),
        page({ sku: 'a2', brand: 'acme', name: 'A2', price: 9 }, { sku: 'b', brand: 'acme', name: 'changed', price: 2 }),
      ];
      bulk.statuses = [states('ok', 'ok')];
      const outcomes = await writer.writeBatch({ changeset: recordsChangeset, items: [a2, b], batch });
      expect(bulk.submitted).toEqual([
        [
          { sku: 'a2', name: 'A2' },
          { sku: 'b', price: 2 },
        ],
      ]);
      expect(reader.calls[0]?.args).toMatchObject({ skus: ['a2', 'b'], fields: ['sku', 'name', 'price', 'brand', 'status'] });
      expect(reader.calls[1]?.args).toMatchObject({ skus: ['a2', 'b'], fields: ['sku', 'name', 'price'] });
      expect(outcomes).toEqual([
        { targetId: 'a2', status: 'written' },
        { targetId: 'b', status: 'written' },
      ]);
    });

    it('CS-7 an item whose sides hold no manifest field fails write_mode_unsupported; the others are written', async () => {
      const { reader, bulk, batch, writer } = setup(recordsOperation);
      const none: ChangeItemRecord = { targetId: 'c', status: 'pending', before: { other: 1 }, after: { other: 2 } };
      reader.pages = [
        page({ sku: 'b', brand: 'acme', price: 1 }, { sku: 'c', brand: 'acme', other: 1 }),
        page({ sku: 'b', brand: 'acme', price: 2 }),
      ];
      bulk.statuses = [states('ok')];
      const outcomes = await writer.writeBatch({ changeset: recordsChangeset, items: [none, b], batch });
      expect(bulk.submitted).toEqual([[{ sku: 'b', price: 2 }]]);
      expect(reader.calls[0]?.args).toMatchObject({ skus: ['b'] });
      expect(outcomes).toEqual([
        { targetId: 'c', status: 'failed', error: 'write_mode_unsupported' },
        { targetId: 'b', status: 'written' },
      ]);
    });

    it('EXE-4 CS-2 resume polls the recorded submission without reading, maps states by plan index and verifies each item over its own fields', async () => {
      const plan = [
        { targetId: 'a2', action: 'write' },
        { targetId: 'c', action: 'outcome', status: 'skipped', error: 'drift' },
        { targetId: 'b', action: 'write' },
      ] as const;
      const c: ChangeItemRecord = { targetId: 'c', status: 'pending', before: { name: 'C1' }, after: { name: 'C2' } };

      const { events, reader, bulk, batch, writer } = setup(recordsOperation);
      batch.submission = { upstreamBatchId: 'u-7', plan: [...plan] };
      // Each item reads back its own `after`; the field the other record touches holds anything.
      reader.pages = [page({ sku: 'a2', brand: 'acme', name: 'A2', price: 9 }, { sku: 'b', brand: 'acme', name: 'changed', price: 2 })];
      bulk.statuses = [{ ok: true, items: [{ index: 1, state: 'ok' }, { index: 0, state: 'ok' }] }];
      const outcomes = await writer.writeBatch({ changeset: recordsChangeset, items: [a2, c, b], batch });
      expect(bulk.submitted).toEqual([]);
      expect(batch.recorded).toEqual([]);
      expect(bulk.statusKeys).toEqual([['a2', 'b']]);
      expect(events.indexOf('read')).toBeGreaterThan(events.indexOf('status'));
      expect(reader.calls).toHaveLength(1);
      expect(reader.calls[0]?.args).toMatchObject({ skus: ['a2', 'b'], fields: ['sku', 'name', 'price'] });
      expect(outcomes).toEqual([
        { targetId: 'a2', status: 'written' },
        { targetId: 'c', status: 'skipped', error: 'drift' },
        { targetId: 'b', status: 'written' },
      ]);

      // Index 0 is a2 and index 1 is b: a2 failed, b is verified alone and over `price` only.
      const second = setup(recordsOperation);
      second.batch.submission = { upstreamBatchId: 'u-8', plan: [...plan] };
      second.reader.pages = [page({ sku: 'b', brand: 'acme', name: 'changed', price: 3 })];
      second.bulk.statuses = [{ ok: true, items: [{ index: 1, state: 'ok' }, { index: 0, state: 'failed' }] }];
      const again = await second.writer.writeBatch({ changeset: recordsChangeset, items: [a2, c, b], batch: second.batch });
      expect(second.reader.calls[0]?.args).toMatchObject({ skus: ['b'], fields: ['sku', 'price'] });
      expect(again).toEqual([
        { targetId: 'a2', status: 'failed', error: 'upstream_failed' },
        { targetId: 'c', status: 'skipped', error: 'drift' },
        { targetId: 'b', status: 'skipped', error: 'drift' },
      ]);
    });

    it('EXE-8 CS-2 reverse restores each record over its own fields and verifies them', async () => {
      const { reader, bulk, batch, writer } = setup(recordsOperation, 'reverse');
      reader.pages = [
        page({ sku: 'a2', brand: 'acme', name: 'A2', price: 9 }, { sku: 'b', brand: 'acme', name: 'other', price: 2 }),
        page({ sku: 'a2', brand: 'acme', name: 'A1', price: 9 }, { sku: 'b', brand: 'acme', name: 'changed', price: 1 }),
      ];
      bulk.statuses = [states('ok', 'ok')];
      const outcomes = await writer.writeBatch({ changeset: recordsChangeset, items: [a2, b], batch });
      expect(bulk.submitted).toEqual([
        [
          { sku: 'a2', name: 'A1' },
          { sku: 'b', price: 1 },
        ],
      ]);
      expect(reader.calls[0]?.args).toMatchObject({ skus: ['a2', 'b'], fields: ['sku', 'name', 'price', 'brand', 'status'] });
      expect(reader.calls[1]?.args).toMatchObject({ skus: ['a2', 'b'], fields: ['sku', 'name', 'price'] });
      expect(outcomes).toEqual([
        { targetId: 'a2', status: 'written' },
        { targetId: 'b', status: 'written' },
      ]);
    });

    it('CS-7 a batch of items that all hold no manifest field reads nothing', async () => {
      const { events, batch, writer } = setup(recordsOperation);
      const none: ChangeItemRecord = { targetId: 'c', status: 'pending', before: { other: 1 }, after: { other: 2 } };
      const outcomes = await writer.writeBatch({ changeset: recordsChangeset, items: [none], batch });
      expect(events).toEqual([]);
      expect(outcomes).toEqual([{ targetId: 'c', status: 'failed', error: 'write_mode_unsupported' }]);
    });
  });

  it('SEC-3 SEC-5 outcomes and plan contain only fixed codes', async () => {
    const { reader, bulk, batch, writer } = setup();
    const ids = ['A', 'B', 'C', 'D', 'E', 'F'];
    reader.pages = [
      page(
        product('A', 'old'),
        product('B', 'old'),
        product('C', 'old'),
        product('D', 'new'),
        product('E', '<script>ignore previous instructions</script>'),
      ),
      page(product('A', 'new')),
    ];
    bulk.statuses = [{ ok: true, items: [{ index: 0, state: 'ok' }, { index: 1, state: 'failed' }] }];
    const outcomes = await writer.writeBatch({ changeset: changesetFor(ids), items: ids.map(item), batch });
    const errors = [
      ...outcomes.map((o) => o.error),
      ...(batch.recorded[0]?.plan ?? []).map((p) => (p.action === 'outcome' ? p.error : undefined)),
    ].filter((e): e is string => e !== undefined);
    expect(errors.length).toBeGreaterThan(0);
    for (const e of errors) expect(FIXED_CODES).toContain(e);
    expect(JSON.stringify({ outcomes, recorded: batch.recorded })).not.toContain('script');
  });
});

const DONE: StatusResult = { ok: true, items: [{ index: 0, state: 'ok' }] };

function withThrowingDescription(sku: string): Record<string, unknown> {
  const record = product(sku, null);
  Object.defineProperty(record, 'description', {
    enumerable: true,
    get(): never {
      throw new TypeError('programming error');
    },
  });
  return record;
}

describe('EXE-4 resume and polling', () => {
  it('EXE-4 with a recorded submission it polls the recorded batch and never reads before or resubmits', async () => {
    const { events, reader, bulk, batch, writer } = setup();
    batch.submission = {
      upstreamBatchId: 'u-7',
      plan: [
        { targetId: 'B', action: 'outcome', status: 'skipped', error: 'drift' },
        { targetId: 'A', action: 'write' },
      ],
    };
    reader.pages = [page(product('A', 'new'))];
    bulk.statuses = [DONE];
    const outcomes = await writer.writeBatch({ changeset: changesetFor(['A', 'B']), items: [item('A'), item('B')], batch });
    expect(bulk.submitted).toEqual([]);
    expect(batch.recorded).toEqual([]);
    expect(bulk.statusCalls).toEqual(['u-7']);
    // The verify read only, of the one submitted item, after the poll.
    expect(reader.calls).toHaveLength(1);
    expect(reader.calls[0]?.args).toMatchObject({ skus: ['A'] });
    expect(events.indexOf('read')).toBeGreaterThan(events.indexOf('status'));
    expect(outcomes).toEqual([
      { targetId: 'B', status: 'skipped', error: 'drift' },
      { targetId: 'A', status: 'written' },
    ]);
  });

  it('EXE-4 NFR-2 a verify read that failed after recordSubmission is retried without a second submit: outcomes from the stored plan and polling', async () => {
    const { reader, bulk, batch, writer } = setup();
    const ids = ['A', 'B'];
    reader.pages = [page(product('A', 'old'), product('B', 'new')), { ok: false, code: 'network' }, page(product('A', 'new'))];
    bulk.statuses = [DONE];
    await expect(writer.writeBatch({ changeset: changesetFor(ids), items: ids.map(item), batch })).rejects.toMatchObject({
      name: 'RetryableWriteError',
      code: 'read_failed',
    });
    expect(batch.submission).toEqual({
      upstreamBatchId: 'u-1',
      plan: [
        { targetId: 'A', action: 'write' },
        { targetId: 'B', action: 'outcome', status: 'written', error: 'already_applied' },
      ],
    });
    const outcomes = await writer.writeBatch({ changeset: changesetFor(ids), items: ids.map(item), batch });
    expect(bulk.submitted).toHaveLength(1);
    expect(batch.recorded).toHaveLength(1);
    expect(bulk.statusCalls).toEqual(['u-1', 'u-1']);
    expect(reader.calls.map((c) => c.args.skus)).toEqual([ids, ['A'], ['A']]);
    expect(outcomes).toEqual([
      { targetId: 'A', status: 'written' },
      { targetId: 'B', status: 'written', error: 'already_applied' },
    ]);
  });

  it('EXE-4 polling waits 1000, 1500, 2250, 3375, 5000, 5000, 5000 ms and heartbeats once every round', async () => {
    const { events, reader, bulk, clock, batch, writer } = setup();
    reader.pages = [page(product('A', 'old')), page(product('A', 'new'))];
    bulk.statuses = [...Array<StatusResult>(6).fill(OPEN), DONE];
    await writer.writeBatch({ changeset: changesetFor(['A']), items: [item('A')], batch });
    expect(clock.sleeps).toEqual([1000, 1500, 2250, 3375, 5000, 5000, 5000]);
    expect(bulk.statusCalls).toHaveLength(7);
    expect(batch.heartbeats).toBe(7);
    const polling = events.filter((e) => e === 'heartbeat' || e === 'sleep' || e === 'status');
    expect(polling).toEqual(Array.from({ length: 7 }, () => ['heartbeat', 'sleep', 'status']).flat());
  });

  it('EXE-4 still open after 10 minutes throws poll_timeout (retryable); a retry with the recorded submission resumes polling', async () => {
    const { reader, bulk, clock, batch, writer } = setup();
    reader.pages = [page(product('A', 'old')), page(product('A', 'new'))];
    bulk.statuses = [OPEN];
    const run = writer.writeBatch({ changeset: changesetFor(['A']), items: [item('A')], batch });
    await expect(run).rejects.toBeInstanceOf(RetryableWriteError);
    await expect(run).rejects.toMatchObject({ code: 'poll_timeout', message: 'batch write interrupted: poll_timeout' });
    const total = clock.sleeps.reduce((a, b) => a + b, 0);
    const lastSleep = clock.sleeps.at(-1) ?? 0;
    // It gives up on the first round at or past 10 minutes, not earlier.
    expect(total).toBeGreaterThanOrEqual(POLL_GIVE_UP_MS);
    expect(total - lastSleep).toBeLessThan(POLL_GIVE_UP_MS);
    expect(bulk.statusCalls).toHaveLength(clock.sleeps.length);
    expect(batch.heartbeats).toBe(clock.sleeps.length);

    const before = bulk.statusCalls.length;
    bulk.statuses = [DONE];
    const outcomes = await writer.writeBatch({ changeset: changesetFor(['A']), items: [item('A')], batch });
    expect(bulk.submitted).toHaveLength(1);
    expect(batch.recorded).toHaveLength(1);
    expect(bulk.statusCalls.slice(before)).toEqual(['u-1']);
    expect(outcomes).toEqual([{ targetId: 'A', status: 'written' }]);
  });

  it('EXE-4 a retriable status failure throws status_failed after the submission was recorded; the retry polls again', async () => {
    const { reader, bulk, batch, writer } = setup();
    reader.pages = [page(product('A', 'old')), page(product('A', 'new'))];
    bulk.statuses = [{ ok: false, code: 'busy', retriable: true }, DONE];
    await expect(writer.writeBatch({ changeset: changesetFor(['A']), items: [item('A')], batch })).rejects.toMatchObject({
      name: 'RetryableWriteError',
      code: 'status_failed',
    });
    expect(batch.recorded).toHaveLength(1);
    const outcomes = await writer.writeBatch({ changeset: changesetFor(['A']), items: [item('A')], batch });
    expect(bulk.submitted).toHaveLength(1);
    expect(bulk.statusCalls).toEqual(['u-1', 'u-1']);
    expect(outcomes).toEqual([{ targetId: 'A', status: 'written' }]);
  });

  it('EXE-5 a non-retriable status failure (upstream no longer knows the batch) fails every submitted item with no_outcome (Review Focus 4)', async () => {
    const { reader, bulk, batch, writer } = setup();
    const ids = ['A', 'B', 'C'];
    reader.pages = [page(product('A', 'old'), product('B', 'new'), product('C', 'old'))];
    bulk.statuses = [{ ok: false, code: 'not_found', retriable: false }];
    const outcomes = await writer.writeBatch({ changeset: changesetFor(ids), items: ids.map(item), batch });
    // No verify read: only the pre-write read happened.
    expect(reader.calls).toHaveLength(1);
    expect(outcomes).toEqual([
      { targetId: 'A', status: 'failed', error: 'no_outcome' },
      { targetId: 'B', status: 'written', error: 'already_applied' },
      { targetId: 'C', status: 'failed', error: 'no_outcome' },
    ]);
  });

  it.each([
    ['http_status 401', { code: 'http_status', status: 401 }],
    ['http_status 403', { code: 'http_status', status: 403 }],
    ['credential_missing', { code: 'credential_missing' }],
    ['credential_unusable', { code: 'credential_unusable' }],
  ])('EXE-4 a status failure from authentication (%s) is retried as status_failed, not no_outcome', async (_label, failure) => {
    const { reader, bulk, batch, writer } = setup();
    reader.pages = [page(product('A', 'old')), page(product('A', 'new'))];
    bulk.statuses = [{ ok: false, retriable: false, ...failure }, DONE];
    await expect(writer.writeBatch({ changeset: changesetFor(['A']), items: [item('A')], batch })).rejects.toMatchObject({
      name: 'RetryableWriteError',
      code: 'status_failed',
    });
    expect(batch.recorded).toHaveLength(1);
    const outcomes = await writer.writeBatch({ changeset: changesetFor(['A']), items: [item('A')], batch });
    expect(bulk.submitted).toHaveLength(1);
    expect(outcomes).toEqual([{ targetId: 'A', status: 'written' }]);
  });

  it.each([
    ['http_status 404', { code: 'http_status', status: 404 }],
    ['invalid_response', { code: 'invalid_response' }],
  ])('EXE-5 a non-retriable status failure (%s) keeps failing the submitted items no_outcome', async (_label, failure) => {
    const { reader, bulk, batch, writer } = setup();
    reader.pages = [page(product('A', 'old'))];
    bulk.statuses = [{ ok: false, retriable: false, ...failure }];
    const outcomes = await writer.writeBatch({ changeset: changesetFor(['A']), items: [item('A')], batch });
    expect(outcomes).toEqual([{ targetId: 'A', status: 'failed', error: 'no_outcome' }]);
  });

  it('EXE-4 a status answer with an empty item list counts as still open', async () => {
    const { reader, bulk, batch, writer } = setup();
    reader.pages = [page(product('A', 'old')), page(product('A', 'new'))];
    bulk.statuses = [{ ok: true, items: [] }, { ok: true, items: [] }, DONE];
    const outcomes = await writer.writeBatch({ changeset: changesetFor(['A']), items: [item('A')], batch });
    expect(bulk.statusCalls).toHaveLength(3);
    expect(outcomes).toEqual([{ targetId: 'A', status: 'written' }]);
  });

  it('EXE-4 an upstream that only ever answers an empty item list is given up with poll_timeout', async () => {
    const { reader, bulk, batch, writer } = setup();
    reader.pages = [page(product('A', 'old'))];
    bulk.statuses = [{ ok: true, items: [] }];
    await expect(writer.writeBatch({ changeset: changesetFor(['A']), items: [item('A')], batch })).rejects.toMatchObject({
      code: 'poll_timeout',
    });
  });

  it('EXE-5 in a non-empty answer a submitted index that is absent becomes no_outcome once no listed item is open', async () => {
    const { reader, bulk, batch, writer } = setup();
    const ids = ['A', 'B'];
    reader.pages = [page(product('A', 'old'), product('B', 'old')), page(product('A', 'new'))];
    bulk.statuses = [{ ok: true, items: [{ index: 0, state: 'open' }] }, DONE];
    const outcomes = await writer.writeBatch({ changeset: changesetFor(ids), items: ids.map(item), batch });
    expect(bulk.statusCalls).toHaveLength(2);
    expect(outcomes).toEqual([
      { targetId: 'A', status: 'written' },
      { targetId: 'B', status: 'failed', error: 'no_outcome' },
    ]);
  });

  it('CS-7 only canonical JSON encoding errors count as drift: another error in the pre-write comparison propagates', async () => {
    const { reader, bulk, batch, writer } = setup();
    reader.pages = [page(withThrowingDescription('A'))];
    await expect(writer.writeBatch({ changeset: changesetFor(['A']), items: [item('A')], batch })).rejects.toThrow(
      'programming error',
    );
    expect(bulk.submitted).toEqual([]);
  });

  it('CS-7 only canonical JSON encoding errors count as drift: another error in the verify comparison propagates', async () => {
    const { reader, batch, writer } = setup();
    reader.pages = [page(product('A', 'old')), page(withThrowingDescription('A'))];
    await expect(writer.writeBatch({ changeset: changesetFor(['A']), items: [item('A')], batch })).rejects.toThrow(
      'programming error',
    );
  });
});

describe('OPS-6 unsupported write mode', () => {
  it('OPS-6 UnsupportedWriter fails every item with write_mode_unsupported', async () => {
    const events: string[] = [];
    const outcomes = await new UnsupportedWriter().writeBatch({
      changeset: changesetFor(['A', 'B']),
      items: [item('A'), item('B')],
      batch: new FakeBatch(events),
    });
    expect(outcomes).toEqual([
      { targetId: 'A', status: 'failed', error: 'write_mode_unsupported' },
      { targetId: 'B', status: 'failed', error: 'write_mode_unsupported' },
    ]);
    expect(events).toEqual([]);
  });
});

describe('EXE-8 ManifestBatchWriter reverse', () => {
  const reverse = () => setup(operation, 'reverse');

  it('EXE-8 reverse writes the before values of the items still at after and verifies them', async () => {
    const { events, reader, bulk, batch, writer } = reverse();
    reader.pages = [page(product('A', 'new', { status: 2 }), product('B', 'new')), page(product('A', 'old'), product('B', 'old'))];
    bulk.statuses = [states('ok', 'ok')];
    const outcomes = await writer.writeBatch({ changeset: changesetFor(['A', 'B']), items: [item('A'), item('B')], batch });
    expect(bulk.submitted).toEqual([
      [
        { sku: 'A', status: 2, description: 'old' },
        { sku: 'B', description: 'old' },
      ],
    ]);
    expect(batch.recorded).toEqual([
      {
        upstreamBatchId: 'u-1',
        plan: [
          { targetId: 'A', action: 'write' },
          { targetId: 'B', action: 'write' },
        ],
      },
    ]);
    expect(events.indexOf('record')).toBeLessThan(events.indexOf('status'));
    expect(reader.calls[0]?.args).toMatchObject({ fields: ['sku', 'description', 'brand', 'status'] });
    expect(reader.calls[1]?.args).toMatchObject({ skus: ['A', 'B'], fields: ['sku', 'description'] });
    expect(outcomes).toEqual([
      { targetId: 'A', status: 'written' },
      { targetId: 'B', status: 'written' },
    ]);
  });

  it('EXE-8 CS-7 reverse skips drift and reports already_restored without submitting', async () => {
    const { events, reader, bulk, batch, writer } = reverse();
    reader.pages = [page(product('A', 'other'), product('B', 'old'))];
    const outcomes = await writer.writeBatch({
      changeset: changesetFor(['A', 'B', 'C']),
      items: [item('A'), item('B'), item('C')],
      batch,
    });
    expect(bulk.submitted).toEqual([]);
    expect(batch.recorded).toEqual([]);
    expect(events).toEqual(['read']);
    expect(outcomes).toEqual([
      { targetId: 'A', status: 'skipped', error: 'drift' },
      { targetId: 'B', status: 'written', error: 'already_restored' },
      { targetId: 'C', status: 'skipped', error: 'gone' },
    ]);
  });

  it('EXE-4 reverse resumes a recorded submission without a second submit', async () => {
    const { reader, bulk, batch, writer } = reverse();
    const ids = ['A', 'B'];
    reader.pages = [page(product('A', 'new'), product('B', 'old')), { ok: false, code: 'network' }, page(product('A', 'old'))];
    bulk.statuses = [DONE];
    const input = { changeset: changesetFor(ids), items: ids.map(item), batch };
    await expect(writer.writeBatch(input)).rejects.toMatchObject({ name: 'RetryableWriteError', code: 'read_failed' });
    expect(batch.submission).toBeDefined();
    const outcomes = await writer.writeBatch(input);
    expect(bulk.submitted).toEqual([[{ sku: 'A', description: 'old' }]]);
    expect(batch.recorded).toHaveLength(1);
    expect(reader.calls).toHaveLength(3);
    expect(reader.calls[2]?.args).toMatchObject({ skus: ['A'] });
    expect(outcomes).toEqual([
      { targetId: 'A', status: 'written' },
      { targetId: 'B', status: 'written', error: 'already_restored' },
    ]);
  });

  it('EXE-8 a reverse verify that reads after again marks the item skipped drift', async () => {
    const { reader, bulk, batch, writer } = reverse();
    reader.pages = [page(product('A', 'new')), page(product('A', 'new'))];
    const outcomes = await writer.writeBatch({ changeset: changesetFor(['A']), items: [item('A')], batch });
    expect(bulk.submitted).toEqual([[{ sku: 'A', description: 'old' }]]);
    expect(outcomes).toEqual([{ targetId: 'A', status: 'skipped', error: 'drift' }]);
  });

  it('EXE-4 direction forward and omitted give identical submissions and outcomes', async () => {
    const run = async (direction?: WriteDirection) => {
      const s = setup(operation, direction);
      s.reader.pages = [
        page(product('A', 'old', { status: 2 }), product('B', 'new'), product('C', 'other')),
        page(product('A', 'new', { status: 2 })),
      ];
      const outcomes = await s.writer.writeBatch({
        changeset: changesetFor(['A', 'B', 'C', 'D']),
        items: ['A', 'B', 'C', 'D'].map(item),
        batch: s.batch,
      });
      return { outcomes, submitted: s.bulk.submitted, recorded: s.batch.recorded, reads: s.reader.calls, events: s.events };
    };
    const omitted = await run();
    const forward = await run('forward');
    expect(forward).toEqual(omitted);
    expect(omitted.submitted).toEqual([[{ sku: 'A', status: 2, description: 'new' }]]);
    expect(omitted.outcomes).toEqual([
      { targetId: 'A', status: 'written' },
      { targetId: 'B', status: 'written', error: 'already_applied' },
      { targetId: 'C', status: 'skipped', error: 'drift' },
      { targetId: 'D', status: 'skipped', error: 'gone' },
    ]);
  });
});

// ---- Direct write mode (OPS-5, OPS-6): per-record and code writers answer one state per record. ----

type DirectResult = Awaited<ReturnType<DirectWriter['write']>>;

class FakeDirect implements DirectWriter {
  readonly written: Readonly<Record<string, unknown>>[][] = [];
  readonly heartbeats: (() => void)[] = [];
  /** One answer per call; the last one repeats. */
  answers: DirectResult[] = [{ ok: true, states: ['ok'] }];
  constructor(private readonly events: string[]) {}
  write(records: readonly Readonly<Record<string, unknown>>[], heartbeat: () => void): Promise<DirectResult> {
    this.events.push('write');
    this.written.push([...records]);
    this.heartbeats.push(heartbeat);
    const next = this.answers.length > 1 ? this.answers.shift() : this.answers[0];
    if (next === undefined) throw new Error('FakeDirect: no answer');
    return Promise.resolve(next);
  }
}

function directSetup(direction?: WriteDirection, op: OperationDefinition & { manifest: ManifestDefinition } = operation) {
  const events: string[] = [];
  const reader = new FakeReader(events);
  const direct = new FakeDirect(events);
  const clock = new FakeClock(events);
  const batch = new FakeBatch(events);
  const writer = new ManifestBatchWriter({
    operation: op,
    readFieldsArg: 'fields',
    readerFor: () => reader,
    directFor: () => direct,
    clock,
    ...(direction === undefined ? {} : { direction }),
  });
  return { events, reader, direct, clock, batch, writer };
}

const directStates = (...s: DirectRecordState[]): DirectResult => ({ ok: true, states: s });

describe('OPS-6 OPS-5 direct write mode', () => {
  it('OPS-6 writes only items still at before and verifies ok items with one read', async () => {
    const { events, reader, direct, batch, writer } = directSetup();
    reader.pages = [
      page(product('A', 'old', { status: 2 }), product('B', 'new'), product('C', 'other'), product('E', 'old')),
      page(product('A', 'new'), product('E', 'new')),
    ];
    direct.answers = [directStates('ok', 'ok')];
    const ids = ['A', 'B', 'C', 'D', 'E'];
    const outcomes = await writer.writeBatch({ changeset: changesetFor(ids), items: ids.map(item), batch });
    expect(direct.written).toEqual([
      [
        { sku: 'A', status: 2, description: 'new' },
        { sku: 'E', description: 'new' },
      ],
    ]);
    expect(events).toEqual(['read', 'write', 'read']);
    expect(batch.recorded).toEqual([]);
    expect(reader.calls[1]?.args).toMatchObject({ skus: ['A', 'E'], fields: ['sku', 'description'] });
    expect(outcomes).toEqual([
      { targetId: 'A', status: 'written' },
      { targetId: 'B', status: 'written', error: 'already_applied' },
      { targetId: 'C', status: 'skipped', error: 'drift' },
      { targetId: 'D', status: 'skipped', error: 'gone' },
      { targetId: 'E', status: 'written' },
    ]);
  });

  it('OPS-6 NFR-2 a retriable state throws write_retriable; the retry classifies the ok items as already_applied and sends only the rest', async () => {
    const { reader, direct, batch, writer } = directSetup();
    const ids = ['A', 'B', 'C'];
    // Attempt 1 wrote A, B answered retriable, and the writer started nothing for C (F10): the
    // answer is shorter than the records, and the thrown retry covers that tail.
    reader.pages = [
      page(product('A', 'old'), product('B', 'old'), product('C', 'old')),
      page(product('A', 'new'), product('B', 'old'), product('C', 'old')),
      page(product('B', 'new'), product('C', 'new')),
    ];
    direct.answers = [directStates('ok', 'retriable'), directStates('ok', 'ok')];
    const input = { changeset: changesetFor(ids), items: ids.map(item), batch };
    await expect(writer.writeBatch(input)).rejects.toMatchObject({ name: 'RetryableWriteError', code: 'write_retriable' });
    expect(reader.calls).toHaveLength(1);
    const outcomes = await writer.writeBatch(input);
    expect(direct.written).toEqual([
      [
        { sku: 'A', description: 'new' },
        { sku: 'B', description: 'new' },
        { sku: 'C', description: 'new' },
      ],
      [
        { sku: 'B', description: 'new' },
        { sku: 'C', description: 'new' },
      ],
    ]);
    expect(batch.recorded).toEqual([]);
    expect(outcomes).toEqual([
      { targetId: 'A', status: 'written', error: 'already_applied' },
      { targetId: 'B', status: 'written' },
      { targetId: 'C', status: 'written' },
    ]);
  });

  it('OPS-6 a failed state is upstream_failed; a missing state is no_outcome', async () => {
    const { reader, direct, batch, writer } = directSetup();
    const ids = ['A', 'B', 'C'];
    reader.pages = [page(product('A', 'old'), product('B', 'old'), product('C', 'old')), page(product('A', 'new'))];
    direct.answers = [directStates('ok', 'failed')];
    const outcomes = await writer.writeBatch({ changeset: changesetFor(ids), items: ids.map(item), batch });
    expect(reader.calls[1]?.args).toMatchObject({ skus: ['A'] });
    expect(outcomes).toEqual([
      { targetId: 'A', status: 'written' },
      { targetId: 'B', status: 'failed', error: 'upstream_failed' },
      { targetId: 'C', status: 'failed', error: 'no_outcome' },
    ]);
  });

  it('OPS-6 a non-retriable invalid_response answer is no_outcome for every to-write item, any other is upstream_rejected; a retriable answer throws write_failed', async () => {
    const run = async (answer: DirectResult) => {
      const s = directSetup();
      s.reader.pages = [page(product('A', 'old'), product('B', 'new'))];
      s.direct.answers = [answer];
      const outcomes = await s.writer.writeBatch({ changeset: changesetFor(['A', 'B']), items: [item('A'), item('B')], batch: s.batch });
      expect(s.reader.calls).toHaveLength(1);
      return outcomes;
    };
    expect(await run({ ok: false, code: 'invalid_response', retriable: false })).toEqual([
      { targetId: 'A', status: 'failed', error: 'no_outcome' },
      { targetId: 'B', status: 'written', error: 'already_applied' },
    ]);
    expect(await run({ ok: false, code: 'mapping', retriable: false })).toEqual([
      { targetId: 'A', status: 'failed', error: 'upstream_rejected' },
      { targetId: 'B', status: 'written', error: 'already_applied' },
    ]);
    await expect(run({ ok: false, code: 'timeout', retriable: true })).rejects.toMatchObject({
      name: 'RetryableWriteError',
      code: 'write_failed',
    });
  });

  it('EXE-4 a recorded submission in direct mode ends every to-write item as no_outcome without writing', async () => {
    const { events, direct, batch, writer } = directSetup();
    batch.submission = {
      upstreamBatchId: 'u-7',
      plan: [
        { targetId: 'B', action: 'outcome', status: 'skipped', error: 'drift' },
        { targetId: 'A', action: 'write' },
      ],
    };
    const outcomes = await writer.writeBatch({ changeset: changesetFor(['A', 'B']), items: [item('A'), item('B')], batch });
    expect(direct.written).toEqual([]);
    expect(events).toEqual([]);
    expect(outcomes).toEqual([
      { targetId: 'B', status: 'skipped', error: 'drift' },
      { targetId: 'A', status: 'failed', error: 'no_outcome' },
    ]);
  });

  it('EXE-8 reverse direction writes before over after and reports already_restored', async () => {
    const { reader, direct, batch, writer } = directSetup('reverse');
    reader.pages = [page(product('A', 'new'), product('B', 'old')), page(product('A', 'old'))];
    const outcomes = await writer.writeBatch({ changeset: changesetFor(['A', 'B']), items: [item('A'), item('B')], batch });
    expect(direct.written).toEqual([[{ sku: 'A', description: 'old' }]]);
    expect(outcomes).toEqual([
      { targetId: 'A', status: 'written' },
      { targetId: 'B', status: 'written', error: 'already_restored' },
    ]);
  });

  it('NFR-2 the heartbeat passed to the direct writer is the batch heartbeat', async () => {
    const { reader, direct, batch, writer } = directSetup();
    reader.pages = [page(product('A', 'old')), page(product('A', 'new'))];
    await writer.writeBatch({ changeset: changesetFor(['A']), items: [item('A')], batch });
    const before = batch.heartbeats;
    direct.heartbeats[0]?.();
    expect(batch.heartbeats).toBe(before + 1);
  });

  it('OPS-6 bulk status is asked with the to-write target IDs in plan order', async () => {
    const { bulk, reader, batch, writer } = setup();
    reader.pages = [page(product('C', 'old'), product('B', 'new'), product('A', 'old')), page(product('C', 'new'), product('A', 'new'))];
    bulk.statuses = [states('ok', 'ok')];
    await writer.writeBatch({ changeset: changesetFor(['C', 'B', 'A']), items: ['C', 'B', 'A'].map(item), batch });
    expect(bulk.statusKeys).toEqual([['C', 'A']]);

    // Resume from a recorded plan: the keys come from the plan, not from a read.
    const resumed = setup();
    resumed.batch.submission = {
      upstreamBatchId: 'u-9',
      plan: [
        { targetId: 'Z', action: 'write' },
        { targetId: 'Y', action: 'outcome', status: 'skipped', error: 'gone' },
        { targetId: 'X', action: 'write' },
      ],
    };
    resumed.bulk.statuses = [{ ok: true, items: [] }, states('ok', 'failed')];
    resumed.reader.pages = [page(product('Z', 'new'))];
    await resumed.writer.writeBatch({ changeset: changesetFor(['Z', 'Y', 'X']), items: ['Z', 'Y', 'X'].map(item), batch: resumed.batch });
    expect(resumed.bulk.statusKeys).toEqual([
      ['Z', 'X'],
      ['Z', 'X'],
    ]);
  });
});

// ---- Create and delete (CS-7, OPS-2): a `null` side stands for "no record". ----

describe('CS-7 OPS-2 create and delete', () => {
  const createManifest: ManifestDefinition = {
    action: 'create',
    idField: 'sku',
    recordsArg: 'records',
    fields: ['name', 'price'],
    requiredFields: [],
    scopeArgs: {},
    readBefore: { operation: 'catalog.get_products_by_sku', args: {}, idsArg: 'skus' },
    batchSize: 100,
    maxTargets: 1000,
    rollback: { strategy: 'inverse_operation', operation: 'catalog.delete_products' },
  };
  const createOperation = { ...operation, id: 'catalog.create_products', fieldsArg: 'records', manifest: createManifest };
  const deleteManifest: ManifestDefinition = {
    action: 'delete',
    idField: 'sku',
    idsArg: 'skus',
    fields: ['name', 'price'],
    requiredFields: [],
    scopeArgs: { brand: 'brand' },
    // Existence is read without the scope filter; the scope is checked on the record (ADR 0071).
    readBefore: { operation: 'catalog.get_products_by_sku', args: {}, idsArg: 'skus' },
    batchSize: 100,
    maxTargets: 1000,
    rollback: { strategy: 'inverse_operation', operation: 'catalog.create_products' },
  };
  const deleteOperation = { ...operation, id: 'catalog.delete_products', risk: 'destructive' as const, manifest: deleteManifest };
  const createChangeset = (...records: Record<string, unknown>[]): ChangeSetRecord => ({
    ...changesetFor([]),
    operation: createOperation.id,
    args: { records },
  });
  const deleteChangeset: ChangeSetRecord = { ...changesetFor(['A']), operation: deleteOperation.id, args: { brand: 'acme', skus: ['A'] } };
  const created = (targetId: string, name: string): ChangeItemRecord => ({ targetId, status: 'pending', before: null, after: { name } });
  const deleted: ChangeItemRecord = { targetId: 'A', status: 'pending', before: { name: 'N', price: 1 }, after: null };

  it('OPS-2 a create sends the identifier and its values and ends written once the verify read finds the record', async () => {
    const { events, reader, direct, batch, writer } = directSetup(undefined, createOperation);
    reader.pages = [page(), page({ sku: 'n1', name: 'N' })];
    const outcomes = await writer.writeBatch({ changeset: createChangeset({ sku: 'n1', name: 'N' }), items: [created('n1', 'N')], batch });
    expect(direct.written).toEqual([[{ sku: 'n1', name: 'N' }]]);
    expect(events).toEqual(['read', 'write', 'read']);
    expect(reader.calls[1]?.args).toMatchObject({ skus: ['n1'], fields: ['sku', 'name'] });
    expect(outcomes).toEqual([{ targetId: 'n1', status: 'written' }]);
  });

  it('CS-7 a create the upstream answers ok but the verify read does not find ends failed not_applied', async () => {
    const { reader, batch, writer } = directSetup(undefined, createOperation);
    reader.pages = [page(), page()];
    const outcomes = await writer.writeBatch({ changeset: createChangeset({ sku: 'n1', name: 'N' }), items: [created('n1', 'N')], batch });
    expect(outcomes).toEqual([{ targetId: 'n1', status: 'failed', error: 'not_applied' }]);
  });

  it('CS-7 a create whose verify read finds other values ends skipped drift', async () => {
    const { reader, batch, writer } = directSetup(undefined, createOperation);
    reader.pages = [page(), page({ sku: 'n1', name: 'other' })];
    const outcomes = await writer.writeBatch({ changeset: createChangeset({ sku: 'n1', name: 'N' }), items: [created('n1', 'N')], batch });
    expect(outcomes).toEqual([{ targetId: 'n1', status: 'skipped', error: 'drift' }]);
  });

  // A delete call has no values argument: the batch-wide "touches no field" guard must not fire.
  it('OPS-2 a delete sends only the identifier and ends written when the verify read no longer finds the record', async () => {
    const { events, reader, direct, batch, writer } = directSetup(undefined, deleteOperation);
    reader.pages = [page({ sku: 'A', brand: 'acme', name: 'N', price: 1, status: 2 }), page()];
    const outcomes = await writer.writeBatch({ changeset: deleteChangeset, items: [deleted], batch });
    expect(direct.written).toEqual([[{ sku: 'A' }]]);
    expect(events).toEqual(['read', 'write', 'read']);
    expect(reader.calls[0]?.args).toMatchObject({ skus: ['A'], fields: ['sku', 'name', 'price', 'brand'] });
    expect(outcomes).toEqual([{ targetId: 'A', status: 'written' }]);
  });

  it('OPS-6 a delete carries the carry fields of the current record', async () => {
    const carrying = { ...deleteOperation, manifest: { ...deleteManifest, write: { carryFields: ['status'] } } };
    const { reader, direct, batch, writer } = directSetup(undefined, carrying);
    reader.pages = [page({ sku: 'A', brand: 'acme', name: 'N', price: 1, status: 2 }), page()];
    const outcomes = await writer.writeBatch({ changeset: deleteChangeset, items: [deleted], batch });
    expect(direct.written).toEqual([[{ sku: 'A', status: 2 }]]);
    expect(outcomes).toEqual([{ targetId: 'A', status: 'written' }]);
  });

  it('CS-7 a delete the upstream answers ok but the verify read still finds ends failed not_applied', async () => {
    const { reader, batch, writer } = directSetup(undefined, deleteOperation);
    const current = page({ sku: 'A', brand: 'acme', name: 'N', price: 1 });
    reader.pages = [current, current];
    const outcomes = await writer.writeBatch({ changeset: deleteChangeset, items: [deleted], batch });
    expect(outcomes).toEqual([{ targetId: 'A', status: 'failed', error: 'not_applied' }]);
  });

  it('NFR-2 a retry after write_retriable re-reads and reports the record already created as already_applied', async () => {
    const { reader, direct, batch, writer } = directSetup(undefined, createOperation);
    const cs = createChangeset({ sku: 'n1', name: 'N1' }, { sku: 'n2', name: 'N2' });
    const items = [created('n1', 'N1'), created('n2', 'N2')];
    reader.pages = [page(), page({ sku: 'n1', name: 'N1' }), page({ sku: 'n1', name: 'N1' }, { sku: 'n2', name: 'N2' })];
    direct.answers = [directStates('ok', 'retriable'), directStates('ok')];
    await expect(writer.writeBatch({ changeset: cs, items, batch })).rejects.toMatchObject({
      name: 'RetryableWriteError',
      code: 'write_retriable',
    });
    const outcomes = await writer.writeBatch({ changeset: cs, items, batch });
    expect(direct.written).toEqual([
      [
        { sku: 'n1', name: 'N1' },
        { sku: 'n2', name: 'N2' },
      ],
      [{ sku: 'n2', name: 'N2' }],
    ]);
    expect(outcomes).toEqual([
      { targetId: 'n1', status: 'written', error: 'already_applied' },
      { targetId: 'n2', status: 'written' },
    ]);
  });

  describe('OPS-2 CS-7 POL-2 the scope is checked on the record that the unscoped read returns', () => {
    const scopedCreate = {
      ...createOperation,
      manifest: { ...createManifest, fields: ['name', 'price', 'brand'], scopeArgs: { brand: 'brand' } },
    };
    const scopedCreateChangeset: ChangeSetRecord = { ...createChangeset(), args: { brand: 'acme', records: [{ sku: 'n1', name: 'N', brand: 'acme' }] } };
    const scopedCreated: ChangeItemRecord = { targetId: 'n1', status: 'pending', before: null, after: { name: 'N', brand: 'acme' } };

    it('CS-7 a create whose identifier appeared outside the scope after approval is skipped drift and nothing is sent', async () => {
      const { reader, direct, batch, writer } = directSetup(undefined, scopedCreate);
      // The same values, another scope: never written over, never already_applied.
      reader.pages = [page({ sku: 'n1', name: 'N', brand: 'other' })];
      const outcomes = await writer.writeBatch({ changeset: scopedCreateChangeset, items: [scopedCreated], batch });
      expect(direct.written).toEqual([]);
      expect(outcomes).toEqual([{ targetId: 'n1', status: 'skipped', error: 'drift' }]);
    });

    it('CS-7 a delete whose target moved out of the scope after approval is skipped drift, never already_applied', async () => {
      const { reader, direct, batch, writer } = directSetup(undefined, deleteOperation);
      reader.pages = [page({ sku: 'A', brand: 'other', name: 'N', price: 1 })];
      const outcomes = await writer.writeBatch({ changeset: deleteChangeset, items: [deleted], batch });
      expect(direct.written).toEqual([]);
      expect(reader.calls[0]?.args).not.toHaveProperty('brand');
      expect(outcomes).toEqual([{ targetId: 'A', status: 'skipped', error: 'drift' }]);
    });

    it('CS-7 a delete answered ok whose verify read still finds the record outside the scope ends failed not_applied', async () => {
      const { reader, batch, writer } = directSetup(undefined, deleteOperation);
      reader.pages = [page({ sku: 'A', brand: 'acme', name: 'N', price: 1 }), page({ sku: 'A', brand: 'other', name: 'N', price: 1 })];
      const outcomes = await writer.writeBatch({ changeset: deleteChangeset, items: [deleted], batch });
      expect(outcomes).toEqual([{ targetId: 'A', status: 'failed', error: 'not_applied' }]);
    });
  });

  describe('CS-7 a short read_before page is incomplete for create and delete', () => {
    /** Fewer records than the upstream reports: a default page size cut the answer. */
    const shortPage = (...items: Record<string, unknown>[]): ReadPage => ({ ok: true, items, total: items.length + 1, truncated: false });

    it('CS-7 a create whose classify read is short throws incomplete_read and sends nothing', async () => {
      const { reader, direct, batch, writer } = directSetup(undefined, createOperation);
      reader.pages = [shortPage()];
      await expect(writer.writeBatch({ changeset: createChangeset({ sku: 'n1', name: 'N' }), items: [created('n1', 'N')], batch })).rejects.toMatchObject({
        name: 'RetryableWriteError',
        code: 'incomplete_read',
      });
      expect(direct.written).toEqual([]);
    });

    it('CS-7 a delete whose classify read returns a record without a readable identifier throws incomplete_read', async () => {
      const { reader, direct, batch, writer } = directSetup(undefined, deleteOperation);
      reader.pages = [page({ brand: 'acme', name: 'N', price: 1 })];
      await expect(writer.writeBatch({ changeset: deleteChangeset, items: [deleted], batch })).rejects.toMatchObject({ code: 'incomplete_read' });
      expect(direct.written).toEqual([]);
    });

    it('CS-7 a delete whose verify read is short throws incomplete_read and never ends written', async () => {
      const { reader, direct, batch, writer } = directSetup(undefined, deleteOperation);
      reader.pages = [page({ sku: 'A', brand: 'acme', name: 'N', price: 1 }), shortPage()];
      await expect(writer.writeBatch({ changeset: deleteChangeset, items: [deleted], batch })).rejects.toMatchObject({ code: 'incomplete_read' });
      expect(direct.written).toEqual([[{ sku: 'A' }]]);
    });

    it('CS-7 a create whose verify read returns a record without a readable identifier throws incomplete_read', async () => {
      const { reader, batch, writer } = directSetup(undefined, createOperation);
      reader.pages = [page(), page({ name: 'N' })];
      await expect(writer.writeBatch({ changeset: createChangeset({ sku: 'n1', name: 'N' }), items: [created('n1', 'N')], batch })).rejects.toMatchObject({
        code: 'incomplete_read',
      });
    });

    it('CS-7 the reverse of a create (a delete-shaped rollback) is held to the same rule', async () => {
      const { reader, direct, batch, writer } = directSetup('reverse', createOperation);
      reader.pages = [page({ sku: 'n1', name: 'N' }), shortPage()];
      await expect(
        writer.writeBatch({ changeset: createChangeset({ sku: 'n1', name: 'N' }), items: [{ ...created('n1', 'N'), status: 'written' }], batch }),
      ).rejects.toMatchObject({ code: 'incomplete_read' });
      expect(direct.written).toEqual([[{ sku: 'n1' }]]);
    });

    it('CS-7 an update batch with the same short page behaves as before: the missing target is gone', async () => {
      const { reader, batch, writer } = directSetup();
      reader.pages = [shortPage(product('A', 'old')), shortPage(product('A', 'new'))];
      const outcomes = await writer.writeBatch({ changeset: changesetFor(['A', 'B']), items: [item('A'), item('B')], batch });
      expect(outcomes).toEqual([
        { targetId: 'A', status: 'written' },
        { targetId: 'B', status: 'skipped', error: 'gone' },
      ]);
    });
  });

  it('EXE-8 reverse of a written create sends a delete-shaped record and ends written once the record is gone', async () => {
    const { reader, direct, batch, writer } = directSetup('reverse', createOperation);
    reader.pages = [page({ sku: 'n1', name: 'N' }), page()];
    const outcomes = await writer.writeBatch({
      changeset: createChangeset({ sku: 'n1', name: 'N' }),
      items: [{ ...created('n1', 'N'), status: 'written' }],
      batch,
    });
    expect(direct.written).toEqual([[{ sku: 'n1' }]]);
    expect(outcomes).toEqual([{ targetId: 'n1', status: 'written' }]);
  });

  it('EXE-8 reverse of a written delete sends the identifier with every stored field and ends written once it is back', async () => {
    const { reader, direct, batch, writer } = directSetup('reverse', deleteOperation);
    reader.pages = [page(), page({ sku: 'A', brand: 'acme', name: 'N', price: 1 })];
    const outcomes = await writer.writeBatch({ changeset: deleteChangeset, items: [{ ...deleted, status: 'written' }], batch });
    expect(direct.written).toEqual([[{ sku: 'A', name: 'N', price: 1 }]]);
    expect(outcomes).toEqual([{ targetId: 'A', status: 'written' }]);
  });

  it('EXE-8 reverse of a create already removed reads already_restored and writes nothing', async () => {
    const { reader, direct, batch, writer } = directSetup('reverse', createOperation);
    reader.pages = [page()];
    const outcomes = await writer.writeBatch({
      changeset: createChangeset({ sku: 'n1', name: 'N' }),
      items: [{ ...created('n1', 'N'), status: 'written' }],
      batch,
    });
    expect(direct.written).toEqual([]);
    expect(outcomes).toEqual([{ targetId: 'n1', status: 'written', error: 'already_restored' }]);
  });
});
