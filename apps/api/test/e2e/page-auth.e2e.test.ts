import { createHash } from 'node:crypto';
import { Writable } from 'node:stream';
import { METHOD_METADATA } from '@nestjs/common/constants.js';
import { DiscoveryService, MetadataScanner, ModulesContainer, Reflector } from '@nestjs/core';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { pageLogin, startTestIssuer, type StartedPostgres, type TestIssuer } from '@aiops/testing';
import { createLogger } from '../../src/logger.js';
import { routeAccess } from '../../src/web/access.js';
import { auditRows, startApi, startDatabase, type RunningApi } from './helpers.js';

let postgres: StartedPostgres;
let databaseUrl: string;
let issuer: TestIssuer;
let a: RunningApi;
let b: RunningApi;
const logLines: string[] = [];
/** Every secret-like value seen during the tests; none may reach audit rows or logs (SEC-3). */
const secrets = new Set<string>();

const CAROL = { sub: 'carol-id', username: 'carol', groups: ['admins'] };
const sha256 = (v: string): string => createHash('sha256').update(v).digest('hex');

beforeAll(async () => {
  ({ postgres, databaseUrl } = await startDatabase());
  issuer = await startTestIssuer();
  const stream = new Writable({
    write(chunk: Buffer, _encoding, done) {
      logLines.push(chunk.toString('utf8'));
      done();
    },
  });
  a = await startApi(databaseUrl, { issuer, logger: createLogger('debug', stream) });
  b = await startApi(databaseUrl, { issuer, logger: createLogger('debug', stream) });
  issuer.setLoginUser(CAROL);
});

afterAll(async () => {
  await a.close();
  await b.close();
  await issuer.close();
  await postgres.stop();
});

async function query<T extends pg.QueryResultRow>(sql: string, params: unknown[] = []): Promise<T[]> {
  const client = new pg.Client({ connectionString: databaseUrl });
  await client.connect();
  try {
    return (await client.query<T>(sql, params)).rows;
  } finally {
    await client.end();
  }
}

const get = (url: string, headers: Record<string, string> = {}): Promise<Response> => fetch(url, { redirect: 'manual', headers });

/** `/auth/login` → the issuer's authorization URL. */
async function startLogin(api: RunningApi, params = 'return_to=/app/'): Promise<URL> {
  const response = await get(`${api.url}/auth/login?${params}`);
  expect(response.status).toBe(302);
  const location = new URL(response.headers.get('location') ?? '');
  secrets.add(location.searchParams.get('state') ?? '');
  secrets.add(location.searchParams.get('nonce') ?? '');
  return location;
}

/** The issuer's answer: the callback URL on the api. */
async function authorize(location: URL): Promise<URL> {
  const response = await get(location.toString());
  const callback = new URL(response.headers.get('location') ?? '');
  const code = callback.searchParams.get('code');
  if (code !== null) secrets.add(code);
  return callback;
}

function sessionCookieOf(response: Response): string {
  const header = response.headers.getSetCookie().find((c) => c.startsWith('aiops_session=')) ?? '';
  const value = header.split(';')[0] ?? '';
  secrets.add(value.slice('aiops_session='.length));
  return value;
}

async function loginRows(correlationId: string | null) {
  return auditRows(databaseUrl, "action = 'auth.login' and correlation_id = $1", [correlationId]);
}

describe('AUTH-5 pages log in through the identity provider', () => {
  it('AUTH-5 /auth/login redirects with code + S256 PKCE, state, nonce and scope openid, keeping only hashes', async () => {
    const location = await startLogin(a, 'return_to=/app/credentials');
    expect(`${location.origin}${location.pathname}`).toBe(issuer.authorizationUrl);
    const q = location.searchParams;
    expect(Object.fromEntries([...q].filter(([k]) => !['state', 'nonce', 'code_challenge'].includes(k)))).toEqual({
      response_type: 'code',
      client_id: 'aiops-web',
      redirect_uri: `${a.url}/auth/callback`,
      scope: 'openid',
      code_challenge_method: 'S256',
    });
    expect(q.get('code_challenge')).toMatch(/^[A-Za-z0-9_-]{43}$/);
    const state = q.get('state') ?? '';
    const rows = await query<{ state_hash: string; return_to: string; fresh: boolean }>('select * from web_login where state_hash = $1', [sha256(state)]);
    expect(rows).toEqual([expect.objectContaining({ return_to: '/app/credentials', fresh: false })]);
    expect(JSON.stringify(await query('select * from web_login'))).not.toContain(state);
  });

  it('AUTH-5 the callback creates a strict HttpOnly session cookie, audits the login, and the session shows mapped roles', async () => {
    const callback = await authorize(await startLogin(a, 'return_to=/app/credentials'));
    expect(`${callback.origin}${callback.pathname}`).toBe(`${a.url}/auth/callback`);
    const response = await get(callback.toString());
    expect(response.status).toBe(302);
    expect(response.headers.get('location')).toBe('/app/credentials');
    const setCookie = response.headers.getSetCookie().find((c) => c.startsWith('aiops_session=')) ?? '';
    expect(setCookie).toMatch(/; HttpOnly/);
    expect(setCookie).toMatch(/; SameSite=Strict/);
    expect(setCookie).toMatch(/; Path=\//);
    expect(setCookie).not.toMatch(/Secure/); // the e2e public URL is http
    const cookie = sessionCookieOf(response);
    expect(cookie.length).toBeGreaterThan('aiops_session='.length + 40);

    const last = issuer.tokenRequests.at(-1);
    expect(last?.authorization).toMatch(/^Basic /);
    expect(last?.body.get('code_verifier')).toMatch(/^[A-Za-z0-9_-]{43}$/);

    const session = await get(`${a.url}/api/v1/session`, { cookie });
    expect(session.status).toBe(200);
    expect(session.headers.get('x-correlation-id')).toMatch(/^[0-9a-f-]{36}$/);
    const body = (await session.json()) as Record<string, unknown>;
    expect(body).toEqual({
      subject: 'carol-id',
      username: 'carol',
      roles: ['integration_admin'],
      csrfToken: expect.stringMatching(/^[A-Za-z0-9_-]{43}$/) as unknown,
      authTime: expect.any(String) as unknown,
      expiresAt: expect.any(String) as unknown,
    });
    secrets.add(String(body.csrfToken));

    const rows = await loginRows(response.headers.get('x-correlation-id'));
    expect(rows).toEqual([expect.objectContaining({ actor: 'carol-id', client_id: 'aiops-web', outcome: 'ok', details: { fresh: false } })]);
    // Only the hash of the cookie is stored.
    const stored = await query<{ id_hash: string }>('select id_hash from web_session where id_hash = $1', [sha256(cookie.slice('aiops_session='.length))]);
    expect(stored).toHaveLength(1);
  });

  it('AUTH-5 a replayed state is refused with 400 and an auth.login error row', async () => {
    const callback = await authorize(await startLogin(a));
    expect((await get(callback.toString())).status).toBe(302);
    const replay = await get(callback.toString());
    expect(replay.status).toBe(400);
    expect(replay.headers.getSetCookie()).toEqual([]);
    expect(await loginRows(replay.headers.get('x-correlation-id'))).toEqual([
      expect.objectContaining({ actor: 'unknown', outcome: 'error', details: { reason: 'state_unknown' } }),
    ]);
  });

  it.each([
    ['a wrong nonce', { nonce: 'another-nonce' }],
    ['another audience', { aud: 'aiops-mcp' }],
    ['another issuer', { iss: 'http://127.0.0.1:1/realms/evil' }],
    ['no auth_time', { omitAuthTime: true }],
    ['an unpublished key', { unpublishedKey: true }],
  ])('AUTH-5 an ID token with %s ends in id_token_invalid and no session', async (_name, tamper) => {
    issuer.tamperIdToken(tamper);
    try {
      const response = await get((await authorize(await startLogin(a))).toString());
      expect(response.status).toBe(400);
      expect(response.headers.getSetCookie()).toEqual([]);
      expect(await loginRows(response.headers.get('x-correlation-id'))).toEqual([expect.objectContaining({ outcome: 'error', details: { reason: 'id_token_invalid' } })]);
    } finally {
      issuer.tamperIdToken(undefined);
    }
  });

  it('AUTH-5 a code the token endpoint refuses ends in code_exchange_failed', async () => {
    const state = (await startLogin(a)).searchParams.get('state') ?? '';
    const response = await get(`${a.url}/auth/callback?state=${encodeURIComponent(state)}&code=not-a-code`);
    expect(response.status).toBe(400);
    expect(await loginRows(response.headers.get('x-correlation-id'))).toEqual([expect.objectContaining({ details: { reason: 'code_exchange_failed' } })]);
  });

  it('AUTH-5 an error from the identity provider ends in idp_error', async () => {
    issuer.setLoginUser(undefined);
    try {
      const callback = await authorize(await startLogin(a));
      expect(callback.searchParams.get('error')).toBe('access_denied');
      const response = await get(callback.toString());
      expect(response.status).toBe(400);
      expect(await response.text()).not.toContain('access_denied');
      expect(await loginRows(response.headers.get('x-correlation-id'))).toEqual([expect.objectContaining({ details: { reason: 'idp_error' } })]);
    } finally {
      issuer.setLoginUser(CAROL);
    }
  });

  it.each([
    'https://evil.example.test/app/',
    '//evil.example.test/app/',
    '/\\evil.example.test/app/',
    '/app/../auth/logout',
    '/app',
    '/other/',
    'javascript:alert(1)',
    '',
  ])('AUTH-5 return_to %j becomes /app/', async (returnTo) => {
    const location = await startLogin(a, new URLSearchParams({ return_to: returnTo }).toString());
    const rows = await query<{ return_to: string }>('select return_to from web_login where state_hash = $1', [sha256(location.searchParams.get('state') ?? '')]);
    expect(rows).toEqual([{ return_to: '/app/' }]);
  });

  it('AUTH-5 return_to keeps a path, query and fragment under /app/; no return_to is /app/', async () => {
    const kept = await startLogin(a, new URLSearchParams({ return_to: '/app/credentials?ref=x#top' }).toString());
    expect(await query('select return_to from web_login where state_hash = $1', [sha256(kept.searchParams.get('state') ?? '')])).toEqual([{ return_to: '/app/credentials?ref=x#top' }]);
    const none = await startLogin(a, '');
    expect(await query('select return_to from web_login where state_hash = $1', [sha256(none.searchParams.get('state') ?? '')])).toEqual([{ return_to: '/app/' }]);
  });

  it('AUTH-5 SEC-8 fresh=1 adds prompt=login and max_age=0 and audits a fresh login', async () => {
    issuer.setLoginUser({ ...CAROL, authTime: Math.floor(Date.now() / 1000) - 3600 });
    try {
      const location = await startLogin(a, 'return_to=/app/&fresh=1');
      expect(location.searchParams.get('prompt')).toBe('login');
      expect(location.searchParams.get('max_age')).toBe('0');
      const response = await get((await authorize(location)).toString());
      expect(await loginRows(response.headers.get('x-correlation-id'))).toEqual([expect.objectContaining({ outcome: 'ok', details: { fresh: true } })]);
      const session = (await (await get(`${a.url}/api/v1/session`, { cookie: sessionCookieOf(response) })).json()) as { authTime: string };
      expect(Date.now() - Date.parse(session.authTime)).toBeLessThan(60_000);
    } finally {
      issuer.setLoginUser(CAROL);
    }
  });

  it('AUTH-5 the session keeps the auth_time of the ID token', async () => {
    const authTime = Math.floor(Date.now() / 1000) - 3600;
    issuer.setLoginUser({ ...CAROL, authTime });
    try {
      const { cookie } = await pageLogin(a.url, 'carol', 'unused');
      const session = (await (await get(`${a.url}/api/v1/session`, { cookie })).json()) as { authTime: string };
      expect(Date.parse(session.authTime)).toBe(authTime * 1000);
    } finally {
      issuer.setLoginUser(CAROL);
    }
  });

  it('AUTH-5 logout needs CSRF, ends the session, clears the cookie and is audited', async () => {
    const { cookie, csrfToken } = await pageLogin(a.url, 'carol', 'unused');
    secrets.add(csrfToken);
    const origin = new URL(a.url).origin;
    expect((await fetch(`${a.url}/auth/logout`, { method: 'POST', headers: { cookie, origin } })).status).toBe(403);
    const response = await fetch(`${a.url}/auth/logout`, { method: 'POST', headers: { cookie, origin, 'x-csrf-token': csrfToken } });
    expect(response.status).toBe(204);
    expect(response.headers.getSetCookie()).toEqual([expect.stringMatching(/^aiops_session=; .*Max-Age=0/)]);
    expect((await get(`${a.url}/api/v1/session`, { cookie })).status).toBe(401);
    expect(await auditRows(databaseUrl, "action = 'auth.logout' and correlation_id = $1", [response.headers.get('x-correlation-id')])).toEqual([
      expect.objectContaining({ actor: 'carol-id', client_id: 'aiops-web', outcome: 'ok' }),
    ]);
    const loggedOut = await get(`${a.url}/auth/logged-out`);
    expect(loggedOut.status).toBe(200);
    expect(await loggedOut.text()).toContain('logged out');
  });
});

describe('SEC-1 every page route is authorized', () => {
  it('SEC-1 every route handler is marked @Public or @PageAccess', () => {
    const discovery = new DiscoveryService(a.app.get(ModulesContainer));
    const scanner = new MetadataScanner();
    const reflector = new Reflector();
    const routes: { name: string; marked: boolean }[] = [];
    for (const wrapper of discovery.getControllers()) {
      const instance = wrapper.instance as object | undefined;
      if (instance === undefined || wrapper.metatype === null) continue;
      const prototype = Object.getPrototypeOf(instance) as Record<string, unknown>;
      for (const method of scanner.getAllMethodNames(prototype)) {
        const handler = prototype[method] as (...args: unknown[]) => unknown;
        if (Reflect.getMetadata(METHOD_METADATA, handler) === undefined) continue;
        const marked = routeAccess(reflector, handler, wrapper.metatype) !== 'none';
        routes.push({ name: `${wrapper.name}.${method}`, marked });
      }
    }
    expect(routes.map((r) => r.name)).toEqual(
      expect.arrayContaining(['McpController.handle', 'HealthController.live', 'AuthController.login', 'AuthController.callback', 'SessionController.current']),
    );
    expect(routes.filter((r) => !r.marked)).toEqual([]);
  });

  it('SEC-1 /api/v1/session without a session answers 401 with a correlation ID', async () => {
    const response = await get(`${a.url}/api/v1/session`);
    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({ error: 'unauthenticated' });
    expect(response.headers.get('x-correlation-id')).toMatch(/^[0-9a-f-]{36}$/);
    expect((await get(`${a.url}/api/v1/session`, { cookie: 'aiops_session=forged' })).status).toBe(401);
  });

  it('SEC-1 public routes still answer without a session', async () => {
    expect((await get(`${a.url}/healthz`)).status).toBe(200);
    expect((await get(`${a.url}/.well-known/oauth-protected-resource`)).status).toBe(200);
  });
});

describe('NFR-3 page sessions work on any instance', () => {
  it('NFR-3 a session created on instance A is accepted by instance B', async () => {
    const { cookie } = await pageLogin(a.url, 'carol', 'unused');
    const response = await get(`${b.url}/api/v1/session`, { cookie });
    expect(response.status).toBe(200);
    expect(((await response.json()) as { subject: string }).subject).toBe('carol-id');
  });
});

describe('SEC-3 no login secret reaches audit or logs', () => {
  it('SEC-3 state, nonce, code, cookie and CSRF values appear in no audit row and no log line', async () => {
    const audit = JSON.stringify(await auditRows(databaseUrl));
    const logs = logLines.join('\n');
    const values = [...secrets].filter((s) => s.length >= 16);
    expect(values.length).toBeGreaterThan(10);
    for (const value of values) {
      expect(audit).not.toContain(value);
      expect(logs).not.toContain(value);
    }
  });
});
