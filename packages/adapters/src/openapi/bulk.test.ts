import { describe, expect, it } from 'vitest';
import { buildBulkBody, extractBatchId, isSafeBatchId, mapBulkStatus } from './bulk.js';

describe('OPS-6 bulk body and status mapping', () => {
  const NEST = { path: 'custom_attributes', key: 'attribute_code', value: 'value', keep: ['sku', 'name', 'status'] };
  it('OPS-6 wraps each record and nests fields outside keep, in record key order', () => {
    expect(buildBulkBody({ wrap: 'product', nest: NEST }, [{ sku: 'A', status: 2, description: 'D', name: 'N', meta_title: 'T' }]))
      .toEqual([{ product: { sku: 'A', status: 2, name: 'N', custom_attributes: [
        { attribute_code: 'description', value: 'D' }, { attribute_code: 'meta_title', value: 'T' }] } }]);
  });
  it('OPS-6 omits the nest path when nothing is nested, and passes records unchanged without wrap and nest', () => {
    expect(buildBulkBody({ wrap: 'product', nest: NEST }, [{ sku: 'A', status: 1 }])).toEqual([{ product: { sku: 'A', status: 1 } }]);
    expect(buildBulkBody({}, [{ id: 1, x: 'y' }])).toEqual([{ id: 1, x: 'y' }]);
  });
  it('OPS-6 keeps a __proto__ field as plain data', () => {
    const out = buildBulkBody({ wrap: 'p' }, [JSON.parse('{"__proto__":{"x":1},"sku":"A"}') as Record<string, unknown>]);
    expect(Object.hasOwn((out[0] as { p: object }).p, '__proto__')).toBe(true);
  });
  it('OPS-6 extracts the batch ID by dotted path; numbers become strings; anything else is undefined', () => {
    expect(extractBatchId({ bulk_uuid: 'b-1' }, 'bulk_uuid')).toBe('b-1');
    expect(extractBatchId({ a: { id: 7 } }, 'a.id')).toBe('7');
    expect(extractBatchId({ bulk_uuid: { x: 1 } }, 'bulk_uuid')).toBeUndefined();
    expect(extractBatchId({}, 'bulk_uuid')).toBeUndefined();
  });
  it('OPS-6 SEC-5 refuses unsafe batch IDs', () => {
    for (const bad of ['', '../x', 'a/b', 'a b', 'x'.repeat(257)]) expect(isSafeBatchId(bad)).toBe(false);
    expect(isSafeBatchId('0b4f2c1e-91aa-4e4b-9b8e-1d2c3a4b5c6d')).toBe(true);
  });
  const STATUS = { method: 'GET' as const, path: '/V1/bulk/{batch_id}/detailed-status', items: 'operations_list', index: 'id', state: 'status',
    states: { ok: [1], retriable: [2], failed: [3, 5], open: [4] } };
  it('OPS-6 maps states by index from a shuffled list', () => {
    expect(mapBulkStatus(STATUS, { operations_list: [{ id: 2, status: 4 }, { id: 0, status: 1 }, { id: 1, status: 3 }, { id: 3, status: 2 }, { id: 4, status: 5 }] }))
      .toEqual([{ index: 2, state: 'open' }, { index: 0, state: 'ok' }, { index: 1, state: 'failed' }, { index: 3, state: 'retriable' }, { index: 4, state: 'failed' }]);
  });
  it('OPS-6 a state in no list is failed, never open (Review Focus 5); entries without an integer index are dropped', () => {
    expect(mapBulkStatus(STATUS, { operations_list: [{ id: 0, status: 9 }, { id: 'x', status: 1 }, { id: -1, status: 1 }, { status: 1 }, { id: 1, status: '1' }] }))
      .toEqual([{ index: 0, state: 'failed' }, { index: 1, state: 'failed' }]);
  });
  it('OPS-6 answers undefined when the items path is not an array', () => {
    expect(mapBulkStatus(STATUS, { operations_list: null })).toBeUndefined();
  });
  it('OPS-6 answers undefined for a key-mode status (no index field) until key mapping is read', () => {
    const keyed = { method: STATUS.method, path: STATUS.path, items: STATUS.items, key: 'id', state: STATUS.state, states: STATUS.states };
    expect(mapBulkStatus(keyed, { operations_list: [{ id: 0, status: 1 }] })).toBeUndefined();
  });
});
