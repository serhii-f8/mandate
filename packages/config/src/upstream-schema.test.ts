import { describe, expect, it } from 'vitest';
import { schemaIssues } from './schema.js';
import { pathPlaceholders, templateArgs, toUpstreamMapping, upstreamSchema } from './upstream-schema.js';

function parse(value: unknown) {
  const result = upstreamSchema.safeParse(value, { reportInput: true });
  if (!result.success) throw new Error(JSON.stringify(schemaIssues(result)));
  return result.data;
}

function issuesOf(value: unknown) {
  return schemaIssues(upstreamSchema.safeParse(value, { reportInput: true })).map((i) => [i.path.join('.'), i.message]);
}

describe('CONN-2 upstream mapping templates', () => {
  it('converts literals, argument templates with defaults, and absent maps', () => {
    const u = parse({
      method: 'GET',
      path: '/V1/products/{sku}',
      path_params: { sku: { arg: 'sku' } },
      query: { field: 'brand', value: { arg: 'brand' }, size: { arg: 'page_size', default: 20 }, active: true, n: 3 },
      body: { arg: 'body' },
    });
    expect(toUpstreamMapping(u)).toEqual({
      method: 'GET',
      path: '/V1/products/{sku}',
      pathParams: { sku: { arg: 'sku' } },
      query: { field: 'brand', value: { arg: 'brand' }, size: { arg: 'page_size', default: 20 }, active: true, n: 3 },
      headers: {},
      body: { arg: 'body' },
      response: { maxItems: 100 },
    });
    expect(templateArgs(u).map((t) => [t.arg, t.path.join('.')])).toEqual([
      ['sku', 'path_params.sku'],
      ['brand', 'query.value'],
      ['page_size', 'query.size'],
      ['body', 'body'],
    ]);
    expect(pathPlaceholders(u.path ?? '')).toEqual(['sku']);
  });

  it('rejects unknown template keys and non-scalar literals', () => {
    expect(issuesOf({ method: 'GET', path: '/x', query: { a: { arg: 'a', fallback: 1 } } })).toEqual([['query.a', 'unknown key: fallback']]);
    expect(issuesOf({ method: 'GET', path: '/x', query: { a: [1, 2] } })).toEqual([['query.a', 'does not match any allowed form']]);
    expect(issuesOf({ method: 'GET', path: 'x' })).toEqual([['path', 'has an invalid format']]);
    expect(issuesOf({ method: 'get', path: '/x' })[0]?.[0]).toBe('method');
  });
});

describe('MCP-4 response mapping', () => {
  it('converts the response block with defaults', () => {
    const u = parse({
      operation: 'listItems',
      response: { items: 'items', total: 'total_count', flatten: { path: 'custom_attributes', key: 'attribute_code', value: 'value' }, fields_from_arg: 'fields' },
    });
    expect(toUpstreamMapping(u).response).toEqual({
      items: 'items',
      total: 'total_count',
      flatten: { path: 'custom_attributes', key: 'attribute_code', value: 'value' },
      fieldsFromArg: 'fields',
      maxItems: 100,
    });
    expect(templateArgs(u)).toEqual([{ arg: 'fields', path: ['response', 'fields_from_arg'] }]);
  });

  it('bounds max_items to 1..500 and rejects unknown keys', () => {
    expect(parse({ operation: 'x', response: { max_items: 500 } }).response?.max_items).toBe(500);
    expect(issuesOf({ operation: 'x', response: { max_items: 501 } })).toEqual([['response.max_items', 'is too long or too large (maximum 500)']]);
    expect(issuesOf({ operation: 'x', response: { max_items: 0 } })).toEqual([['response.max_items', 'is too short or too small (minimum 1)']]);
    expect(issuesOf({ operation: 'x', response: { item: 'items' } })).toEqual([['response', 'unknown key: item']]);
  });
});
