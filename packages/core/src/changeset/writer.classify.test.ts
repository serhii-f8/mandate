// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Mandate Authors
import { describe, expect, it } from 'vitest';
import type { ManifestDefinition } from '../policy-model.js';
import { classifyForRollback, classifyForWrite } from './writer.js';

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
const item = { before: { description: 'old' }, after: { description: 'new' } };
const base = { sku: 'A', brand: 'acme' };
const classify = (
  current: Record<string, unknown> | undefined,
  over: {
    item?: { before: unknown; after: unknown };
    args?: Record<string, unknown>;
  } = {},
) => classifyForWrite({ manifest, args: over.args ?? args, item: over.item ?? item, current });
const WRITE = { action: 'write' };
const outcome = (status: string, error: string) => ({ action: 'outcome', status, error });

describe('CS-7 NFR-2 classifyForWrite', () => {
  it('CS-7 write when the current value equals before', () => {
    expect(classify({ ...base, description: 'old' })).toEqual(WRITE);
  });
  it('NFR-2 already_applied when the current value equals after', () => {
    expect(classify({ ...base, description: 'new' })).toEqual(outcome('written', 'already_applied'));
  });
  it('CS-7 drift when the current value is neither before nor after', () => {
    expect(classify({ ...base, description: 'other' })).toEqual(outcome('skipped', 'drift'));
  });
  it('CS-7 gone when the record is missing from the read', () => {
    expect(classify(undefined)).toEqual(outcome('skipped', 'gone'));
  });
  it('CS-7 gone when the scope recheck fails', () => {
    expect(classify({ ...base, brand: 'globex', description: 'old' })).toEqual(outcome('skipped', 'gone'));
  });
  it('CS-7 an untouched field is ignored', () => {
    expect(classify({ ...base, name: 'changed elsewhere', description: 'old' })).toEqual(WRITE);
  });
  it('CS-7 absent equals null before', () => {
    expect(classify(base, { item: { before: { description: null }, after: { description: 'new' } } })).toEqual(WRITE);
  });
  it('NFR-2 absent equals null after', () => {
    expect(classify(base, { item: { before: { description: 'old' }, after: { description: null } } })).toEqual(
      outcome('written', 'already_applied'),
    );
  });
  it('CS-7 drift when a number is compared with its string form', () => {
    expect(
      classify({ ...base, description: 1 }, { item: { before: { description: '1' }, after: { description: 'new' } } }),
    ).toEqual(outcome('skipped', 'drift'));
  });
  it('CS-7 drift when an empty string is compared with null', () => {
    expect(
      classify({ ...base, description: '' }, { item: { before: { description: null }, after: { description: 'new' } } }),
    ).toEqual(outcome('skipped', 'drift'));
  });
  it('CS-7 drift when one touched field equals after and another equals before', () => {
    const two = { brand: 'acme', changes: { name: 'N2', description: 'new' } };
    const both = { before: { name: 'N1', description: 'old' }, after: { name: 'N2', description: 'new' } };
    expect(classify({ ...base, name: 'N2', description: 'old' }, { args: two, item: both })).toEqual(
      outcome('skipped', 'drift'),
    );
  });
  it('CS-7 object values compare by canonical JSON, ignoring key order', () => {
    const o = { brand: 'acme', changes: { description: { a: 1, b: 2 } } };
    const objs = { before: { description: { x: 1, y: 2 } }, after: { description: { a: 1, b: 2 } } };
    expect(classify({ ...base, description: { b: 2, a: 1 } }, { args: o, item: objs })).toEqual(
      outcome('written', 'already_applied'),
    );
    expect(classify({ ...base, description: { y: 2, x: 1 } }, { args: o, item: objs })).toEqual(WRITE);
  });
});

describe('CS-2 per-record values', () => {
  const m: ManifestDefinition = {
    idField: 'sku',
    recordsArg: 'records',
    fields: ['name', 'price'],
    requiredFields: [],
    scopeArgs: { brand: 'brand' },
    readBefore: { operation: 'read', args: {}, idsArg: 'ids' },
    batchSize: 50,
    maxTargets: 100,
    rollback: { strategy: 'replay_previous_state' },
  };
  const recordArgs = { brand: 'acme', records: [{ sku: 'a', name: 'A', price: 1 }, { sku: 'b', price: 2 }] };
  const b = { before: { price: 1 }, after: { price: 2 } };

  it('CS-2 CS-7 an item is compared over its own fields: a field another record touches is ignored', () => {
    const current = { sku: 'b', brand: 'acme', name: 'anything', price: 1 };
    expect(classifyForWrite({ manifest: m, args: recordArgs, item: b, current })).toEqual(WRITE);
    expect(classifyForWrite({ manifest: m, args: recordArgs, item: b, current: { ...current, price: 2 } })).toEqual(
      outcome('written', 'already_applied'),
    );
    expect(classifyForWrite({ manifest: m, args: recordArgs, item: b, current: { ...current, price: 3 } })).toEqual(
      outcome('skipped', 'drift'),
    );
  });
});

describe('CS-7 EXE-8 rollback classification', () => {
  const back = (
    current: Record<string, unknown> | undefined,
    over: { item?: { before: unknown; after: unknown } } = {},
  ) => classifyForRollback({ manifest, args, item: over.item ?? item, current });

  it('EXE-8 CS-7 current at after is a write, at before is already_restored, gone is gone, anything else is drift', () => {
    expect(back({ ...base, description: 'new' })).toEqual(WRITE);
    expect(back({ ...base, description: 'old' })).toEqual(outcome('written', 'already_restored'));
    expect(back(undefined)).toEqual(outcome('skipped', 'gone'));
    expect(back({ ...base, description: 'other' })).toEqual(outcome('skipped', 'drift'));
    // Absent and null are the same value on the way back too.
    expect(back(base, { item: { before: { description: 'old' }, after: { description: null } } })).toEqual(WRITE);
    expect(back(base, { item: { before: { description: null }, after: { description: 'new' } } })).toEqual(
      outcome('written', 'already_restored'),
    );
    // A record that left the change-set's scope is gone, whatever its value.
    expect(back({ ...base, brand: 'globex', description: 'new' })).toEqual(outcome('skipped', 'gone'));
  });
});
