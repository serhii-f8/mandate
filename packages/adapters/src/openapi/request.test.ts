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
  it('omits absent args without default and repeats array keys', () => {
    const r = buildRequest('http://h', { ...base, query: { a: { arg: 'a' }, b: { arg: 'b' }, c: 'lit' } }, { b: ['x', 'y'] });
    expect(r.url.searchParams.has('a')).toBe(false);
    expect(r.url.searchParams.getAll('b')).toEqual(['x', 'y']);
    expect(r.url.searchParams.get('c')).toBe('lit');
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
  it.each(['Authorization', 'cookie', 'HOST', 'Proxy-Authorization'])('rejects header %s', (h) => {
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
});
