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

describe('OPS-2 CS-3 create items', () => {
  const m: ManifestDefinition = {
    action: 'create',
    idField: 'sku',
    recordsArg: 'records',
    fields: ['brand', 'name', 'price'],
    requiredFields: ['name'],
    scopeArgs: { brand: 'brand' },
    readBefore: { operation: 'read', args: {}, idsArg: 'ids' },
    batchSize: 50,
    maxTargets: 100,
    rollback: { strategy: 'none' },
  };
  const create = (records: Record<string, unknown>[], record: Record<string, unknown>) =>
    build(records, [String(record.sku)], m, { brand: 'acme', records: [record] })[0];

  it('OPS-2 a record not found upstream is pending with before null and after its own values', () => {
    expect(create([], { sku: 'n1', brand: 'acme', name: 'N', price: 1 })).toEqual({
      targetId: 'n1',
      status: 'pending',
      before: null,
      after: { brand: 'acme', name: 'N', price: 1 },
    });
  });
  it('OPS-2 CS-3 a record found upstream is already_exists with the current values of its fields', () => {
    expect(create([{ sku: 'n1', brand: 'acme', name: 'Old', price: 9, other: 'x' }], { sku: 'n1', brand: 'acme', name: 'N' })).toEqual({
      targetId: 'n1',
      status: 'excluded',
      reason: 'already_exists',
      before: { brand: 'acme', name: 'Old' },
      after: { brand: 'acme', name: 'N' },
    });
  });
  it('OPS-2 CS-3 SEC-3 an existing record outside the call scope is already_exists without its current values', () => {
    expect(create([{ sku: 'n1', brand: 'globex', name: 'Secret' }], { sku: 'n1', brand: 'acme', name: 'N' })).toEqual({
      targetId: 'n1',
      status: 'excluded',
      reason: 'already_exists',
      before: null,
      after: { brand: 'acme', name: 'N' },
    });
  });
  it('OPS-2 CS-3 scope is checked against the new record: another value or a missing scope field is out_of_scope', () => {
    expect(create([], { sku: 'n1', brand: 'globex', name: 'N' })).toEqual({
      targetId: 'n1',
      status: 'excluded',
      reason: 'out_of_scope',
      before: null,
      after: null,
    });
    expect(create([], { sku: 'n1', name: 'N' })?.reason).toBe('out_of_scope');
  });
  it('OPS-2 CS-3 a required field missing or null in the record is missing_data', () => {
    expect(create([], { sku: 'n1', brand: 'acme', price: 1 })).toEqual({
      targetId: 'n1',
      status: 'excluded',
      reason: 'missing_data',
      before: null,
      after: null,
    });
    expect(create([], { sku: 'n1', brand: 'acme', name: null })?.reason).toBe('missing_data');
  });
});

describe('OPS-2 CS-3 delete items', () => {
  const m: ManifestDefinition = {
    action: 'delete',
    idField: 'sku',
    idsArg: 'skus',
    fields: ['name', 'price'],
    requiredFields: [],
    scopeArgs: { brand: 'brand' },
    readBefore: { operation: 'read', args: {}, idsArg: 'ids' },
    batchSize: 50,
    maxTargets: 100,
    rollback: { strategy: 'none' },
  };
  const del = (records: Record<string, unknown>[], mm: ManifestDefinition = m) =>
    build(records, ['A'], mm, { brand: 'acme', skus: ['A'] })[0];

  it('OPS-2 a found record is pending with before every manifest field (missing as null) and after null', () => {
    expect(del([{ sku: 'A', brand: 'acme', name: 'N', other: 'x' }])).toEqual({
      targetId: 'A',
      status: 'pending',
      before: { name: 'N', price: null },
      after: null,
    });
  });
  it('CS-3 a delete of a record not found is not_found', () => {
    expect(del([])).toEqual({ targetId: 'A', status: 'excluded', reason: 'not_found', before: null, after: null });
  });
  it('CS-3 a delete of a record outside the scope is out_of_scope and keeps no values', () => {
    expect(del([{ sku: 'A', brand: 'globex', name: 'N' }])).toEqual({
      targetId: 'A',
      status: 'excluded',
      reason: 'out_of_scope',
      before: null,
      after: null,
    });
  });
  it('CS-3 a delete of a record without a required field is missing_data', () => {
    expect(del([{ sku: 'A', brand: 'acme', price: 1 }], { ...m, requiredFields: ['name'] })).toEqual({
      targetId: 'A',
      status: 'excluded',
      reason: 'missing_data',
      before: null,
      after: null,
    });
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
