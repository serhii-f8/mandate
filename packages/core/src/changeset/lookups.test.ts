// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Mandate Authors
import { describe, expect, it } from 'vitest';
import type { ManifestDefinition, ManifestLookup } from '../policy-model.js';
import { lookupKey, readLookups } from './lookups.js';
import type { ReadPage, UpstreamReader } from './ports.js';

const erp: ManifestLookup = {
  operation: 'erp.get_parts',
  idsArg: 'codes',
  keyField: 'code',
  key: { target: true },
  fields: ['cost', 'state'],
  args: { plant: { arg: 'plant' }, active: true },
};

const manifest: ManifestDefinition = {
  idField: 'sku',
  idsArg: 'skus',
  valuesArg: 'changes',
  fields: ['name', 'mpn'],
  requiredFields: [],
  scopeArgs: {},
  readBefore: { operation: 'catalog.get', idsArg: 'skus', args: {} },
  batchSize: 100,
  maxTargets: 10_000,
  rollback: { strategy: 'none' },
  checks: [{ code: 'not_in_erp', require: [{ found: 'erp' }] }],
  lookups: { erp },
};

interface Call {
  op: string;
  args: Readonly<Record<string, unknown>>;
}

/** Answers every requested code with a record, or with the scripted page. */
class FakeErp implements UpstreamReader {
  readonly calls: Call[] = [];
  constructor(private readonly page?: ReadPage) {}
  read(op: string, args: Readonly<Record<string, unknown>>): Promise<ReadPage> {
    this.calls.push({ op, args });
    if (this.page !== undefined) return Promise.resolve(this.page);
    const codes = args.codes as string[];
    return Promise.resolve({ ok: true, items: codes.map((code) => ({ code, cost: 1 })), truncated: false });
  }
}

const input = (keys: readonly string[], reader: UpstreamReader, chunkSize = 100) => ({
  manifest,
  args: { plant: 'P1', skus: [] },
  keysByLookup: new Map([['erp', keys]]),
  reader,
  readFieldsArg: (op: string) => (op === 'erp.get_parts' ? 'fields' : undefined),
  chunkSize,
});

describe('OPS-7 lookups', () => {
  describe('lookupKey', () => {
    const sides = { targetId: 'T1', before: { mpn: 'old' }, after: { mpn: 12 }, record: { mpn: 'rec', obj: { a: 1 } } };

    it('OPS-7 { target: true } answers the target ID', () => {
      expect(lookupKey(erp, sides)).toBe('T1');
    });

    it('OPS-7 { after }, { before } and { record } answer a string or number field as a string', () => {
      expect(lookupKey({ ...erp, key: { after: 'mpn' } }, sides)).toBe('12');
      expect(lookupKey({ ...erp, key: { before: 'mpn' } }, sides)).toBe('old');
      expect(lookupKey({ ...erp, key: { record: 'mpn' } }, sides)).toBe('rec');
    });

    it('OPS-7 an object value, a missing field or a null side answers undefined', () => {
      expect(lookupKey({ ...erp, key: { record: 'obj' } }, sides)).toBeUndefined();
      expect(lookupKey({ ...erp, key: { after: 'name' } }, sides)).toBeUndefined();
      expect(lookupKey({ ...erp, key: { before: 'mpn' } }, { ...sides, before: null })).toBeUndefined();
      expect(lookupKey({ ...erp, key: { after: 'mpn' } }, { ...sides, after: null })).toBeUndefined();
      expect(lookupKey({ ...erp, key: { record: 'mpn' } }, { ...sides, record: undefined })).toBeUndefined();
      expect(lookupKey({ ...erp, key: { after: 'mpn' } }, { ...sides, after: { mpn: null } })).toBeUndefined();
      expect(lookupKey({ ...erp, key: { after: 'mpn' } }, { ...sides, after: { mpn: true } })).toBeUndefined();
    });
  });

  describe('readLookups', () => {
    it('OPS-7 250 keys in chunks of 100 make three reads', async () => {
      const reader = new FakeErp();
      const keys = Array.from({ length: 250 }, (_, i) => `K${String(i)}`);
      const results = await readLookups(input(keys, reader));
      expect(reader.calls.map((c) => (c.args.codes as string[]).length)).toEqual([100, 100, 50]);
      expect(results.get('erp')?.size).toBe(250);
      expect(results.get('erp')?.get('K249')).toEqual({ code: 'K249', cost: 1 });
    });

    it('OPS-7 duplicate keys are sent once', async () => {
      const reader = new FakeErp();
      await readLookups(input(['A', 'B', 'A', 'B', 'C'], reader));
      expect(reader.calls.map((c) => c.args.codes)).toEqual([['A', 'B', 'C']]);
    });

    it('OPS-7 the read arguments carry the template values and the field list', async () => {
      const reader = new FakeErp();
      await readLookups(input(['A'], reader));
      expect(reader.calls).toEqual([{ op: 'erp.get_parts', args: { plant: 'P1', active: true, codes: ['A'], fields: ['code', 'cost', 'state'] } }]);
    });

    it('OPS-7 no keys make no read', async () => {
      const reader = new FakeErp();
      const results = await readLookups(input([], reader));
      expect(reader.calls).toEqual([]);
      expect(results.get('erp')?.size).toBe(0);
    });

    it('OPS-7 results are indexed by the key field as a string, the first wins', async () => {
      const reader = new FakeErp({
        ok: true,
        items: [{ code: 7, cost: 1 }, { code: '7', cost: 2 }, { code: { x: 1 }, cost: 3 }, { cost: 4 }],
        truncated: false,
      });
      const results = await readLookups(input(['7'], reader));
      expect([...(results.get('erp') ?? new Map()).entries()]).toEqual([['7', { code: 7, cost: 1 }]]);
    });

    it('OPS-7 a failed read rejects lookup_failed with the upstream status', async () => {
      const reader = new FakeErp({ ok: false, code: 'http_status', status: 503 });
      await expect(readLookups(input(['A'], reader))).rejects.toMatchObject({ code: 'lookup_failed', status: 503 });
    });

    it('OPS-7 a failed read without a status rejects lookup_failed without one', async () => {
      const reader = new FakeErp({ ok: false, code: 'egress_denied' });
      const err: unknown = await readLookups(input(['A'], reader)).catch((e: unknown) => e);
      expect(err).toMatchObject({ code: 'lookup_failed' });
      expect((err as { status?: number }).status).toBeUndefined();
    });

    it('OPS-7 a truncated read rejects incomplete_read, never "not found"', async () => {
      const reader = new FakeErp({ ok: true, items: [], truncated: true });
      await expect(readLookups(input(['A'], reader))).rejects.toMatchObject({ code: 'incomplete_read' });
    });

    it('OPS-7 a page with fewer items than its reported total rejects incomplete_read, never "not found"', async () => {
      const partial = new FakeErp({ ok: true, items: [{ code: 'A', cost: 1 }], total: 3, truncated: false });
      await expect(readLookups(input(['A', 'B', 'C'], partial))).rejects.toMatchObject({ code: 'incomplete_read' });
      // A total that the page meets, or none at all, is a complete answer.
      const complete = new FakeErp({ ok: true, items: [{ code: 'A', cost: 1 }], total: 1, truncated: false });
      expect((await readLookups(input(['A', 'B'], complete))).get('erp')?.size).toBe(1);
    });
  });
});
