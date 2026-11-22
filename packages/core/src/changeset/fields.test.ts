// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Mandate Authors
import { describe, expect, it } from 'vitest';
import type { ManifestDefinition } from '../policy-model.js';
import { callRecords, itemFields, manifestAction } from './fields.js';
import { touchedFields } from './items.js';

const manifest: ManifestDefinition = {
  idField: 'sku',
  valuesArg: 'changes',
  fields: ['name', 'description'],
  requiredFields: [],
  scopeArgs: {},
  readBefore: { operation: 'read', args: {}, idsArg: 'ids' },
  batchSize: 50,
  maxTargets: 100,
  rollback: { strategy: 'replay_previous_state' },
};
/** A records manifest: built without a `valuesArg` key (exactOptionalPropertyTypes). */
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
/** The entries of `callRecords`; throws when it answers undefined. */
function recordsOf(manifest: ManifestDefinition, a: Readonly<Record<string, unknown>>): [string, unknown][] {
  const records = callRecords(manifest, a);
  if (records === undefined) throw new Error('expected records');
  return [...records];
}
const args = { records: [{ sku: 'b', price: 2 }, { sku: 'a', name: 'A', price: 1 }] };

describe('CS-2 per-record values', () => {
  it('CS-2 callRecords maps each target to its own values in manifest field order, without the id field', () => {
    expect(recordsOf(m, args)).toEqual([
      ['b', { price: 2 }],
      ['a', { name: 'A', price: 1 }],
    ]);
  });
  it('CS-2 callRecords is undefined without records_arg', () => {
    expect(callRecords(manifest, { changes: { name: 'n' } })).toBeUndefined();
  });
  it('CS-2 callRecords turns a numeric identifier into a string and drops keys outside the manifest fields', () => {
    expect(recordsOf(m, { records: [{ sku: 7, price: 3, other: 'x' }] })).toEqual([['7', { price: 3 }]]);
  });
  it('CS-2 touchedFields of a records call is the union over the records, in manifest field order', () => {
    expect(touchedFields(m, args)).toEqual(['name', 'price']);
    expect(touchedFields(m, { records: [{ sku: 'b', price: 2 }] })).toEqual(['price']);
  });
  it('CS-2 touchedFields of a values call is unchanged', () => {
    expect(touchedFields(manifest, { changes: { description: 'd', name: 'n' } })).toEqual(['name', 'description']);
  });
  it('CS-2 itemFields are the manifest fields of after, else of before, else none', () => {
    expect(itemFields(m, { before: { price: 1 }, after: { price: 2 } })).toEqual(['price']);
    expect(itemFields(m, { before: { name: 'x', price: 1 }, after: null })).toEqual(['name', 'price']);
    expect(itemFields(m, { before: null, after: null })).toEqual([]);
    expect(itemFields(m, { before: { other: 1 }, after: { other: 2, price: 3 } })).toEqual(['price']);
  });
});

describe('OPS-2 manifest action', () => {
  it('OPS-2 an absent action is update', () => {
    expect(manifestAction(manifest)).toBe('update');
    expect(manifestAction({ ...manifest, action: 'create' })).toBe('create');
  });
});
