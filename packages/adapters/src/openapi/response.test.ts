import { describe, expect, it } from 'vitest';
import { mapResponse } from './response.js';
import { MappingError } from './request.js';

const magento = {
  items: [{ sku: 'A1', name: 'n', custom_attributes: [{ attribute_code: 'brand', value: 'acme' }, { attribute_code: 'cost', value: '5' }] }],
  total_count: 1,
};
const flatten = { path: 'custom_attributes', key: 'attribute_code', value: 'value' };

describe('MCP-4 response mapping', () => {
  it('follows items, flattens, reports total', () => {
    const r = mapResponse({ items: 'items', total: 'total_count', flatten, maxItems: 100 }, magento, {});
    expect(r.total).toBe(1);
    expect(r.items?.[0]).toMatchObject({ sku: 'A1', brand: 'acme', cost: '5' });
    expect(r.items?.[0]).not.toHaveProperty('custom_attributes');
    expect(r.truncated).toBe(false);
  });
  it('caps items and flags truncated', () => {
    const body = { items: Array.from({ length: 150 }, (_, i) => ({ i })) };
    const r = mapResponse({ items: 'items', maxItems: 100 }, body, {});
    expect(r.items).toHaveLength(100);
    expect(r.truncated).toBe(true);
  });
  it('truncates long strings deeply, also in value', () => {
    const r = mapResponse({ maxItems: 100 }, { a: { b: 'x'.repeat(5000) } }, {});
    expect((r.value as { a: { b: string } }).a.b).toBe('x'.repeat(4000) + '…[truncated]');
  });
  it('flattened keys never overwrite existing keys', () => {
    const r = mapResponse(
      { items: 'items', flatten, maxItems: 10 },
      { items: [{ sku: 'S', custom_attributes: [{ attribute_code: 'sku', value: 'evil' }] }] },
      {},
    );
    expect(r.items?.[0]?.sku).toBe('S');
  });
  it('throws when items path is not an array', () => {
    expect(() => mapResponse({ items: 'x', maxItems: 1 }, { x: 1 }, {})).toThrow(new MappingError('response items path is not an array'));
  });
  it('treats whole body as value when items unset; total only if finite number', () => {
    const r = mapResponse({ total: 'n', maxItems: 1 }, { n: 'x' }, {});
    expect(r.value).toEqual({ n: 'x' });
    expect(r.total).toBeUndefined();
  });
});

describe('POL-3 projection keeps unrequested fields out', () => {
  it('keeps exactly the requested keys', () => {
    const r = mapResponse({ items: 'items', total: 'total_count', flatten, fieldsFromArg: 'fields', maxItems: 100 }, magento, { fields: ['sku', 'brand', 'nope'] });
    expect(r.items).toEqual([{ sku: 'A1', brand: 'acme' }]);
    expect(JSON.stringify(r)).not.toContain('cost');
  });
  it('fails closed when the fields argument is missing or malformed', () => {
    const m = { items: 'items', fieldsFromArg: 'fields', maxItems: 10 };
    const err = new MappingError('fields argument is missing');
    expect(() => mapResponse(m, magento, {})).toThrow(err);
    expect(() => mapResponse(m, magento, { fields: 'sku' })).toThrow(err);
    expect(() => mapResponse(m, magento, { fields: ['sku', 1] })).toThrow(err);
  });
  it('an empty fields array yields items with no keys', () => {
    const r = mapResponse({ items: 'items', fieldsFromArg: 'fields', maxItems: 10 }, magento, { fields: [] });
    expect(r.items).toEqual([{}]);
  });
  it('treats __proto__ as data in flatten and projection', () => {
    const body = { items: [{ a: 1, e: [{ k: '__proto__', v: 'x' }] }] };
    const r = mapResponse({ items: 'items', flatten: { path: 'e', key: 'k', value: 'v' }, fieldsFromArg: 'f', maxItems: 5 }, body, { f: ['a', '__proto__'] });
    expect(Object.getPrototypeOf(r.items?.[0])).toBe(Object.prototype);
    expect(Object.keys(r.items?.[0] ?? {})).toEqual(['a', '__proto__']);
    expect(({} as Record<string, unknown>).x).toBeUndefined();
  });
  it('drops non-object items when projection is configured', () => {
    const r = mapResponse({ items: 'items', fieldsFromArg: 'f', maxItems: 5 }, { items: ['s', 2, { a: 1, b: 2 }] }, { f: ['a'] });
    expect(r.items).toEqual([{ a: 1 }]);
  });
  it('returns non-object items unchanged without projection', () => {
    const r = mapResponse({ items: 'items', maxItems: 5 }, { items: ['s', 2] }, {});
    expect(r.items).toEqual(['s', 2]);
  });
  it('flattens and projects a single-object response', () => {
    const body = { sku: 'A', cost: 5, custom_attributes: [{ attribute_code: 'cost', value: 9 }] };
    const r = mapResponse({ flatten, fieldsFromArg: 'fields', maxItems: 1 }, body, { fields: ['sku'] });
    expect(r.value).toEqual({ sku: 'A' });
    expect(JSON.stringify(r)).not.toContain('cost');
  });
  it('fails closed for a single-object response when the fields argument is missing', () => {
    expect(() => mapResponse({ fieldsFromArg: 'fields', maxItems: 1 }, { sku: 'A' }, {})).toThrow(new MappingError('fields argument is missing'));
  });
  it('a projected single response that is not an object yields no value', () => {
    const r = mapResponse({ fieldsFromArg: 'fields', maxItems: 1 }, 'secret', { fields: ['sku'] });
    expect(r.value).toEqual({});
  });
  it('flattens a single-object response without projection', () => {
    const r = mapResponse({ flatten, maxItems: 1 }, { sku: 'A', custom_attributes: [{ attribute_code: 'brand', value: 'x' }] }, {});
    expect(r.value).toEqual({ sku: 'A', brand: 'x' });
  });
});
