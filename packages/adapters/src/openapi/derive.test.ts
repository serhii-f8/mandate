// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The AI Operations Layer Authors
import { describe, expect, it } from 'vitest';
import type { CatalogEntry } from '@aiops/connector-sdk';
import { loadSpec, strictAjv } from '../../test/strict-ajv.js';
import { deriveCatalog } from './derive.js';
import { normaliseSpec } from './normalise.js';

function derive(name: string, include?: readonly string[]): ReturnType<typeof deriveCatalog> {
  const { operations, issues } = normaliseSpec(loadSpec(name));
  expect(issues).toEqual([]);
  return deriveCatalog('shop', operations, include);
}

function only(catalog: readonly CatalogEntry[]): CatalogEntry {
  expect(catalog).toHaveLength(1);
  const [entry] = catalog;
  if (entry === undefined) throw new Error('no entry');
  return entry;
}

describe('CONN-2 OpenAPI import', () => {
  it('CONN-2 derives one entry from Swagger 2.0 with path, query and body properties', () => {
    const { catalog, issues } = derive('swagger2-mini.json');
    expect(issues).toEqual([]);
    const entry = only(catalog);
    expect(entry.key).toBe('shop:putProduct');
    expect(entry).toMatchObject({ operationId: 'putProduct', method: 'PUT', path: '/V1/products/{sku}', summary: 'Replace a product' });
    expect(Object.keys(entry.inputSchema.properties as object)).toEqual(['sku', 'q', 'body']);
    expect(entry.inputSchema.required).toEqual(expect.arrayContaining(['sku', 'body']));
    expect(entry.inputSchema.type).toBe('object');
    expect(entry.defaultMapping).toEqual({
      method: 'PUT',
      path: '/V1/products/{sku}',
      pathParams: { sku: { arg: 'sku' } },
      query: { q: { arg: 'q' } },
      headers: {},
      body: { arg: 'body' },
      response: { maxItems: 100 },
    });
    const validate = strictAjv().compile(entry.inputSchema);
    expect(validate({ sku: 'A', body: { product: { sku: 'A', price: 1 } } })).toBe(true);
    expect(validate({ sku: 'A', body: { product: { sku: 'A', price: 0 } } })).toBe(false);
    expect(validate({ q: 'x', body: { product: { sku: 'A' } } })).toBe(false);
  });

  it('CONN-2 derives the same input schema from the OpenAPI 3.0 and 3.1 equivalents', () => {
    const swagger = only(derive('swagger2-mini.json').catalog);
    for (const name of ['oas30-mini.json', 'oas31-mini.json']) {
      const entry = only(derive(name).catalog);
      expect(entry.inputSchema, name).toEqual(swagger.inputSchema);
      expect(entry.defaultMapping, name).toEqual(swagger.defaultMapping);
      expect(entry.key, name).toBe('shop:putProduct');
    }
  });

  it('CONN-2 keeps only the included operations, by operationId or "METHOD /path"', () => {
    const byId = derive('circular.json', ['getProduct']);
    expect(byId.issues).toEqual([]);
    expect(only(byId.catalog).key).toBe('shop:getProduct');
    const byPath = derive('circular.json', ['POST /V1/categories/{categoryId}', 'listProducts']);
    expect(byPath.issues).toEqual([]);
    expect(byPath.catalog.map((e) => e.key)).toEqual(['shop:listProducts', 'shop:POST /V1/categories/{categoryId}']);
  });

  it('CONN-2 reports an include entry that matches no operation', () => {
    const { catalog, issues } = derive('circular.json', ['getProduct', 'nope']);
    expect(catalog.map((e) => e.key)).toEqual(['shop:getProduct']);
    expect(issues).toEqual([{ path: ['openapi', 'include', 1], message: 'matches no operation in the spec' }]);
  });

  it('CONN-2 derives a circular spec without throwing and every derived schema compiles in Ajv strict mode', () => {
    const { catalog, issues } = derive('circular.json');
    expect(issues).toEqual([]);
    expect(catalog.map((e) => e.key)).toEqual([
      'shop:listProducts',
      'shop:getProduct',
      'shop:saveProduct',
      'shop:POST /V1/categories/{categoryId}',
    ]);
    const ajv = strictAjv();
    for (const entry of catalog) expect(() => ajv.compile(entry.inputSchema), entry.key).not.toThrow();
    for (const name of ['swagger2-mini.json', 'oas30-mini.json', 'oas31-mini.json']) {
      for (const entry of derive(name).catalog) expect(() => strictAjv().compile(entry.inputSchema), name).not.toThrow();
    }
  });

  it('CONN-2 maps Magento flattened query parameters from arguments of the same name', () => {
    const entry = only(derive('circular.json', ['listProducts']).catalog);
    const field = 'searchCriteria[filterGroups][0][filters][0][field]';
    expect(entry.defaultMapping.query[field]).toEqual({ arg: field });
    expect(entry.defaultMapping.headers).toEqual({ 'X-Store': { arg: 'X-Store' } });
    const validate = strictAjv().compile(entry.inputSchema);
    expect(validate({ [field]: 'sku', 'searchCriteria[pageSize]': 20, ids: [1, 2] })).toBe(true);
    expect(validate({ 'searchCriteria[pageSize]': 'twenty' })).toBe(false);
  });

  it('CONN-2 never exposes Authorization, Cookie or Host header parameters as properties', () => {
    for (const name of ['swagger2-mini.json', 'oas30-mini.json', 'oas31-mini.json', 'circular.json']) {
      for (const entry of derive(name).catalog) {
        const props = Object.keys(entry.inputSchema.properties ?? {}).map((p) => p.toLowerCase());
        expect(props, entry.key).not.toContain('authorization');
        expect(props, entry.key).not.toContain('cookie');
        expect(props, entry.key).not.toContain('host');
        const headers = Object.keys(entry.defaultMapping.headers).map((h) => h.toLowerCase());
        expect(headers, entry.key).not.toEqual(expect.arrayContaining(['authorization']));
        expect(headers, entry.key).not.toEqual(expect.arrayContaining(['cookie']));
      }
    }
  });

  it('CONN-2 never exposes platform-set header parameters (shared forbidden list)', () => {
    const names = ['Authorization', 'Proxy-Authorization', 'Cookie', 'Host', 'Content-Length', 'Transfer-Encoding', 'Connection', 'X-Store'];
    const op = { operationId: 'get', method: 'GET' as const, path: '/p', parameters: names.map((name) => ({ name, in: 'header' as const, required: false, schema: { type: 'string' } })) };
    const entry = only(deriveCatalog('shop', [op]).catalog);
    expect(Object.keys(entry.inputSchema.properties ?? {})).toEqual(['X-Store']);
    expect(Object.keys(entry.defaultMapping.headers)).toEqual(['X-Store']);
  });

  it('CONN-2 reports a duplicate operationId and keeps the first operation', () => {
    const doc = {
      openapi: '3.0.3',
      info: { title: 't', version: '1' },
      paths: {
        '/a': { get: { operationId: 'same', responses: {} } },
        '/b': { get: { operationId: 'same', responses: {} } },
      },
    };
    const { catalog, issues } = deriveCatalog('c', normaliseSpec(doc).operations);
    expect(catalog.map((e) => e.path)).toEqual(['/a']);
    expect(issues).toEqual([{ path: ['paths', '/b', 'get', 'operationId'], message: 'duplicates another operation key' }]);
  });

  it('CONN-2 reports a parameter whose name collides with another property', () => {
    const doc = {
      openapi: '3.0.3',
      info: { title: 't', version: '1' },
      paths: {
        '/a': {
          post: {
            operationId: 'p',
            parameters: [
              { name: 'body', in: 'query', schema: { type: 'string' } },
              { name: 'v', in: 'query', schema: { type: 'string' } },
              { name: 'v', in: 'header', schema: { type: 'string' } },
            ],
            requestBody: { content: { 'application/json': { schema: { type: 'object' } } } },
            responses: {},
          },
        },
      },
    };
    const { catalog, issues } = deriveCatalog('c', normaliseSpec(doc).operations);
    expect(Object.keys(only(catalog).inputSchema.properties as object)).toEqual(['v', 'body']);
    expect(issues.map((i) => i.path)).toEqual([
      ['paths', '/a', 'post', 'parameters', 'body'],
      ['paths', '/a', 'post', 'parameters', 'v'],
    ]);
  });
});
