// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Mandate Authors
import { describe, expect, it } from 'vitest';
import type { ManifestDefinition } from '../policy-model.js';
import { buildItems, touchedFields } from './items.js';

const manifest: ManifestDefinition = {
  idField: 'sku',
  valuesArg: 'changes',
  fields: ['name', 'description'],
  requiredFields: [],
  scopeArgs: { brand: 'brand' },
  readBefore: { operation: 'read', args: {}, idsArg: 'ids' },
  batchSize: 50,
  maxTargets: 100,
  rollback: { strategy: 'replay_previous_state' },
};
const args = { brand: 'acme', changes: { description: 'new' } };
const build = (
  records: Record<string, unknown>[],
  targetIds: string[],
  m: ManifestDefinition = manifest,
  a: Record<string, unknown> = args,
) => buildItems({ manifest: m, args: a, targetIds, records });

describe('CS-2 before and after values', () => {
  it('CS-2 stores only touched fields', () => {
    expect(build([{ sku: 'A', brand: 'acme', description: 'old', name: 'n' }], ['A'])).toEqual([
      { targetId: 'A', status: 'pending', before: { description: 'old' }, after: { description: 'new' } },
    ]);
  });
  it('CS-2 absent field is null before', () => {
    expect(build([{ sku: 'A', brand: 'acme' }], ['A'])[0]?.before).toEqual({ description: null });
  });
  it('CS-2 numeric record id matches string target; unrequested records ignored; first duplicate wins', () => {
    const items = build(
      [
        { sku: 9, brand: 'acme', description: 'x' },
        { sku: 1, brand: 'acme', description: 'first' },
        { sku: 1, brand: 'acme', description: 'second' },
        { brand: 'acme' },
      ],
      ['1'],
    );
    expect(items).toHaveLength(1);
    expect(items[0]?.before).toEqual({ description: 'first' });
  });
  it('CS-2 keeps target order', () => {
    const items = build([{ sku: 'A', brand: 'acme' }, { sku: 'B', brand: 'acme' }], ['B', 'A']);
    expect(items.map((i) => i.targetId)).toEqual(['B', 'A']);
  });
  it('CS-2 touchedFields follows manifest field order', () => {
    expect(touchedFields(manifest, { changes: { description: 'd', name: 'n' } })).toEqual(['name', 'description']);
  });
});

describe('CS-2 per-record values', () => {
  const m: ManifestDefinition = {
    idField: 'sku',
    recordsArg: 'records',
    fields: ['name', 'price'],
    requiredFields: [],
    scopeArgs: {},
    readBefore: { operation: 'read', args: {}, idsArg: 'ids' },
    batchSize: 50,
    maxTargets: 100,
    rollback: { strategy: 'replay_previous_state' },
  };
  const recordArgs = { records: [{ sku: 'b', price: 2 }, { sku: 'a', name: 'A', price: 1 }] };

  it('CS-2 each item compares and stores only the fields its own record gives', () => {
    const items = build(
      [
        { sku: 'a', name: 'A', price: 1 },
        { sku: 'b', price: 1 },
      ],
      ['a', 'b'],
      m,
      recordArgs,
    );
    expect(items).toEqual([
      { targetId: 'a', status: 'excluded', reason: 'no_change', before: { name: 'A', price: 1 }, after: { name: 'A', price: 1 } },
      { targetId: 'b', status: 'pending', before: { price: 1 }, after: { price: 2 } },
    ]);
  });
});

describe('CS-3 excluded targets', () => {
  it('CS-3 not_found', () => {
    expect(build([], ['B'])[0]).toEqual({ targetId: 'B', status: 'excluded', reason: 'not_found', before: null, after: null });
  });
  it('CS-3 out_of_scope keeps no values', () => {
    expect(build([{ sku: 'B', brand: 'globex', description: 'secret' }], ['B'])[0]).toEqual({
      targetId: 'B',
      status: 'excluded',
      reason: 'out_of_scope',
      before: null,
      after: null,
    });
  });
  it('CS-3 array scope argument accepts any element', () => {
    const items = build([{ sku: 'A', brand: 'acme' }, { sku: 'B', brand: 'globex' }], ['A', 'B'], manifest, {
      brand: ['acme', 'globex'],
      changes: { description: 'new' },
    });
    expect(items.map((i) => i.status)).toEqual(['pending', 'pending']);
  });
  it('CS-3 missing_data when required field null or absent', () => {
    const m = { ...manifest, requiredFields: ['name'] };
    const items = build([{ sku: 'A', brand: 'acme', name: null }, { sku: 'B', brand: 'acme' }], ['A', 'B'], m);
    expect(items.map((i) => i.reason)).toEqual(['missing_data', 'missing_data']);
    expect(items[0]?.before).toBeNull();
  });
  it('CS-3 no_change keeps values, deep equality', () => {
    expect(build([{ sku: 'A', brand: 'acme', description: 'new' }], ['A'])[0]).toEqual({
      targetId: 'A',
      status: 'excluded',
      reason: 'no_change',
      before: { description: 'new' },
      after: { description: 'new' },
    });
    const m = { ...manifest, fields: ['description'] };
    const a = { brand: 'acme', changes: { description: { a: [1, { b: 2 }], c: 'x' } } };
    const same = build([{ sku: 'A', brand: 'acme', description: { c: 'x', a: [1, { b: 2 }] } }], ['A'], m, a);
    expect(same[0]?.reason).toBe('no_change');
    const diff = build([{ sku: 'A', brand: 'acme', description: { c: 'x', a: [1, { b: 3 }] } }], ['A'], m, a);
    expect(diff[0]?.status).toBe('pending');
  });
});
