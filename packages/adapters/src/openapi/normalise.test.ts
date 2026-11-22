// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Mandate Authors
import { describe, expect, it } from 'vitest';
import { loadSpec, strictAjv } from '../../test/strict-ajv.js';
import { MAX_SCHEMA_NODES, normaliseSpec, validateSpecDocument } from './normalise.js';

function countObjects(value: unknown): number {
  if (Array.isArray(value)) return value.reduce((n: number, v: unknown) => n + countObjects(v), 0);
  if (typeof value !== 'object' || value === null) return 0;
  return 1 + Object.values(value).reduce((n: number, v: unknown) => n + countObjects(v), 0);
}

describe('CONN-2 OpenAPI normaliser limits', () => {
  it('CONN-2 truncates an operation whose inlined schema exceeds the node budget, fast, with one issue', () => {
    const started = Date.now();
    const { operations, issues } = normaliseSpec(loadSpec('fanout.json'));
    expect(Date.now() - started).toBeLessThan(2000);
    expect(issues).toEqual([{ path: ['paths', '/things', 'post'], message: 'input schema truncated: too large to inline' }]);
    const body = operations.find((o) => o.operationId === 'saveThing')?.jsonBody?.schema;
    expect(body).toBeDefined();
    // One object per translated schema node, plus at most one `properties` map per node.
    expect(countObjects(body)).toBeLessThanOrEqual(2 * MAX_SCHEMA_NODES);
    expect(() => strictAjv().compile({ type: 'object', properties: { body } })).not.toThrow();
    expect(operations.find((o) => o.operationId === 'small')?.parameters).toHaveLength(1);
  });

  it('CONN-2 reports a path placeholder without a declared path parameter at the operation', () => {
    const doc = {
      openapi: '3.0.3',
      info: { title: 't', version: '1' },
      paths: {
        '/a/{id}/b/{x}': {
          get: { parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }], responses: {} },
        },
      },
    };
    expect(normaliseSpec(doc).issues).toEqual([
      { path: ['paths', '/a/{id}/b/{x}', 'get'], message: 'path placeholder {x} has no path parameter' },
    ]);
  });
});

describe('CONN-2 OpenAPI spec validation', () => {
  it('CONN-2 accepts Swagger 2.0, OpenAPI 3.0 and 3.1 documents', async () => {
    for (const name of ['swagger2-mini.json', 'oas30-mini.json', 'oas31-mini.json', 'circular.json']) {
      expect(await validateSpecDocument(loadSpec(name)), name).toEqual([]);
    }
  });

  it('CONN-2 reports a document without info.version by JSON pointer', async () => {
    const doc = loadSpec('oas30-mini.json');
    doc.info = { title: 'no version' };
    const issues = await validateSpecDocument(doc);
    expect(issues.length).toBeGreaterThan(0);
    expect(issues[0]?.path).toEqual(['info']);
    expect(issues[0]?.message).toContain('version');
  });

  it('CONN-2 reports a value that is not an OpenAPI document without echoing it', async () => {
    const issues = await validateSpecDocument('/etc/passwd');
    expect(issues).toEqual([{ path: [], message: 'the spec is not a JSON or YAML object' }]);
    const unknown = await validateSpecDocument({ secret: 'do-not-echo' });
    expect(unknown).toHaveLength(1);
    expect(JSON.stringify(unknown)).not.toContain('do-not-echo');
  });

  it('CONN-2 does not echo document values in validation messages', async () => {
    const doc = loadSpec('oas30-mini.json');
    doc.info = { title: 'x', version: 'v', 'leak-me-value': 'not-allowed-here' };
    doc.openapi = '3.0.3';
    (doc as { paths: unknown }).paths = { '/a': { get: { responses: { '200': { description: 'hunter2', bogus: 'hunter2' } } } } };
    const issues = await validateSpecDocument(doc);
    expect(issues.length).toBeGreaterThan(0);
    expect(JSON.stringify(issues)).not.toContain('hunter2');
  });
});

describe('CONN-2 OpenAPI normaliser', () => {
  it('CONN-2 reads Swagger 2.0 parameters, merged path-level parameters and the body parameter', () => {
    const { operations, issues } = normaliseSpec(loadSpec('swagger2-mini.json'));
    expect(issues).toEqual([]);
    expect(operations).toHaveLength(1);
    const op = operations[0];
    expect(op).toMatchObject({ operationId: 'putProduct', method: 'PUT', path: '/V1/products/{sku}', summary: 'Replace a product' });
    expect(op?.parameters.map((p) => [p.name, p.in, p.required])).toEqual([
      ['sku', 'path', true],
      ['q', 'query', false],
      ['Authorization', 'header', false],
    ]);
    expect(op?.parameters[0]?.schema).toEqual({ type: 'string', description: 'Product SKU' });
    expect(op?.jsonBody?.required).toBe(true);
    expect(op?.jsonBody?.schema).toMatchObject({ type: 'object', required: ['product'] });
  });

  it('CONN-2 reads OpenAPI 3 parameters by $ref and the application/json request body', () => {
    for (const name of ['oas30-mini.json', 'oas31-mini.json']) {
      const { operations, issues } = normaliseSpec(loadSpec(name));
      expect(issues, name).toEqual([]);
      expect(operations.map((o) => o.parameters.map((p) => p.name)), name).toEqual([['sku', 'q', expect.stringMatching(/^authorization$/i)]]);
      expect(operations[0]?.jsonBody?.required, name).toBe(true);
    }
  });

  it('CONN-2 overrides a path-level parameter with an operation parameter of the same name and location', () => {
    const doc = {
      openapi: '3.0.3',
      info: { title: 't', version: '1' },
      paths: {
        '/a/{id}': {
          parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
          get: { parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'integer' } }], responses: {} },
        },
      },
    };
    const { operations } = normaliseSpec(doc);
    expect(operations[0]?.parameters).toEqual([{ name: 'id', in: 'path', required: true, schema: { type: 'integer' } }]);
  });

  it('CONN-2 ignores cookie and formData parameters, non-JSON bodies and methods outside the read/write set', () => {
    const doc = {
      openapi: '3.0.3',
      info: { title: 't', version: '1' },
      paths: {
        '/a': {
          head: { responses: {} },
          post: {
            parameters: [{ name: 'sid', in: 'cookie', schema: { type: 'string' } }],
            requestBody: { content: { 'text/plain': { schema: { type: 'string' } } } },
            responses: {},
          },
        },
      },
    };
    const { operations } = normaliseSpec(doc);
    expect(operations).toEqual([{ method: 'POST', path: '/a', parameters: [] }]);
  });

  it('CONN-2 reports an external $ref with the pointer of the operation', () => {
    const doc = {
      openapi: '3.0.3',
      info: { title: 't', version: '1' },
      paths: {
        '/a': {
          post: {
            operationId: 'x',
            requestBody: { content: { 'application/json': { schema: { $ref: 'other.json#/x' } } } },
            responses: {},
          },
        },
      },
    };
    const { operations, issues } = normaliseSpec(doc);
    expect(operations[0]?.jsonBody?.schema).toEqual({});
    expect(issues).toEqual([
      {
        path: ['paths', '/a', 'post', 'requestBody', 'content', 'application/json', 'schema', '$ref'],
        message: 'external $ref is not supported',
      },
    ]);
  });
});
