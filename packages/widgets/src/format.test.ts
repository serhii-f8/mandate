// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The AI Operations Layer Authors
import { describe, expect, it } from 'vitest';
import { displayValue, fieldRows, formatDateTime, plural, shortHash } from './format.js';

describe('widgets formatting', () => {
  it('SEC-5 displayValue shows strings as they are and everything else as JSON text', () => {
    expect(displayValue('<b>x</b>')).toBe('<b>x</b>');
    expect(displayValue({ a: 1 })).toBe(JSON.stringify({ a: 1 }, null, 2));
    expect(displayValue(undefined)).toBe('');
    expect(displayValue(null)).toBe('null');
  });
  it('UI-3 fieldRows gives one row per changed field, sorted', () => {
    const rows = fieldRows({
      before: { name: 'a', desc: 'x', sku: 1 },
      after: { name: 'b', desc: 'y', sku: 1 },
    });
    expect(rows.map((r) => r.field)).toEqual(['desc', 'name']);
  });
  it('UI-3 fieldRows gives one row without a field for non-object values', () => {
    expect(fieldRows({ before: 1, after: 2 })).toEqual([{ before: '1', after: '2' }]);
  });
  it('APR-6 plural states the count', () => {
    expect(plural(1, 'change')).toBe('1 change');
    expect(plural(3, 'change')).toBe('3 changes');
    expect(plural(0, 'change')).toBe('0 changes');
  });
  it('UI-3 shortHash and formatDateTime', () => {
    expect(shortHash('sha256:' + '6114edb2' + 'a'.repeat(56))).toBe('sha256:6114edb2…');
    const s = formatDateTime('2030-11-18T14:00:00.000Z', 'UTC');
    expect(s).toContain('18 Nov');
    expect(s).toContain('14:00');
    expect(formatDateTime('nope')).toBe('nope');
  });
});
