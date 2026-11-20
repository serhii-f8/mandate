import { describe, expect, it } from 'vitest';
import { schemaIssues } from './schema.js';
import { pathPlaceholders, templateArgs, templateRecords, toUpstreamMapping, upstreamSchema } from './upstream-schema.js';

function parse(value: unknown) {
  const result = upstreamSchema.safeParse(value, { reportInput: true });
  if (!result.success) throw new Error(JSON.stringify(schemaIssues(result)));
  return result.data;
}

function issuesOf(value: unknown) {
  return schemaIssues(upstreamSchema.safeParse(value, { reportInput: true })).map((i) => [i.path.join('.'), i.message]);
}

describe('OPS-4 template join', () => {
  const withJoin = (join: string) => ({ method: 'GET', path: '/p', query: { v: { arg: 'skus', join } } });
  it('rejects an empty and a too long join and carries a valid one', () => {
    expect(issuesOf(withJoin(''))).not.toEqual([]);
    expect(issuesOf(withJoin('123456789'))).not.toEqual([]);
    expect(toUpstreamMapping(parse(withJoin(','))).query).toEqual({ v: { arg: 'skus', join: ',' } });
  });
});

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

describe('OPS-6 bulk mapping', () => {
  const bulk = {
    batch_id: 'id',
    status: { path: '/s/{batch_id}', items: 'l', index: 'i', state: 's', states: { ok: [1], open: [2] } },
  };
  it('OPS-6 toUpstreamMapping carries bulk only when present', () => {
    expect(toUpstreamMapping(parse({ method: 'POST', path: '/p' })).bulk).toBeUndefined();
    expect(toUpstreamMapping(parse({ method: 'POST', path: '/p', bulk })).bulk).toEqual({
      body: {},
      batchId: 'id',
      status: { method: 'GET', path: '/s/{batch_id}', items: 'l', index: 'i', state: 's', states: { ok: [1], failed: [], retriable: [], open: [2] } },
    });
  });
  it('OPS-6 rejects unknown keys inside bulk', () => {
    expect(issuesOf({ method: 'POST', path: '/p', bulk: { ...bulk, extra: 1 } })).not.toEqual([]);
    expect(issuesOf({ method: 'POST', path: '/p', bulk: { ...bulk, status: { ...bulk.status, extra: 1 } } })).not.toEqual([]);
  });
});

describe('OPS-6 bulk status key mapping', () => {
  const status = { path: '/s/{batch_id}', items: 'l', state: 's', states: { ok: [1], open: [2] } };
  const withStatus = (extra: Record<string, unknown>) => ({ method: 'POST', path: '/p', bulk: { batch_id: 'id', status: { ...status, ...extra } } });

  it('OPS-6 bulk.status takes index or key, not both and not neither', () => {
    expect(issuesOf(withStatus({ index: 'i', key: 'k' }))).toEqual([['bulk.status.index', 'give either index or key, not both']]);
    expect(issuesOf(withStatus({}))).toEqual([['bulk.status.index', 'is required (or give key)']]);
    const byKey = toUpstreamMapping(parse(withStatus({ key: 'sku' }))).bulk?.status;
    expect(byKey).toMatchObject({ key: 'sku' });
    expect(byKey).not.toHaveProperty('index');
    const byIndex = toUpstreamMapping(parse(withStatus({ index: 'i' }))).bulk?.status;
    expect(byIndex).toMatchObject({ index: 'i' });
    expect(byIndex).not.toHaveProperty('key');
  });
});

describe('OPS-6 record templates', () => {
  it('OPS-6 a record template parses and converts', () => {
    const u = parse({
      method: 'PATCH',
      path: '/items/{id}',
      path_params: { id: { record: 'id' } },
      query: { tags: { record: 'tags', join: ',' }, v: { arg: 'v' } },
      headers: { 'X-State': { record: 'state', default: 'open' } },
      body: { record: 'payload' },
    });
    const mapping = toUpstreamMapping(u);
    expect(mapping.pathParams).toEqual({ id: { record: 'id' } });
    expect(mapping.query).toEqual({ tags: { record: 'tags', join: ',' }, v: { arg: 'v' } });
    expect(mapping.headers).toEqual({ 'X-State': { record: 'state', default: 'open' } });
    expect(mapping.body).toEqual({ record: 'payload' });
    expect(templateArgs(u)).toEqual([{ arg: 'v', path: ['query', 'v'] }]);
    expect(templateRecords(u)).toEqual([
      { record: 'id', path: ['path_params', 'id'] },
      { record: 'tags', path: ['query', 'tags'] },
      { record: 'state', path: ['headers', 'X-State'] },
      { record: 'payload', path: ['body'] },
    ]);
    // A template names an argument or a record field, never both.
    expect(issuesOf({ method: 'PATCH', path: '/p', body: { record: 'a', arg: 'b' } })).not.toEqual([]);
    expect(issuesOf({ method: 'PATCH', path: '/p', body: { record: '' } })).not.toEqual([]);
  });
});

describe('EXE-4 idempotency header', () => {
  it('EXE-4 NFR-18 idempotency maps to UpstreamMapping.idempotency', () => {
    expect(toUpstreamMapping(parse({ method: 'POST', path: '/p', idempotency: { header: 'Idempotency-Key' } }))).toEqual({
      method: 'POST',
      path: '/p',
      pathParams: {},
      query: {},
      headers: {},
      response: { maxItems: 100 },
      idempotency: { header: 'Idempotency-Key' },
    });
    expect(Object.hasOwn(toUpstreamMapping(parse({ method: 'POST', path: '/p' })), 'idempotency')).toBe(false);
    expect(issuesOf({ method: 'POST', path: '/p', idempotency: { header: 'Idempotency-Key', extra: 1 } })).not.toEqual([]);
    expect(issuesOf({ method: 'POST', path: '/p', idempotency: { header: 'not a header' } })).not.toEqual([]);
  });

  it('SEC-2 idempotency cannot name a platform or credential header', () => {
    const withHeader = (header: string, extra: Record<string, unknown> = {}) => ({ method: 'POST', path: '/p', idempotency: { header }, ...extra });
    for (const header of ['Authorization', 'cookie', 'Host', 'Proxy-Authorization', 'CONTENT-LENGTH']) {
      expect(issuesOf(withHeader(header))).toEqual([['idempotency.header', 'is set by the platform']]);
    }
    expect(issuesOf(withHeader('x-request-key', { headers: { 'X-Request-Key': 'fixed' } }))).toEqual([['idempotency.header', 'is already declared in headers']]);
    const bulk = { batch_id: 'id', status: { path: '/s/{batch_id}', items: 'l', index: 'i', state: 's', states: { ok: [1], open: [2] } } };
    expect(issuesOf(withHeader('Idempotency-Key', { bulk }))).toEqual([['idempotency', 'is not allowed together with bulk']]);
  });
});
