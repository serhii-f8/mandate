// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Mandate Authors
import { describe, expect, it } from 'vitest';
import type { CheckPredicate, ManifestCheck } from '../policy-model.js';
import { checkRecordFields, failedCheck, type CheckContext } from './checks.js';

const ctx: CheckContext = {
  before: { price: 1 },
  after: { price: 2, name: '' },
  record: { status: 1, locked: false },
  args: { brand: 'acme' },
  lookups: { erp: { cost: 5 }, pim: undefined },
};
const run = (require: CheckPredicate[]) => failedCheck([{ code: 'c', require }], ctx);

describe('CS-3 preparation checks', () => {
  it('CS-3 present and absent: null, missing and the empty string are not present', () => {
    expect(run([{ present: { after: 'price' } }])).toBeUndefined();
    expect(run([{ present: { after: 'name' } }])).toBe('c'); // '' is not present
    expect(run([{ absent: { record: 'missing' } }])).toBeUndefined();
    expect(run([{ absent: { after: 'name' } }])).toBeUndefined();
    expect(run([{ absent: { before: 'price' } }])).toBe('c');
  });

  it('CS-3 equals compares canonical JSON with null and missing equal', () => {
    expect(run([{ equals: [{ record: 'locked' }, { value: false }] }])).toBeUndefined();
    expect(run([{ equals: [{ before: 'nope' }, { value: null }] }])).toBeUndefined(); // null ≡ missing
    expect(run([{ equals: [{ before: 'nope' }, { record: 'nope' }] }])).toBeUndefined();
    expect(run([{ equals: [{ before: 'price' }, { value: '1' }] }])).toBe('c');
    expect(run([{ equals: [{ arg: 'brand' }, { value: 'acme' }] }])).toBeUndefined();
  });

  it('CS-3 in compares strictly, without coercion', () => {
    expect(run([{ in: { record: 'status' }, values: [1, 2] }])).toBeUndefined();
    expect(run([{ in: { record: 'status' }, values: ['1'] }])).toBe('c'); // no coercion
    expect(run([{ in: { record: 'missing' }, values: [1] }])).toBe('c');
  });

  it('CS-3 OPS-7 lookup predicates and references', () => {
    expect(run([{ found: 'erp' }, { not_found: 'pim' }])).toBeUndefined();
    expect(run([{ found: 'pim' }])).toBe('c');
    expect(run([{ not_found: 'erp' }])).toBe('c');
    expect(run([{ found: 'undeclared' }])).toBe('c');
    expect(run([{ present: { lookup: 'pim', field: 'x' } }])).toBe('c');
    expect(run([{ present: { lookup: 'erp', field: 'cost' } }])).toBeUndefined();
    expect(run([{ equals: [{ after: 'price' }, { lookup: 'erp', field: 'cost' }] }])).toBe('c');
  });

  it('CS-3 a create has no current record and a null before side', () => {
    const create: CheckContext = { ...ctx, before: null, record: undefined };
    expect(failedCheck([{ code: 'c', require: [{ absent: { record: 'status' } }, { absent: { before: 'price' } }] }], create)).toBeUndefined();
    expect(failedCheck([{ code: 'c', require: [{ present: { record: 'status' } }] }], create)).toBe('c');
  });

  it('CS-3 a value that cannot be compared makes the predicate false, never a throw', () => {
    // Review Focus 7: not comparable is false, never a throw
    expect(
      failedCheck([{ code: 'c', require: [{ equals: [{ arg: 'brand' }, { value: 1 }] }] }], { ...ctx, args: { brand: Number.NaN } }),
    ).toBe('c');
    expect(
      failedCheck([{ code: 'c', require: [{ equals: [{ arg: 'brand' }, { arg: 'brand' }] }] }], { ...ctx, args: { brand: Number.NaN } }),
    ).toBe('c');
    expect(failedCheck([{ code: 'c', require: [{ in: { arg: 'brand' }, values: [1] }] }], { ...ctx, args: { brand: Number.NaN } })).toBe('c');
  });

  it('CS-3 the first failing check names the reason; no checks pass', () => {
    // order: the first failing check names the reason
    expect(failedCheck([{ code: 'a', require: [{ found: 'pim' }] }, { code: 'b', require: [{ found: 'pim' }] }], ctx)).toBe('a');
    expect(failedCheck([{ code: 'a', require: [{ found: 'erp' }] }, { code: 'b', require: [{ found: 'pim' }] }], ctx)).toBe('b');
    expect(failedCheck([], ctx)).toBeUndefined();
  });

  it('CS-3 checkRecordFields lists the distinct record fields in order of appearance', () => {
    const checks: ManifestCheck[] = [
      { code: 'a', require: [{ present: { record: 'status' } }, { equals: [{ after: 'x' }, { record: 'locked' }] }] },
      { code: 'b', require: [{ in: { record: 'status' }, values: [1] }, { absent: { lookup: 'erp', field: 'record' } }] },
    ];
    expect(checkRecordFields(checks)).toEqual(['status', 'locked']);
    expect(checkRecordFields([])).toEqual([]);
  });
});
