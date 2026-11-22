// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Mandate Authors
import { describe, expect, it } from 'vitest';
import type { ManifestDefinition, ManifestVerifyAfter } from '../policy-model.js';
import type { ReadPage, UpstreamReader } from './ports.js';
import { changesetVerificationEvent, VERIFICATION_CODES, verificationSchedule, verifyChunk } from './verification.js';

const verifyAfter: ManifestVerifyAfter = {
  afterSeconds: 60,
  everySeconds: 30,
  timeoutSeconds: 900,
  lookups: { shop: { operation: 'shop.read', idsArg: 'skus', keyField: 'sku', key: { target: true }, fields: ['price'], args: {} } },
  checks: [
    { code: 'not_in_shop', require: [{ found: 'shop' }] },
    { code: 'shop_price_differs', require: [{ equals: [{ lookup: 'shop', field: 'price' }, { after: 'price' }] }] },
  ],
};

const base: ManifestDefinition = {
  idField: 'sku',
  idsArg: 'skus',
  fields: ['price'],
  requiredFields: [],
  scopeArgs: { store: 'store_id' },
  readBefore: { operation: 'catalog.get', idsArg: 'skus', args: { store: { arg: 'store' }, view: 'admin' } },
  batchSize: 100,
  maxTargets: 1000,
  rollback: { strategy: 'replay_previous_state' },
};

const manifest = { ...base, verifyAfter };

interface Call {
  readonly op: string;
  readonly args: Readonly<Record<string, unknown>>;
}

/** Answers each operation with its scripted page (a function of the call), records every call. */
class FakeReader implements UpstreamReader {
  readonly calls: Call[] = [];
  constructor(private readonly pages: Readonly<Record<string, (args: Readonly<Record<string, unknown>>) => ReadPage>>) {}
  read(op: string, args: Readonly<Record<string, unknown>>): Promise<ReadPage> {
    this.calls.push({ op, args });
    const page = this.pages[op];
    if (page === undefined) return Promise.reject(new Error(`unexpected read ${op}`));
    return Promise.resolve(page(args));
  }
}

const ok = (items: Record<string, unknown>[], extra: { total?: number; truncated?: boolean } = {}): ReadPage => ({
  ok: true,
  items,
  truncated: extra.truncated ?? false,
  ...(extra.total === undefined ? {} : { total: extra.total }),
});

const failed = (status: number): ReadPage => ({ ok: false, code: 'http_status', status });

const items = [
  { targetId: 'a', before: { price: 1 }, after: { price: 2 } },
  { targetId: 'b', before: { price: 1 }, after: { price: 2 } },
];

const input = (reader: UpstreamReader, m: ManifestDefinition & { verifyAfter: ManifestVerifyAfter } = manifest) => ({
  manifest: m,
  args: { store: 's1', skus: ['a', 'b'] },
  items,
  reader,
  readFieldsArg: (op: string) => (op === 'shop.read' || op === 'catalog.get' ? 'fields' : undefined),
});

const allFailed = [
  { targetId: 'a', confirmed: false, code: 'verify_read_failed' },
  { targetId: 'b', confirmed: false, code: 'verify_read_failed' },
];

describe('EXE-12 verify-after', () => {
  it('EXE-12 the fixed verification codes', () => {
    expect(VERIFICATION_CODES).toEqual(['verify_read_failed', 'verify_timeout', 'verify_cancelled']);
  });

  it('EXE-12 an item whose checks all hold is confirmed; otherwise it names the first failing check', async () => {
    const reader = new FakeReader({ 'shop.read': () => ok([{ sku: 'a', price: 2 }, { sku: 'b', price: 1 }]) });
    expect(await verifyChunk(input(reader))).toEqual([
      { targetId: 'a', confirmed: true },
      { targetId: 'b', confirmed: false, code: 'shop_price_differs' },
    ]);
    // One lookup read with the distinct keys and the lookup's fields; no `read_before` read.
    expect(reader.calls).toEqual([{ op: 'shop.read', args: { skus: ['a', 'b'], fields: ['sku', 'price'] } }]);
  });

  it('EXE-12 a lookup that finds nothing for an item fails the found check', async () => {
    const reader = new FakeReader({ 'shop.read': () => ok([{ sku: 'a', price: 2 }]) });
    const out = await verifyChunk(input(reader));
    expect(out[0]).toEqual({ targetId: 'a', confirmed: true });
    expect(out[1]).toEqual({ targetId: 'b', confirmed: false, code: 'not_in_shop' });
  });

  it.each([
    ['a failed read', failed(500)],
    ['a truncated read', ok([{ sku: 'a', price: 2 }, { sku: 'b', price: 2 }], { truncated: true })],
    ['a page shorter than its total', ok([{ sku: 'a', price: 2 }], { total: 5 })],
  ])('EXE-12 %s of a lookup makes every item of the chunk verify_read_failed', async (_name, page) => {
    const reader = new FakeReader({ 'shop.read': () => page });
    expect(await verifyChunk(input(reader))).toEqual(allFailed);
  });

  const statusManifest = {
    ...base,
    verifyAfter: { ...verifyAfter, lookups: {}, checks: [{ code: 'not_live', require: [{ equals: [{ record: 'status' }, { value: 'live' }] }] }] },
  } satisfies ManifestDefinition & { verifyAfter: ManifestVerifyAfter };

  it('EXE-12 a { record } check reads read_before once, with the field, the read arguments and no lookup', async () => {
    const reader = new FakeReader({
      'catalog.get': () => ok([{ sku: 'a', store_id: 's1', status: 'live' }, { sku: 'b', store_id: 's1', status: 'queued' }]),
    });
    expect(await verifyChunk(input(reader, statusManifest))).toEqual([
      { targetId: 'a', confirmed: true },
      { targetId: 'b', confirmed: false, code: 'not_live' },
    ]);
    expect(reader.calls).toHaveLength(1);
    expect(reader.calls[0]?.op).toBe('catalog.get');
    expect(reader.calls[0]?.args).toMatchObject({ store: 's1', view: 'admin', skus: ['a', 'b'] });
    expect(reader.calls[0]?.args.fields).toEqual(expect.arrayContaining(['sku', 'status']));
  });

  it('EXE-12 an update record outside the call scope is no record', async () => {
    const reader = new FakeReader({
      'catalog.get': () => ok([{ sku: 'a', store_id: 's1', status: 'live' }, { sku: 'b', store_id: 's2', status: 'live' }]),
    });
    const out = await verifyChunk(input(reader, statusManifest));
    expect(out[1]).toEqual({ targetId: 'b', confirmed: false, code: 'not_live' });
  });

  it.each([
    ['a failed read', failed(503)],
    ['a truncated read', ok([{ sku: 'a', store_id: 's1', status: 'live' }], { truncated: true })],
    ['a page shorter than its total', ok([{ sku: 'a', store_id: 's1', status: 'live' }], { total: 2 })],
  ])('EXE-12 %s of the current records makes every item of the chunk verify_read_failed', async (_name, page) => {
    const reader = new FakeReader({ 'catalog.get': () => page });
    expect(await verifyChunk(input(reader, statusManifest))).toEqual(allFailed);
  });

  const deletes = {
    ...base,
    action: 'delete',
    verifyAfter: { ...verifyAfter, lookups: {}, checks: [{ code: 'still_there', require: [{ absent: { record: 'sku' } }] }] },
  } satisfies ManifestDefinition & { verifyAfter: ManifestVerifyAfter };
  const deleteItems = [
    { targetId: 'a', before: { price: 1 }, after: null },
    { targetId: 'b', before: { price: 1 }, after: null },
  ];

  it('EXE-12 a deleted record that is gone confirms an absent { record } check; one still there, in any scope, does not', async () => {
    const reader = new FakeReader({ 'catalog.get': () => ok([{ sku: 'b', store_id: 'other' }]) });
    expect(await verifyChunk({ ...input(reader, deletes), items: deleteItems })).toEqual([
      { targetId: 'a', confirmed: true },
      { targetId: 'b', confirmed: false, code: 'still_there' },
    ]);
  });

  it.each([
    ['a page shorter than its total', ok([{ sku: 'b', store_id: 's1' }], { total: 2 })],
    ['a record without a readable identifier', ok([{ sku: { id: 'b' }, store_id: 's1' }])],
  ])('EXE-12 for a delete, %s is an incomplete read: verify_read_failed', async (_name, page) => {
    const reader = new FakeReader({ 'catalog.get': () => page });
    expect(await verifyChunk({ ...input(reader, deletes), items: deleteItems })).toEqual(allFailed);
  });

  it('EXE-12 a { record } lookup key is read from the current record', async () => {
    const m = {
      ...base,
      verifyAfter: {
        ...verifyAfter,
        lookups: { erp: { operation: 'erp.get', idsArg: 'codes', keyField: 'code', key: { record: 'mpn' }, fields: ['state'], args: {} } },
        checks: [{ code: 'not_in_erp', require: [{ found: 'erp' }] }],
      },
    } satisfies ManifestDefinition & { verifyAfter: ManifestVerifyAfter };
    const reader = new FakeReader({
      'catalog.get': () => ok([{ sku: 'a', store_id: 's1', mpn: 'M1' }, { sku: 'b', store_id: 's1', mpn: 'M2' }]),
      'erp.get': () => ok([{ code: 'M1', state: 'ok' }]),
    });
    const out = await verifyChunk({ ...input(reader, m), readFieldsArg: (op) => (op === 'erp.get' || op === 'catalog.get' ? 'fields' : undefined) });
    expect(out).toEqual([
      { targetId: 'a', confirmed: true },
      { targetId: 'b', confirmed: false, code: 'not_in_erp' },
    ]);
    expect(reader.calls[0]?.args.fields).toEqual(expect.arrayContaining(['mpn']));
    expect(reader.calls[1]).toEqual({ op: 'erp.get', args: { codes: ['M1', 'M2'], fields: ['code', 'state'] } });
  });

  it('EXE-12 without a { record } reference read_before is not read', async () => {
    const reader = new FakeReader({ 'shop.read': () => ok([{ sku: 'a', price: 2 }, { sku: 'b', price: 2 }]) });
    await verifyChunk(input(reader));
    expect(reader.calls.map((c) => c.op)).toEqual(['shop.read']);
  });

  it('EXE-12 any other error of the reader propagates', async () => {
    const reader: UpstreamReader = { read: () => Promise.reject(new Error('boom')) };
    await expect(verifyChunk(input(reader))).rejects.toThrow('boom');
  });

  it('EXE-12 the schedule: the first look after after_seconds, the deadline after timeout_seconds', () => {
    const s = verificationSchedule(verifyAfter, new Date('2026-01-01T00:00:00Z'));
    expect(s).toEqual({ firstAt: new Date('2026-01-01T00:01:00Z'), until: new Date('2026-01-01T00:15:00Z') });
  });

  it('EXE-12 SEC-3 the audit event carries the end and the counts, no item data', () => {
    const e = changesetVerificationEvent({
      id: 'e1',
      changeset: { id: 'cs1', operation: 'catalog.update_price' },
      end: 'timeout',
      counts: { pending: 0, confirmed: 3, unconfirmed: 2 },
      actor: 'system',
      correlationId: 'corr',
    });
    expect(e).toEqual({
      id: 'e1',
      actor: 'system',
      action: 'changeset.verification',
      subject: 'catalog.update_price',
      outcome: 'error',
      correlationId: 'corr',
      changesetId: 'cs1',
      details: { end: 'timeout', pending: 0, confirmed: 3, unconfirmed: 2, operation: 'catalog.update_price' },
    });
    const done = changesetVerificationEvent({
      id: 'e2',
      changeset: { id: 'cs1', operation: 'op' },
      end: 'done',
      counts: { pending: 0, confirmed: 5, unconfirmed: 0 },
      actor: 'system',
      correlationId: 'corr',
    });
    expect(done.outcome).toBe('ok');
  });
});
