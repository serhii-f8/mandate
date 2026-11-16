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
});
