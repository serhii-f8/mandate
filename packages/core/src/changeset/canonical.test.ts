import { describe, expect, it } from 'vitest';
import { canonicalJson, compareTargetIds, normalizeArgs } from './canonical.js';

describe('CS-4 canonical JSON', () => {
  it('CS-4 sorts keys and emits no whitespace', () => {
    expect(canonicalJson({ b: 1, a: [true, null, 'x'] })).toBe('{"a":[true,null,"x"],"b":1}');
  });
  it('CS-4 sorts nested keys', () => {
    expect(canonicalJson({ z: { b: 1, a: 2 }, a: [{ d: 1, c: 2 }] })).toBe('{"a":[{"c":2,"d":1}],"z":{"a":2,"b":1}}');
  });
  it('CS-4 orders keys by UTF-16 code units', () => {
    expect(canonicalJson({ é: 2, z: 1 })).toBe('{"z":1,"é":2}');
  });
  it('CS-4 key order is UTF-16, not code point (RFC 8785)', () => {
    expect(canonicalJson({ '￿': 2, '\u{1F600}': 1 })).toBe('{"\u{1F600}":1,"￿":2}');
  });
  it('CS-4 writes negative zero as 0', () => {
    expect(canonicalJson(-0)).toBe('0');
  });
  it('CS-4 rejects non-plain objects and sparse arrays', () => {
    class C {
      readonly x = 1;
    }
    expect(() => canonicalJson(new Date(0))).toThrow(TypeError);
    expect(() => canonicalJson(new Map())).toThrow(TypeError);
    expect(() => canonicalJson(new Set())).toThrow(TypeError);
    expect(() => canonicalJson(new C())).toThrow(TypeError);
    // eslint-disable-next-line no-sparse-arrays -- the hole is the case under test
    expect(() => canonicalJson([1, , 2])).toThrow(TypeError);
    expect(canonicalJson(Object.create(null) as object)).toBe('{}');
  });
  it('CS-4 rejects values without a JSON form', () => {
    expect(() => canonicalJson({ a: undefined })).toThrow(TypeError);
    expect(() => canonicalJson(Number.NaN)).toThrow(TypeError);
    expect(() => canonicalJson(Number.POSITIVE_INFINITY)).toThrow(TypeError);
    expect(() => canonicalJson(1n)).toThrow(TypeError);
    expect(() => canonicalJson(() => 1)).toThrow(TypeError);
    expect(() => canonicalJson(Symbol('s'))).toThrow(TypeError);
  });
});

describe('CS-4 target id order and argument normalization', () => {
  it('CS-4 compares by code point, not UTF-16 unit', () => {
    expect(compareTargetIds('\u{1F600}', '￿')).toBeGreaterThan(0);
    expect(compareTargetIds('A', 'B')).toBeLessThan(0);
    expect(compareTargetIds('A', 'A')).toBe(0);
    expect(compareTargetIds('A', 'AB')).toBeLessThan(0);
  });
  it('CS-4 normalizes the id argument: strings, unique, sorted', () => {
    expect(normalizeArgs({ skus: ['B', 'A', 'B', 1, '1'], changes: { x: 'y' } }, 'skus')).toEqual({
      skus: ['1', 'A', 'B'],
      changes: { x: 'y' },
    });
  });
  it('CS-4 rejects id elements that are neither string nor number', () => {
    for (const bad of [null, true, {}, ['a'], undefined]) {
      expect(() => normalizeArgs({ skus: ['A', bad] }, 'skus')).toThrow(TypeError);
    }
  });
  it('CS-4 returns a copy and leaves args untouched without an ids argument', () => {
    const args = { skus: ['b', 'a'] };
    expect(normalizeArgs(args, undefined)).toEqual({ skus: ['b', 'a'] });
    expect(normalizeArgs(args, undefined)).not.toBe(args);
    normalizeArgs(args, 'skus');
    expect(args.skus).toEqual(['b', 'a']);
  });
});
