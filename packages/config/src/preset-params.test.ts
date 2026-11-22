// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Mandate Authors
import { describe, expect, it } from 'vitest';
import { PARSE_PARAMS, schemaIssues } from './schema.js';
import { presetParamsSchema, resolveParamValues, substituteParams } from './preset-params.js';

describe('CONN-8 preset parameters', () => {
  const decls = { scope: { type: 'string', default: 'brand' }, fields: { type: 'string_list', default: ['sku'] } } as const;

  it('CONN-8 fills defaults, takes given values and refuses unknown names and wrong types', () => {
    expect(resolveParamValues(decls, undefined)).toEqual({ ok: true, values: { scope: 'brand', fields: ['sku'] } });
    expect(resolveParamValues(decls, { scope: 'vendor' })).toMatchObject({ ok: true, values: { scope: 'vendor' } });
    expect(resolveParamValues(decls, { scope: 3 })).toMatchObject({ ok: false, issues: [{ path: ['scope'], message: 'must be a string' }] });
    expect(resolveParamValues(decls, { nope: 'x' })).toMatchObject({ ok: false, issues: [{ path: ['nope'] }] });
    expect(resolveParamValues(decls, { nope: 'x' })).toMatchObject({ ok: false, issues: [{ message: 'is not a parameter of the preset' }] });
  });

  it('CONN-8 rejects instead of coercing: a string for a list, a numeric string for a number, objects and nested lists', () => {
    const typed = {
      n: { type: 'number', default: 1 },
      b: { type: 'boolean', default: false },
      l: { type: 'string_list', default: [] },
      s: { type: 'string', default: '' },
    } as const;
    const refused: [string, unknown, string][] = [
      ['l', 'a', 'must be a string_list'],
      ['n', '5', 'must be a number'],
      ['b', 'true', 'must be a boolean'],
      ['s', { a: 1 }, 'must be a string'],
      ['l', [['a']], 'must be a string_list'],
      ['l', ['a', 1], 'must be a string_list'],
      ['n', Number.NaN, 'must be a number'],
      ['s', 'x'.repeat(4001), 'must be at most 4000 characters'],
      ['l', Array.from({ length: 501 }, () => 'a'), 'must have at most 500 items'],
    ];
    for (const [name, value, message] of refused) {
      expect(resolveParamValues(typed, { [name]: value })).toEqual({ ok: false, issues: [{ path: [name], message }] });
    }
    expect(resolveParamValues(typed, { n: 2.5, b: true, l: ['x'], s: 'y' })).toEqual({ ok: true, values: { n: 2.5, b: true, l: ['x'], s: 'y' } });
  });

  it('CONN-8 a name inherited from Object.prototype is not a parameter', () => {
    expect(resolveParamValues(decls, { constructor: 'x' })).toMatchObject({ ok: false, issues: [{ path: ['constructor'] }] });
  });

  it('CONN-8 substitutes { $param } mappings only, keeps a list value as one element and reports undeclared names', () => {
    expect(substituteParams({ q: { field: { $param: 'scope' } }, enum: { $param: 'fields' }, keep: { $param: 'scope', other: 1 } }, { scope: 'vendor', fields: ['a', 'b'] })).toEqual({
      ok: true,
      value: { q: { field: 'vendor' }, enum: ['a', 'b'], keep: { $param: 'scope', other: 1 } },
    });
    expect(substituteParams({ x: { $param: 'missing' } }, {})).toEqual({ ok: false, unknown: ['missing'] });
    expect(substituteParams([{ $param: 'fields' }, 'c'], { fields: ['a', 'b'] })).toEqual({ ok: true, value: [['a', 'b'], 'c'] });
  });

  it('CONN-8 substitution is a deep copy: neither the node nor the values are shared with the result', () => {
    const shared = { field: { $param: 'scope' } };
    const node = { a: shared, b: shared, list: { $param: 'fields' } };
    const values = { scope: 'vendor', fields: ['a'] };
    const result = substituteParams(node, values);
    if (!result.ok) throw new Error('expected substitution');
    const value = result.value as { a: { field: string }; b: { field: string }; list: string[] };
    expect(value.a).not.toBe(value.b);
    expect(value.list).not.toBe(values.fields);
    expect(node.a.field).toEqual({ $param: 'scope' });
  });

  it('CONN-8 SEC-5 a substituted value never introduces another { $param }: substitution is single-pass', () => {
    // resolveParamValues never yields a mapping; this forces one to show the value is not walked.
    const hostile = { $param: 'q' } as unknown as string;
    expect(substituteParams({ a: { $param: 'p' } }, { p: hostile, q: 'leak' })).toEqual({ ok: true, value: { a: { $param: 'q' } } });
    expect(substituteParams({ a: { $param: 'p' } }, { p: '{ $param: q }', q: 'leak' })).toEqual({ ok: true, value: { a: '{ $param: q }' } });
  });

  it('CONN-8 a $param whose name is not a string is left alone as data', () => {
    expect(substituteParams({ a: { $param: 5 } }, {})).toEqual({ ok: true, value: { a: { $param: 5 } } });
  });

  it('CONN-8 the declaration schema refuses a default of another type at params.<name>.default', () => {
    const parsed = presetParamsSchema.safeParse(
      { scope: { type: 'string', default: 5 }, ok: { type: 'string_list', default: ['a'], description: 'Fields.' } },
      PARSE_PARAMS,
    );
    expect(schemaIssues(parsed).map((i) => i.path)).toEqual([['scope', 'default']]);
    expect(presetParamsSchema.safeParse({ Bad: { type: 'string', default: '' } }, PARSE_PARAMS).success).toBe(false);
    expect(presetParamsSchema.safeParse({ s: { type: 'string', default: '', extra: 1 } }, PARSE_PARAMS).success).toBe(false);
    expect(presetParamsSchema.safeParse({ s: { type: 'object', default: {} } }, PARSE_PARAMS).success).toBe(false);
    const many = Object.fromEntries(Array.from({ length: 51 }, (_, i) => [`p${String(i)}`, { type: 'boolean', default: true }]));
    expect(presetParamsSchema.safeParse(many, PARSE_PARAMS).success).toBe(false);
  });
});
