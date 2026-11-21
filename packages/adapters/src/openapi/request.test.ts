// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The AI Operations Layer Authors
import { describe, expect, it } from 'vitest';
import type { UpstreamMapping } from '@aiops/connector-sdk';
import { buildRequest, MappingError } from './request.js';

const base: UpstreamMapping & { method: 'GET'; path: string } = {
  method: 'GET',
  path: '/V1/products',
  pathParams: {},
  query: {},
  headers: {},
  response: { maxItems: 100 },
};

describe('MCP-4 request building', () => {
  it('applies a query default and encodes brackets', () => {
    const r = buildRequest('http://h/rest/', { ...base, query: { 'searchCriteria[pageSize]': { arg: 'page_size', default: 20 } } }, {});
    expect(r.url.search).toContain('searchCriteria%5BpageSize%5D=20');
    expect(r.url.searchParams.get('searchCriteria[pageSize]')).toBe('20');
    expect(r.url.pathname).toBe('/rest/V1/products');
    expect(r.headers.accept).toBe('application/json');
  });
  it('OPS-4 joins an array argument into one query value when join is set', () => {
    const q = { 'f[value]': { arg: 'skus', join: ',' } };
    const r = buildRequest('http://h', { ...base, query: q }, { skus: ['A-1', 'B-2'] });
    expect(r.url.searchParams.getAll('f[value]')).toEqual(['A-1,B-2']);
    const s = buildRequest('http://h', { ...base, query: q }, { skus: 'A-1' });
    expect(s.url.searchParams.getAll('f[value]')).toEqual(['A-1']);
    const n = buildRequest('http://h', { ...base, query: { 'f[value]': { arg: 'skus' } } }, { skus: ['A-1', 'B-2'] });
    expect(n.url.searchParams.getAll('f[value]')).toEqual(['A-1', 'B-2']);
  });

  it('omits absent args without default and repeats array keys', () => {
    const r = buildRequest('http://h', { ...base, query: { a: { arg: 'a' }, b: { arg: 'b' }, c: 'lit' } }, { b: ['x', 'y'] });
    expect(r.url.searchParams.has('a')).toBe(false);
    expect(r.url.searchParams.getAll('b')).toEqual(['x', 'y']);
    expect(r.url.searchParams.get('c')).toBe('lit');
  });
  it('OPS-6 omits a record template outside a per-record write, even with a default', () => {
    const r = buildRequest('http://h', { ...base, query: { sku: { record: 'sku', default: 'x' } } }, { sku: 'A-1' });
    expect(r.url.searchParams.has('sku')).toBe(false);
  });
  it('OPS-6 record templates resolve from the record and arg templates from the arguments', () => {
    const mapping = {
      ...base,
      method: 'PATCH' as const,
      path: '/repos/{owner}/items/{id}',
      pathParams: { owner: { arg: 'owner' }, id: { record: 'id' } },
      query: { sku: { record: 'sku' }, missing: { record: 'absent' }, dflt: { record: 'absent', default: 'd' }, from_arg: { arg: 'sku' } },
      headers: { 'X-Tag': { record: 'tag' } },
      body: { record: 'payload' },
    };
    const r = buildRequest('http://h', mapping, { owner: 'acme', sku: 'arg-sku' }, { id: 7, sku: 'rec-sku', tag: 't', payload: { a: 1 } });
    expect(r.url.pathname).toBe('/repos/acme/items/7');
    expect(r.url.searchParams.get('sku')).toBe('rec-sku');
    expect(r.url.searchParams.has('missing')).toBe(false);
    expect(r.url.searchParams.get('dflt')).toBe('d');
    expect(r.url.searchParams.get('from_arg')).toBe('arg-sku');
    expect(r.headers['x-tag']).toBe('t');
    expect(r.body).toBe('{"a":1}');
    // A record template without a record: no value in a path, omitted elsewhere.
    expect(() => buildRequest('http://h', mapping, { owner: 'acme' })).toThrow(new MappingError('path parameter id has no value'));
    const noPath = { ...mapping, path: '/items', pathParams: {} };
    const n = buildRequest('http://h', noPath, { sku: 'arg-sku' });
    expect(n.url.searchParams.has('sku')).toBe(false);
    expect(n.headers).not.toHaveProperty('x-tag');
    expect(n.body).toBeUndefined();
  });
  it('OPS-6 a dot-segment record value in a path is refused', () => {
    const mapping = { ...base, method: 'PATCH' as const, path: '/items/{id}', pathParams: { id: { record: 'id' } } };
    for (const bad of ['..', '.', '%2e%2e', '%2E']) {
      expect(() => buildRequest('http://h', mapping, {}, { id: bad })).toThrow(new MappingError('path parameter id is not allowed'));
    }
    expect(buildRequest('http://h', mapping, {}, { id: 'a/b' }).url.pathname).toBe('/items/a%2Fb');
  });
  it('encodes path parameters', () => {
    const r = buildRequest('http://h', { ...base, path: '/V1/products/{sku}', pathParams: { sku: { arg: 'sku' } } }, { sku: 'a/b' });
    expect(r.url.pathname).toBe('/V1/products/a%2Fb');
  });
  it('throws for a missing path value', () => {
    expect(() => buildRequest('http://h', { ...base, path: '/p/{sku}', pathParams: { sku: { arg: 'sku' } } }, {})).toThrow(
      new MappingError('path parameter sku has no value'),
    );
  });
  it('throws for an empty-string path value', () => {
    expect(() => buildRequest('http://h', { ...base, path: '/p/{sku}', pathParams: { sku: { arg: 'sku' } } }, { sku: '' })).toThrow(
      new MappingError('path parameter sku has no value'),
    );
  });
  it.each(['Authorization', 'cookie', 'HOST', 'Proxy-Authorization', 'Content-Length', 'transfer-encoding', 'Connection'])('rejects header %s', (h) => {
    expect(() => buildRequest('http://h', { ...base, headers: { [h]: 'x' } }, {})).toThrow(MappingError);
  });
  it('sends a JSON body from an argument', () => {
    const r = buildRequest('http://h', { ...base, body: { arg: 'body' } }, { body: { a: [1] } });
    expect(r.body).toBe('{"a":[1]}');
    expect(r.headers['content-type']).toBe('application/json');
  });
  it('rejects object values in query', () => {
    expect(() => buildRequest('http://h', { ...base, query: { a: { arg: 'a' } } }, { a: { x: 1 } })).toThrow(MappingError);
  });
  it.each(['..', '.', '%2e%2e', '%2E.'])('rejects dot-segment path value %s', (sku) => {
    expect(() => buildRequest('http://h', { ...base, path: '/p/{sku}', pathParams: { sku: { arg: 'sku' } } }, { sku })).toThrow(
      new MappingError('path parameter sku is not allowed'),
    );
  });
  it('allows dots inside a value', () => {
    const r = buildRequest('http://h', { ...base, path: '/p/{sku}', pathParams: { sku: { arg: 'sku' } } }, { sku: 'a.b' });
    expect(r.url.pathname).toBe('/p/a.b');
  });
  it('rejects a base URL with query or fragment', () => {
    expect(() => buildRequest('http://h/x?y=1', base, {})).toThrow(MappingError);
    expect(() => buildRequest('http://h/x#f', base, {})).toThrow(MappingError);
  });
  it('rejects an array path parameter', () => {
    expect(() => buildRequest('http://h', { ...base, path: '/p/{s}', pathParams: { s: { arg: 's' } } }, { s: ['a', 'b'] })).toThrow(MappingError);
  });
  it('sends literal headers and joins array headers', () => {
    const r = buildRequest('http://h', { ...base, headers: { 'X-A': 'lit', 'X-B': { arg: 'b' } } }, { b: ['1', '2'] });
    expect(r.headers['x-a']).toBe('lit');
    expect(r.headers['x-b']).toBe('1, 2');
  });
});
