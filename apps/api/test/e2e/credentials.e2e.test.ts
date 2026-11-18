import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { request } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Writable } from 'node:stream';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { pageLogin, startFakeUpstream, startTestIssuer, type FakeUpstream, type StartedPostgres, type TestIssuer, type TestLoginUser } from '@aiops/testing';
import { createLogger } from '../../src/logger.js';
import { auditRows, startApi, startDatabase, vaultOf, type RunningApi } from './helpers.js';

const CREDENTIALS_CONFIG = fileURLToPath(new URL('./fixtures/credentials-config', import.meta.url));
/** Obviously fake secret values; the tests prove they never come back (SEC-3). */
const SHOP_SECRET = 'e2e-only-page-entered-shop-token-0123456789';
const REJECTED_SECRET = 'e2e-only-rejected-secret-value-abcdefghij';
const DENIED_SECRET = 'e2e-only-denied-secret-value-klmnopqrstu';
const MALFORMED_SECRET = 'SUPERSECRET123e2eOnlyMalformedBody';
const WEBHOOK_SECRET = 'secret-part';
const SECRETS = [WEBHOOK_SECRET, SHOP_SECRET, REJECTED_SECRET, DENIED_SECRET, MALFORMED_SECRET];

const CAROL: TestLoginUser = { sub: 'carol-id', username: 'carol', groups: ['admins'] };
const DAVE: TestLoginUser = { sub: 'dave-id', username: 'dave', groups: ['platform'] };
const BOB: TestLoginUser = { sub: 'bob-id', username: 'bob', groups: ['support'] };

let postgres: StartedPostgres;
let databaseUrl: string;
let issuer: TestIssuer;
let upstream: FakeUpstream;
let api: RunningApi;
let configDir: string;
let webDir: string;
let origin: string;
const logLines: string[] = [];
/** Every response body the tests received. */
const bodies: string[] = [];

interface Page {
  readonly cookie: string;
  readonly csrfToken: string;
}

beforeAll(async () => {
  ({ postgres, databaseUrl } = await startDatabase());
  issuer = await startTestIssuer();
  upstream = await startFakeUpstream();
  upstream.route('GET', '/rest/V1/products', () => ({ status: 200, body: { items: [{ sku: 'acme-1' }, { sku: 'acme-2' }], total_count: 2 } }));
  configDir = await mkdtemp(join(tmpdir(), 'aiops-credentials-e2e-'));
  await cp(CREDENTIALS_CONFIG, configDir, { recursive: true });
  const connections = join(configDir, 'connections.yaml');
  await writeFile(connections, (await readFile(connections, 'utf8')).replaceAll('__UPSTREAM_URL__', upstream.url));
  // A stand-in bundle: the e2e does not depend on the web build.
  webDir = await mkdtemp(join(tmpdir(), 'aiops-web-e2e-'));
  await mkdir(join(webDir, 'assets'));
  await writeFile(join(webDir, 'index.html'), '<!doctype html><title>Credentials</title><div id="root"></div>');
  await writeFile(join(webDir, 'assets', 'app-abc123.js'), 'console.log("app");');
  const stream = new Writable({
    write(chunk: Buffer, _encoding, done) {
      logLines.push(chunk.toString('utf8'));
      done();
    },
  });
  api = await startApi(databaseUrl, { issuer, configDir, webDir, logger: createLogger('debug', stream) });
  origin = new URL(api.url).origin;
});

afterAll(async () => {
  await api.close();
  await upstream.close();
  await issuer.close();
  await postgres.stop();
  await rm(configDir, { recursive: true });
  await rm(webDir, { recursive: true });
});

async function login(user: TestLoginUser): Promise<Page> {
  issuer.setLoginUser(user);
  const { cookie, csrfToken } = await pageLogin(api.url, user.username ?? user.sub, 'unused');
  return { cookie, csrfToken };
}

interface Answer {
  readonly status: number;
  readonly body: unknown;
  readonly correlationId: string;
}

/** Sends a request and records the response body for the SEC-3 search. */
async function send(method: string, path: string, headers: Record<string, string>, body?: unknown): Promise<Answer> {
  const response = await fetch(`${api.url}${path}`, {
    method,
    redirect: 'manual',
    headers: { ...headers, ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const text = await response.text();
  bodies.push(text);
  return { status: response.status, body: text === '' ? undefined : (JSON.parse(text) as unknown), correlationId: response.headers.get('x-correlation-id') ?? '' };
}

const mutating = (page: Page): Record<string, string> => ({ cookie: page.cookie, origin, 'x-csrf-token': page.csrfToken });
const putSecret = (page: Page, ref: string, secret: unknown, headers = mutating(page)): Promise<Answer> => send('PUT', `/api/v1/credentials/${ref}`, headers, secret);
const testConnection = (page: Page, id: string, headers = mutating(page)): Promise<Answer> => send('POST', `/api/v1/connections/${id}/test`, headers);
const list = async (page: Page): Promise<Record<string, unknown>[]> => {
  const answer = await send('GET', '/api/v1/credentials', { cookie: page.cookie });
  expect(answer.status).toBe(200);
  return answer.body as Record<string, unknown>[];
};
const rowsOf = (action: string, correlationId: string) => auditRows(databaseUrl, 'action = $1 and correlation_id = $2', [action, correlationId]);

describe('UI-5 credentials are entered only on the trusted page', () => {
  it('UI-5 UI-7 GET lists only the refs the role manages, with the form fields, and set:false before entry', async () => {
    const carol = await login(CAROL);
    expect(await list(carol)).toEqual([
      { ref: 'ops-chat-webhook', scheme: 'webhook_url', connections: [], notifications: ['ops-chat'], fields: ['url'], set: false },
      { ref: 'shop-token', scheme: 'bearer', connections: ['shop'], notifications: [], fields: ['token'], set: false },
    ]);
    const dave = await login(DAVE);
    expect((await list(dave)).map((r) => r.ref)).toEqual(['erp-key', 'ops-chat-webhook', 'shop-token']);
    expect((await list(dave)).find((r) => r.ref === 'erp-key')).toMatchObject({ scheme: 'api_key', fields: ['key'], connections: ['erp'] });
    const bob = await login(BOB);
    expect(await list(bob)).toEqual([]);
  });

  it('UI-5 AUD-1 PUT stores the secret (204), audits credential.set, and GET then shows set:true without a value', async () => {
    const carol = await login(CAROL);
    const answer = await putSecret(carol, 'shop-token', { token: SHOP_SECRET });
    expect(answer.status).toBe(204);
    expect(await rowsOf('credential.set', answer.correlationId)).toEqual([
      expect.objectContaining({ actor: 'carol-id', client_id: 'aiops-web', outcome: 'ok', details: { ref: 'shop-token', scheme: 'bearer', keyVersion: 1 } }),
    ]);
    const entry = (await list(carol)).find((r) => r.ref === 'shop-token');
    expect(entry).toEqual({
      ref: 'shop-token',
      scheme: 'bearer',
      connections: ['shop'],
      notifications: [],
      fields: ['token'],
      set: true,
      updatedAt: expect.any(String) as unknown,
      updatedBy: 'carol-id',
      keyVersion: 1,
    });
    const handle = await vaultOf(api).handle('shop-token');
    expect(await handle?.open()).toEqual({ token: SHOP_SECRET });
  });

  it('UI-5 a body that does not match the scheme answers 400 invalid_secret with field names only', async () => {
    const carol = await login(CAROL);
    const answer = await putSecret(carol, 'shop-token', { token: '', extra: REJECTED_SECRET });
    expect(answer.status).toBe(400);
    expect(answer.body).toEqual({ error: 'invalid_secret', fields: expect.arrayContaining(['token']) as unknown });
    expect(await rowsOf('credential.set', answer.correlationId)).toEqual([
      expect.objectContaining({ outcome: 'denied', details: { ref: 'shop-token', reason: 'invalid_secret' } }),
    ]);
    expect(await (await vaultOf(api).handle('shop-token'))?.open()).toEqual({ token: SHOP_SECRET });
  });

  it('UI-5 an unknown ref is refused as forbidden, like a ref of another role', async () => {
    const dave = await login(DAVE);
    const answer = await putSecret(dave, 'no-such-ref', { token: DENIED_SECRET });
    expect(answer.status).toBe(403);
    expect(answer.body).toEqual({ error: 'forbidden' });
  });
});

describe('UI-5 SEC-2 webhook URL credentials', () => {
  it('UI-5 SEC-2 a webhook URL credential is listed, stored and never echoed', async () => {
    const carol = await login(CAROL);
    const entry = { ref: 'ops-chat-webhook', scheme: 'webhook_url', connections: [], notifications: ['ops-chat'], fields: ['url'], set: false };
    expect((await list(carol)).find((r) => r.ref === 'ops-chat-webhook')).toEqual(entry);
    const stored = await putSecret(carol, 'ops-chat-webhook', { url: `https://hooks.example.test/T/B/${WEBHOOK_SECRET}` });
    expect(stored.status).toBe(204);
    expect((await list(carol)).find((r) => r.ref === 'ops-chat-webhook')).toMatchObject({ set: true });
    const wrong = await putSecret(carol, 'ops-chat-webhook', { token: 'x' });
    expect(wrong).toMatchObject({ status: 400, body: { error: 'invalid_secret', fields: ['url'] } });
    const client = new pg.Client({ connectionString: databaseUrl });
    await client.connect();
    try {
      const audit = (await client.query<{ row: string }>('select row_to_json(audit_event)::text as row from audit_event')).rows.map((r) => r.row).join('\n');
      expect(audit).not.toContain(WEBHOOK_SECRET);
    } finally {
      await client.end();
    }
    expect(logLines.join('\n')).not.toContain(WEBHOOK_SECRET);
  });
});

describe('SEC-8 credential changes need a fresh session and CSRF protection', () => {
  it.each<[string, (page: Page) => Record<string, string>]>([
    ['no CSRF token', (p) => ({ cookie: p.cookie, origin })],
    ['a wrong CSRF token', (p) => ({ cookie: p.cookie, origin, 'x-csrf-token': 'not-the-token-of-this-session-0123456789abc' })],
    ['a foreign Origin', (p) => ({ cookie: p.cookie, origin: 'http://evil.example.test', 'x-csrf-token': p.csrfToken })],
  ])('SEC-8 a PUT with %s answers 403 csrf, stores nothing and audits a denied credential.set', async (_name, headers) => {
    const dave = await login(DAVE);
    const answer = await putSecret(dave, 'erp-key', { key: DENIED_SECRET }, headers(dave));
    expect(answer.status).toBe(403);
    expect(answer.body).toEqual({ error: 'csrf' });
    expect(await vaultOf(api).handle('erp-key')).toBeUndefined();
    expect(await rowsOf('credential.set', answer.correlationId)).toEqual([
      expect.objectContaining({ actor: 'dave-id', outcome: 'denied', details: { ref: 'erp-key', reason: 'csrf' } }),
    ]);
  });

  it('SEC-8 a PUT from a login older than 300 s answers 403 reauthentication_required and stores nothing', async () => {
    const stale = await login({ ...DAVE, authTime: Math.floor(Date.now() / 1000) - 301 });
    const answer = await putSecret(stale, 'erp-key', { key: DENIED_SECRET });
    expect(answer.status).toBe(403);
    expect(answer.body).toEqual({ error: 'reauthentication_required' });
    expect(await vaultOf(api).handle('erp-key')).toBeUndefined();
    expect(await rowsOf('credential.set', answer.correlationId)).toEqual([
      expect.objectContaining({ outcome: 'denied', details: { ref: 'erp-key', reason: 'reauthentication_required' } }),
    ]);
  });

  it('SEC-8 checks run in order: permission before CSRF, CSRF before freshness, freshness before the body', async () => {
    const stale = await login({ ...CAROL, authTime: Math.floor(Date.now() / 1000) - 301 });
    // Not a ref of carol's role, no CSRF, stale, invalid body → forbidden.
    expect((await putSecret(stale, 'erp-key', {}, { cookie: stale.cookie })).body).toEqual({ error: 'forbidden' });
    // Her ref, no CSRF, stale, invalid body → csrf.
    expect((await putSecret(stale, 'shop-token', {}, { cookie: stale.cookie })).body).toEqual({ error: 'csrf' });
    // Her ref, CSRF, stale, invalid body → reauthentication_required.
    expect((await putSecret(stale, 'shop-token', {})).body).toEqual({ error: 'reauthentication_required' });
    // Without a session nothing else is looked at.
    expect(await putSecret(stale, 'shop-token', {}, { origin })).toMatchObject({ status: 401, body: { error: 'unauthenticated' } });
  });

  it('SEC-8 a connection test needs CSRF but not a fresh login', async () => {
    const stale = await login({ ...CAROL, authTime: Math.floor(Date.now() / 1000) - 301 });
    const refused = await testConnection(stale, 'shop', { cookie: stale.cookie, origin });
    expect(refused).toMatchObject({ status: 403, body: { error: 'csrf' } });
    expect(await rowsOf('connection.test', refused.correlationId)).toEqual([
      expect.objectContaining({ actor: 'carol-id', outcome: 'denied', details: { connection: 'shop', reason: 'csrf' } }),
    ]);
    expect((await testConnection(stale, 'shop')).status).toBe(200);
  });
});

describe('CONN-7 connection test from the page', () => {
  it('CONN-7 AUD-1 POST test runs the declared read against the upstream and audits connection.test', async () => {
    const carol = await login(CAROL);
    upstream.requests.length = 0;
    const answer = await testConnection(carol, 'shop');
    expect(answer.status).toBe(200);
    expect(answer.body).toEqual({
      ok: true,
      operation: 'catalog.search_products',
      status: 200,
      durationMs: expect.any(Number) as unknown,
      itemCount: 2,
      scopes: { detectable: false, source: 'none', values: [] },
    });
    expect(upstream.requests).toHaveLength(1);
    expect(upstream.requests[0]?.query.get('brand')).toBe('acme');
    expect(upstream.requests[0]?.headers.authorization).toBe(`Bearer ${SHOP_SECRET}`);
    expect(await rowsOf('connection.test', answer.correlationId)).toEqual([
      expect.objectContaining({ actor: 'carol-id', client_id: 'aiops-web', outcome: 'ok', details: { connection: 'shop', ok: true, status: 200, scopesDetectable: false } }),
    ]);
  });

  it('CONN-7 a connection without a declared test reports ok:false with code mapping, without an upstream call', async () => {
    const dave = await login(DAVE);
    upstream.requests.length = 0;
    const answer = await testConnection(dave, 'erp');
    expect(answer.status).toBe(200);
    expect(answer.body).toMatchObject({ ok: false, code: 'mapping', message: 'no connection test is declared' });
    expect(upstream.requests).toEqual([]);
    expect(await rowsOf('connection.test', answer.correlationId)).toEqual([
      expect.objectContaining({ outcome: 'error', details: { connection: 'erp', ok: false, code: 'mapping', scopesDetectable: false } }),
    ]);
  });

  it('CONN-7 a connection whose ref the role does not manage, or that does not exist, is forbidden', async () => {
    const carol = await login(CAROL);
    expect(await testConnection(carol, 'erp')).toMatchObject({ status: 403, body: { error: 'forbidden' } });
    expect(await testConnection(carol, 'nowhere')).toMatchObject({ status: 403, body: { error: 'forbidden' } });
  });
});

describe('SEC-3 audited path parameters', () => {
  it('SEC-3 a ref or connection that is not ID-shaped is audited as (invalid)', async () => {
    const dave = await login(DAVE);
    const put = await putSecret(dave, encodeURIComponent('Not A Ref'), { token: DENIED_SECRET });
    expect(put).toMatchObject({ status: 403, body: { error: 'forbidden' } });
    expect(await rowsOf('credential.set', put.correlationId)).toEqual([
      expect.objectContaining({ subject: '(invalid)', outcome: 'denied', details: { ref: '(invalid)', reason: 'forbidden' } }),
    ]);
    const test = await testConnection(dave, 'NOT-AN-ID');
    expect(test).toMatchObject({ status: 403, body: { error: 'forbidden' } });
    expect(await rowsOf('connection.test', test.correlationId)).toEqual([
      expect.objectContaining({ subject: '(invalid)', outcome: 'denied', details: { connection: '(invalid)', reason: 'forbidden' } }),
    ]);
  });

  it('SEC-3 an ID-shaped unknown ref is audited as given', async () => {
    const dave = await login(DAVE);
    const put = await putSecret(dave, 'no-such-ref', { token: DENIED_SECRET });
    expect(await rowsOf('credential.set', put.correlationId)).toEqual([expect.objectContaining({ details: { ref: 'no-such-ref', reason: 'forbidden' } })]);
  });
});

describe('SEC-1 a user without manage_credentials', () => {
  it('SEC-1 bob is refused with 403 on PUT and on test, and both are audited as denied', async () => {
    const bob = await login(BOB);
    const put = await putSecret(bob, 'shop-token', { token: DENIED_SECRET });
    expect(put).toMatchObject({ status: 403, body: { error: 'forbidden' } });
    expect(await rowsOf('credential.set', put.correlationId)).toEqual([
      expect.objectContaining({ actor: 'bob-id', outcome: 'denied', details: { ref: 'shop-token', reason: 'forbidden' } }),
    ]);
    const test = await testConnection(bob, 'shop');
    expect(test).toMatchObject({ status: 403, body: { error: 'forbidden' } });
    expect(await rowsOf('connection.test', test.correlationId)).toEqual([
      expect.objectContaining({ actor: 'bob-id', outcome: 'denied', details: { connection: 'shop', reason: 'forbidden' } }),
    ]);
    expect(await (await vaultOf(api).handle('shop-token'))?.open()).toEqual({ token: SHOP_SECRET });
  });

  it('SEC-1 the credential routes need a session', async () => {
    expect((await send('GET', '/api/v1/credentials', {})).status).toBe(401);
    expect((await send('POST', '/api/v1/connections/shop/test', { origin })).status).toBe(401);
  });
});

describe('SEC-3 credential values never echo', () => {
  it('SEC-3 a malformed or oversized JSON body gets a fixed error body that echoes none of it, on every route', async () => {
    const page = await login(CAROL);
    const malformed = `{"token":${MALFORMED_SECRET}}`;
    const routes: [string, string, Record<string, string>][] = [
      ['PUT', '/api/v1/credentials/shop-token', mutating(page)],
      ['POST', '/mcp', { accept: 'application/json, text/event-stream' }],
      ['POST', '/api/v1/connections/shop/test', mutating(page)],
    ];
    for (const [method, path, headers] of routes) {
      const response = await fetch(`${api.url}${path}`, { method, headers: { ...headers, 'content-type': 'application/json' }, body: malformed });
      const text = await response.text();
      bodies.push(text);
      expect(response.status, `${method} ${path}`).toBe(400);
      expect(JSON.parse(text), `${method} ${path}`).toEqual({ error: 'invalid_json' });
    }
    const oversized = `{"token":"${MALFORMED_SECRET}","pad":"${'x'.repeat(5 * 1024 * 1024)}"`;
    const response = await fetch(`${api.url}/mcp`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: oversized });
    const text = await response.text();
    bodies.push(text);
    expect(response.status).toBe(413);
    expect(JSON.parse(text)).toEqual({ error: 'payload_too_large' });
    expect(logLines.join('\n')).not.toContain(MALFORMED_SECRET);
  });

  it('SEC-3 no secret value or its Base64 appears in any audit row, log line or response body', async () => {
    const client = new pg.Client({ connectionString: databaseUrl });
    await client.connect();
    let audit: string;
    try {
      audit = (await client.query<{ row: string }>('select row_to_json(audit_event)::text as row from audit_event')).rows.map((r) => r.row).join('\n');
    } finally {
      await client.end();
    }
    expect(audit).toContain('credential.set');
    const logs = logLines.join('\n');
    expect(bodies.length).toBeGreaterThan(20);
    const responses = bodies.join('\n');
    for (const secret of SECRETS) {
      for (const value of [secret, Buffer.from(secret).toString('base64'), Buffer.from(secret).toString('base64url')]) {
        expect(audit).not.toContain(value);
        expect(logs).not.toContain(value);
        expect(responses).not.toContain(value);
      }
    }
  });
});

/** A raw request: `fetch` would normalise dot segments before sending. */
function raw(path: string): Promise<{ status: number; headers: Record<string, string | string[] | undefined>; body: string }> {
  return new Promise((resolve, reject) => {
    const req = request({ host: '127.0.0.1', port: new URL(api.url).port, path, method: 'GET' }, (res) => {
      let body = '';
      res.on('data', (chunk: Buffer) => (body += chunk.toString('utf8')));
      res.on('end', () => {
        resolve({ status: res.statusCode ?? 0, headers: res.headers, body });
      });
    });
    req.on('error', reject);
    req.end();
  });
}

describe('UI-5 UI-2 the api serves the credential page', () => {
  it('UI-5 GET /app/credentials without a session returns the HTML shell with the security headers', async () => {
    const page = await raw('/app/credentials');
    expect(page.status).toBe(200);
    expect(page.body).toContain('<div id="root">');
    expect(page.headers['content-type']).toMatch(/text\/html/);
    expect(page.headers['content-security-policy']).toBe("default-src 'self'; frame-ancestors 'none'; form-action 'self'; base-uri 'none'");
    expect(page.headers['x-content-type-options']).toBe('nosniff');
    expect(page.headers['referrer-policy']).toBe('no-referrer');
    expect(page.headers['cache-control']).toBe('no-store');
    expect((await raw('/app/')).status).toBe(200);
    expect((await raw('/app')).status).toBe(200);
  });

  it('UI-5 assets are served with their type and the headers; a missing asset is 404, not the shell', async () => {
    const asset = await raw('/app/assets/app-abc123.js');
    expect(asset.status).toBe(200);
    expect(asset.headers['content-type']).toMatch(/javascript/);
    expect(asset.headers['content-security-policy']).toBeDefined();
    expect(asset.headers['cache-control']).not.toBe('no-store');
    expect((await raw('/app/assets/missing.js')).status).toBe(404);
  });

  it('SEC-1 path traversal out of the bundle directory is 404, raw and encoded', async () => {
    for (const path of ['/app/../../etc/passwd', '/app/..%2f..%2fetc%2fpasswd', '/app/%2e%2e/%2e%2e/etc/passwd', '/app/assets/..%2f..%2f..%2fpackage.json', '/app/%00', '/app/..\\..\\etc\\passwd']) {
      const answer = await raw(path);
      expect(answer.status, path).toBe(404);
      expect(answer.body, path).not.toContain('root:');
    }
  });

  it('SEC-1 the /app routes do not shadow the guarded and public api routes', async () => {
    expect((await send('GET', '/api/v1/credentials', {})).status).toBe(401);
    expect((await send('GET', '/api/v1/session', {})).status).toBe(401);
    expect((await send('GET', '/healthz', {})).status).toBe(200);
    expect((await send('POST', '/app/credentials', {})).status).toBe(404);
  });
});
