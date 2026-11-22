// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Mandate Authors
import type { ConnectionSettings, CredentialSource, RequestAttempt, RequestInstrumentation, UpstreamMapping } from '@mandate/connector-sdk';
import { startFakeUpstream, type FakeUpstream } from '@mandate/testing';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { clearTokenCache } from '../http/oauth.js';
import { createOpenApiAdapter } from './adapter.js';

const fixture = (name: string): string => fileURLToPath(new URL(`../../test/fixtures/specs/${name}`, import.meta.url));

let up: FakeUpstream;
let tmp: string;
let seq = 0;

beforeEach(async () => {
  up = await startFakeUpstream();
  tmp = await mkdtemp(join(tmpdir(), 'mandate-adapter-'));
  clearTokenCache();
});
afterEach(async () => {
  await up.close();
  await rm(tmp, { recursive: true, force: true });
});

function settings(over: Partial<ConnectionSettings> = {}): ConnectionSettings {
  seq += 1;
  return {
    id: `oa-${seq}`,
    baseUrl: up.url,
    timeoutMs: 2000,
    retry: { maxAttempts: 3, initialBackoffMs: 1 },
    maxConcurrency: 4,
    allowPrivateNetwork: true,
    extraHosts: [],
    ...over,
  };
}

function cred(scheme: CredentialSource['scheme'], material: Record<string, string>): CredentialSource {
  return { ref: 'test-cred', scheme, open: () => Promise.resolve(material) };
}

const b64u = (v: unknown): string => Buffer.from(JSON.stringify(v)).toString('base64url');
const jwt = (payload: unknown, header: unknown = { alg: 'HS256', typ: 'JWT' }): string => `${b64u(header)}.${b64u(payload)}.c2lnbmF0dXJl`;

async function closedPort(): Promise<number> {
  const s = createServer();
  await new Promise<void>((r) => s.listen(0, '127.0.0.1', r));
  const addr = s.address();
  const port = typeof addr === 'object' && addr ? addr.port : 0;
  await new Promise<void>((r) => {
    s.close(() => {
      r();
    });
  });
  return port;
}

describe('CONN-2 spec from file and URL', () => {
  it('CONN-2 loads a JSON spec file and derives the catalog', async () => {
    const r = await createOpenApiAdapter().resolver.resolveSpec({ connection: settings({ id: 'shop' }), spec: { file: fixture('oas30-mini.json') } });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.catalog.map((e) => e.key)).toEqual(['shop:putProduct']);
  });

  it('CONN-2 loads a YAML spec file', async () => {
    const r = await createOpenApiAdapter().resolver.resolveSpec({ connection: settings({ id: 'm2' }), spec: { file: fixture('magento-search.yaml') } });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.catalog[0]).toMatchObject({ key: 'm2:catalogProductRepositoryV1GetListGet', method: 'GET', path: '/V1/products' });
  });

  it('CONN-2 applies include and reports an include entry that matches nothing', async () => {
    const r = await createOpenApiAdapter().resolver.resolveSpec({
      connection: settings(),
      spec: { file: fixture('oas30-mini.json') },
      include: ['putProduct', 'nope'],
    });
    expect(r).toEqual({ ok: false, issues: [{ path: ['openapi', 'include', 1], message: 'matches no operation in the spec' }] });
  });

  it('CONN-2 a missing file is an issue at openapi.spec', async () => {
    const r = await createOpenApiAdapter().resolver.resolveSpec({ connection: settings(), spec: { file: join(tmp, 'absent.json') } });
    expect(r).toEqual({ ok: false, issues: [{ path: ['openapi', 'spec'], message: 'the spec file could not be read' }] });
  });

  it('CONN-2 a file that is neither JSON nor YAML is an issue with a fixed message', async () => {
    const file = join(tmp, 'broken.yaml');
    await writeFile(file, 'openapi: [unclosed\n  secret-looking: value: : :');
    const r = await createOpenApiAdapter().resolver.resolveSpec({ connection: settings(), spec: { file } });
    expect(r).toEqual({ ok: false, issues: [{ path: ['openapi', 'spec'], message: 'the spec is not valid JSON or YAML' }] });
  });

  it('CONN-2 a file over 5 MB is an issue', async () => {
    const file = join(tmp, 'huge.json');
    await writeFile(file, `{"x":"${'a'.repeat(5 * 1024 * 1024)}"}`);
    const r = await createOpenApiAdapter().resolver.resolveSpec({ connection: settings(), spec: { file } });
    expect(r).toEqual({ ok: false, issues: [{ path: ['openapi', 'spec'], message: 'the spec exceeds 5 MB' }] });
  });

  it('CONN-2 an invalid document yields issues under openapi.spec', async () => {
    const file = join(tmp, 'bad.json');
    await writeFile(file, JSON.stringify({ openapi: '3.0.3', info: { title: 't' }, paths: {} }));
    const r = await createOpenApiAdapter().resolver.resolveSpec({ connection: settings(), spec: { file } });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.issues.length).toBeGreaterThan(0);
    for (const i of r.issues) expect(i.path.slice(0, 2)).toEqual(['openapi', 'spec']);
  });

  it('CONN-2 fetches the spec from a URL on an extra host, without a credential', async () => {
    const doc: unknown = JSON.parse(await (await import('node:fs/promises')).readFile(fixture('oas30-mini.json'), 'utf8'));
    up.route('GET', '/spec.json', () => ({ status: 200, body: doc }));
    const conn = settings({ id: 'shop', baseUrl: `http://127.0.0.1:${up.port}`, extraHosts: ['localhost'], auth: { scheme: 'bearer' } });
    const r = await createOpenApiAdapter().resolver.resolveSpec({ connection: conn, spec: { url: `http://localhost:${up.port}/spec.json` } });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.catalog.map((e) => e.key)).toEqual(['shop:putProduct']);
    expect(up.requests).toHaveLength(1);
    expect(up.requests[0]?.headers.authorization).toBeUndefined();
  });

  it('CONN-2 an unreachable spec URL is an issue', async () => {
    const port = await closedPort();
    const conn = settings({ retry: { maxAttempts: 1, initialBackoffMs: 1 } });
    const r = await createOpenApiAdapter().resolver.resolveSpec({ connection: conn, spec: { url: `http://127.0.0.1:${port}/spec.json` } });
    expect(r).toEqual({ ok: false, issues: [{ path: ['openapi', 'spec'], message: 'the spec URL could not be fetched (network)' }] });
  });

  it('CONN-2 a spec URL answering with an error status is an issue naming the status', async () => {
    const r = await createOpenApiAdapter().resolver.resolveSpec({ connection: settings(), spec: { url: `${up.url}/missing.json` } });
    expect(r).toEqual({ ok: false, issues: [{ path: ['openapi', 'spec'], message: 'the spec URL could not be fetched (http_status 404)' }] });
  });

  it('CONN-2 CONN-5 a spec URL on an undeclared host is refused', async () => {
    const r = await createOpenApiAdapter().resolver.resolveSpec({ connection: settings(), spec: { url: `http://localhost:${up.port}/spec.json` } });
    expect(r).toEqual({ ok: false, issues: [{ path: ['openapi', 'spec'], message: 'the spec URL could not be fetched (egress_denied)' }] });
    expect(up.requests).toHaveLength(0);
  });

  it('CONN-2 a spec URL that is not a URL is an issue', async () => {
    const r = await createOpenApiAdapter().resolver.resolveSpec({ connection: settings(), spec: { url: 'not a url' } });
    expect(r).toEqual({ ok: false, issues: [{ path: ['openapi', 'spec'], message: 'the spec URL is not a valid URL' }] });
  });
});

const searchMapping: UpstreamMapping = {
  method: 'GET',
  path: '/rest/default/V1/products',
  pathParams: {},
  query: {
    'searchCriteria[pageSize]': { arg: 'limit', default: 20 },
    'searchCriteria[filterGroups][0][filters][0][field]': 'name',
    'searchCriteria[filterGroups][0][filters][0][value]': { arg: 'q' },
  },
  headers: {},
  response: {
    items: 'items',
    total: 'total_count',
    flatten: { path: 'custom_attributes', key: 'attribute_code', value: 'value' },
    maxItems: 50,
  },
};

const magentoBody = {
  items: [
    { sku: 'MB01', name: 'Joust Duffle Bag', price: 34, custom_attributes: [{ attribute_code: 'color', value: 'black' }] },
    { sku: 'MB02', name: 'Strive Shoulder Pack', price: 32, custom_attributes: [{ attribute_code: 'color', value: 'blue' }] },
  ],
  total_count: 2,
};

describe('CONN-7 read call end to end', () => {
  it('CONN-7 a Magento-shaped search returns mapped items and sends exactly the mapped query', async () => {
    up.route('GET', '/rest/default/V1/products', () => ({ status: 200, body: magentoBody }));
    const r = await createOpenApiAdapter().read({
      connection: settings({ auth: { scheme: 'bearer' } }),
      mapping: searchMapping,
      args: { q: 'bag' },
      credential: cred('bearer', { token: 'opaque-token-1' }),
    });
    expect(r).toMatchObject({
      ok: true,
      status: 200,
      total: 2,
      truncated: false,
      items: [
        { sku: 'MB01', name: 'Joust Duffle Bag', price: 34, color: 'black' },
        { sku: 'MB02', name: 'Strive Shoulder Pack', price: 32, color: 'blue' },
      ],
    });
    const req = up.requests[0];
    expect(req?.method).toBe('GET');
    expect(req?.path).toBe('/rest/default/V1/products');
    expect([...(req?.query.entries() ?? [])]).toEqual([
      ['searchCriteria[pageSize]', '20'],
      ['searchCriteria[filterGroups][0][filters][0][field]', 'name'],
      ['searchCriteria[filterGroups][0][filters][0][value]', 'bag'],
    ]);
    expect(req?.headers.authorization).toBe('Bearer opaque-token-1');
  });

  it('CONN-7 SEC-3 a credential echoed by the upstream is redacted in the outcome', async () => {
    up.route('GET', '/rest/default/V1/products', () => ({
      status: 200,
      body: { items: [{ sku: 'X', name: 'leak opaque-token-2 here', custom_attributes: [] }], total_count: 1 },
    }));
    const r = await createOpenApiAdapter().read({
      connection: settings({ auth: { scheme: 'bearer' } }),
      mapping: searchMapping,
      args: {},
      credential: cred('bearer', { token: 'opaque-token-2' }),
    });
    expect(JSON.stringify(r)).not.toContain('opaque-token-2');
    expect(r).toMatchObject({ ok: true, items: [{ name: 'leak [REDACTED] here' }] });
  });

  it('CS-2 a read with exactValues returns long strings unclipped; without it they are clipped', async () => {
    const long = 'd'.repeat(5000);
    up.route('GET', '/rest/default/V1/products', () => ({
      status: 200,
      body: { items: [{ sku: 'X', description: long, custom_attributes: [] }], total_count: 1 },
    }));
    const adapter = createOpenApiAdapter();
    const input = { connection: settings(), mapping: searchMapping, args: {} };
    expect(await adapter.read({ ...input, exactValues: true })).toMatchObject({ ok: true, items: [{ description: long }] });
    const clipped = await adapter.read(input);
    expect(clipped).toMatchObject({ ok: true, items: [{ description: `${'d'.repeat(4000)}…[truncated]` }] });
  });

  it('CONN-7 a mapping without method and path is a mapping error and sends nothing', async () => {
    const unresolved: UpstreamMapping = { operation: 'x', pathParams: {}, query: {}, headers: {}, response: searchMapping.response };
    const r = await createOpenApiAdapter().read({ connection: settings(), mapping: unresolved, args: {} });
    expect(r).toMatchObject({ ok: false, code: 'mapping' });
    expect(up.requests).toHaveLength(0);
  });

  it('CONN-7 an argument the request cannot carry is a mapping error', async () => {
    const r = await createOpenApiAdapter().read({ connection: settings(), mapping: searchMapping, args: { q: { nested: true } } });
    expect(r).toMatchObject({ ok: false, code: 'mapping', message: 'parameter searchCriteria[filterGroups][0][filters][0][value] must be a scalar or an array of scalars' });
    expect(up.requests).toHaveLength(0);
  });

  it('CONN-7 a response the mapping cannot project is a mapping error with the status', async () => {
    up.route('GET', '/rest/default/V1/products', () => ({ status: 200, body: magentoBody }));
    const mapping: UpstreamMapping = { ...searchMapping, response: { ...searchMapping.response, fieldsFromArg: 'fields' } };
    const r = await createOpenApiAdapter().read({ connection: settings(), mapping, args: {} });
    expect(r).toMatchObject({ ok: false, code: 'mapping', status: 200, message: 'fields argument is missing' });
  });

  it('CONN-7 CONN-6 GET reads are retried, other methods are not', async () => {
    let n = 0;
    up.route('GET', '/rest/default/V1/products', () => (++n === 1 ? { status: 503 } : { status: 200, body: magentoBody }));
    const adapter = createOpenApiAdapter();
    const ok = await adapter.read({ connection: settings(), mapping: searchMapping, args: {} });
    expect(ok).toMatchObject({ ok: true, total: 2 });
    expect(n).toBe(2);

    up.route('POST', '/rest/default/V1/products/search', () => ({ status: 503 }));
    const post = await adapter.read({
      connection: settings(),
      mapping: { ...searchMapping, method: 'POST', path: '/rest/default/V1/products/search', query: {} },
      args: {},
    });
    expect(post).toMatchObject({ ok: false, code: 'http_status', status: 503 });
    expect(up.requests.filter((r) => r.method === 'POST')).toHaveLength(1);
  });

  it('CONN-7 upstream failures come back as typed outcomes', async () => {
    const r = await createOpenApiAdapter().read({ connection: settings({ auth: { scheme: 'bearer' } }), mapping: searchMapping, args: {} });
    expect(r).toMatchObject({ ok: false, code: 'credential_missing' });
  });

  it('CONN-7 reuses one client per settings object (shared semaphore and token cache)', async () => {
    const made: ConnectionSettings[] = [];
    const adapter = createOpenApiAdapter({
      clientFor: (s) => {
        made.push(s);
        return { send: () => Promise.resolve({ ok: true, status: 200, json: magentoBody, durationMs: 1 }) };
      },
    });
    const conn = settings();
    await adapter.read({ connection: conn, mapping: searchMapping, args: {} });
    await adapter.read({ connection: conn, mapping: searchMapping, args: {} });
    expect(made).toEqual([conn]);
    await adapter.read({ connection: settings(), mapping: searchMapping, args: {} });
    expect(made).toHaveLength(2);
  });
});

describe('SEC-7 detectable scopes', () => {
  it('SEC-7 a JWT bearer with a scope claim reports its values from jwt_claims', async () => {
    const token = jwt({ sub: 'svc', scope: 'catalog:read orders:read' });
    const r = await createOpenApiAdapter().detectScopes({ connection: settings({ auth: { scheme: 'bearer' } }), credential: cred('bearer', { token }) });
    expect(r).toEqual({ detectable: true, source: 'jwt_claims', values: ['catalog:read', 'orders:read'] });
    for (const part of token.split('.')) expect(JSON.stringify(r)).not.toContain(part);
  });

  it('SEC-7 a JWT bearer with an scp array claim reports its values', async () => {
    const token = jwt({ scp: ['catalog:read', 'stock:read'] });
    const r = await createOpenApiAdapter().detectScopes({ connection: settings({ auth: { scheme: 'bearer' } }), credential: cred('bearer', { token }) });
    expect(r).toEqual({ detectable: true, source: 'jwt_claims', values: ['catalog:read', 'stock:read'] });
  });

  it('SEC-7 an opaque bearer token is not detectable', async () => {
    const r = await createOpenApiAdapter().detectScopes({
      connection: settings({ auth: { scheme: 'bearer' } }),
      credential: cred('bearer', { token: 'abc.def.ghi' }),
    });
    expect(r).toEqual({ detectable: false, source: 'none', values: [] });
  });

  it('SEC-7 a JWT without scope claims is not detectable', async () => {
    const r = await createOpenApiAdapter().detectScopes({
      connection: settings({ auth: { scheme: 'bearer' } }),
      credential: cred('bearer', { token: jwt({ sub: 'svc' }) }),
    });
    expect(r).toEqual({ detectable: false, source: 'none', values: [] });
  });

  it('SEC-7 api_key, basic, no auth and a missing credential are not detectable', async () => {
    const a = createOpenApiAdapter();
    const none = { detectable: false, source: 'none', values: [] };
    expect(await a.detectScopes({ connection: settings({ auth: { scheme: 'api_key', header: 'x-key' } }), credential: cred('api_key', { key: jwt({ scope: 'a' }) }) })).toEqual(none);
    expect(await a.detectScopes({ connection: settings({ auth: { scheme: 'basic' } }), credential: cred('basic', { username: 'u', password: 'p' }) })).toEqual(none);
    expect(await a.detectScopes({ connection: settings() })).toEqual(none);
    expect(await a.detectScopes({ connection: settings({ auth: { scheme: 'bearer' } }) })).toEqual(none);
  });

  it('SEC-7 OAuth reports the scope of the token response', async () => {
    up.route('POST', '/token', () => ({ status: 200, body: { access_token: 'at-1', expires_in: 300, scope: 'a b' } }));
    const conn = settings({ auth: { scheme: 'oauth_client_credentials', tokenUrl: `${up.url}/token`, scopes: ['a', 'b', 'c'] } });
    const r = await createOpenApiAdapter().detectScopes({ connection: conn, credential: cred('oauth_client_credentials', { client_id: 'id', client_secret: 'sec' }) });
    expect(r).toEqual({ detectable: true, source: 'oauth_token_response', values: ['a', 'b'] });
    expect(up.requests).toHaveLength(1);
  });

  it('SEC-7 OAuth without scope in the token response reports the requested scopes (RFC 6749 5.1)', async () => {
    up.route('POST', '/token', () => ({ status: 200, body: { access_token: 'at-2', expires_in: 300 } }));
    const conn = settings({ auth: { scheme: 'oauth_client_credentials', tokenUrl: `${up.url}/token`, scopes: ['catalog'] } });
    const r = await createOpenApiAdapter().detectScopes({ connection: conn, credential: cred('oauth_client_credentials', { client_id: 'id', client_secret: 'sec' }) });
    expect(r).toEqual({ detectable: true, source: 'oauth_token_response', values: ['catalog'] });
  });

  it('SEC-7 OAuth reuses the cached token of an earlier read instead of fetching a new one', async () => {
    up.route('POST', '/token', () => ({ status: 200, body: { access_token: 'at-3', expires_in: 300, scope: 'x' } }));
    up.route('GET', '/rest/default/V1/products', () => ({ status: 200, body: magentoBody }));
    const conn = settings({ auth: { scheme: 'oauth_client_credentials', tokenUrl: `${up.url}/token`, scopes: ['x', 'y'] } });
    const credential = cred('oauth_client_credentials', { client_id: 'id', client_secret: 'sec' });
    const a = createOpenApiAdapter();
    await a.read({ connection: conn, mapping: searchMapping, args: {}, credential });
    const r = await a.detectScopes({ connection: conn, credential });
    expect(r).toEqual({ detectable: true, source: 'oauth_token_response', values: ['x'] });
    expect(up.requests.filter((q) => q.path === '/token')).toHaveLength(1);
  });

  it('SEC-7 an OAuth token endpoint failure is not detectable', async () => {
    up.route('POST', '/token', () => ({ status: 401 }));
    const conn = settings({ auth: { scheme: 'oauth_client_credentials', tokenUrl: `${up.url}/token`, scopes: [] } });
    const r = await createOpenApiAdapter().detectScopes({ connection: conn, credential: cred('oauth_client_credentials', { client_id: 'id', client_secret: 'sec' }) });
    expect(r).toEqual({ detectable: false, source: 'none', values: [] });
  });
});

describe('NFR-11 instrumentation through the adapter', () => {
  it('NFR-11 the default client passes the hook to reads and to the spec fetch', async () => {
    const doc: unknown = JSON.parse(await (await import('node:fs/promises')).readFile(fixture('oas30-mini.json'), 'utf8'));
    up.route('GET', '/spec.json', () => ({ status: 200, body: doc }));
    up.route('GET', '/rest/default/V1/products', () => ({ status: 200, body: magentoBody }));
    const starts: RequestAttempt[] = [];
    const instrumentation: RequestInstrumentation = {
      start(attempt) {
        starts.push(attempt);
        return { headers: { traceparent: '00-0af7651916cd43dd8448eb211c80319c-b7ad6b7169203331-01' }, end: () => undefined };
      },
    };
    const adapter = createOpenApiAdapter({ instrumentation });
    const conn = settings({ auth: { scheme: 'bearer' } });
    expect((await adapter.resolver.resolveSpec({ connection: conn, spec: { url: `${up.url}/spec.json` } })).ok).toBe(true);
    const r = await adapter.read({ connection: conn, mapping: searchMapping, args: { q: 'bag' }, credential: cred('bearer', { token: 'opaque-token-1' }) });
    expect(r.ok).toBe(true);
    expect(starts).toEqual([
      { connection: conn.id, method: 'GET', host: '127.0.0.1' },
      { connection: conn.id, method: 'GET', host: '127.0.0.1' },
    ]);
    expect(up.requests.map((q) => q.headers.traceparent)).toEqual([
      '00-0af7651916cd43dd8448eb211c80319c-b7ad6b7169203331-01',
      '00-0af7651916cd43dd8448eb211c80319c-b7ad6b7169203331-01',
    ]);
  });
});
