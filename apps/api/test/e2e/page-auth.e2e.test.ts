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

/** The `aiops_login` cookie each `/auth/login` set, by state. */
const loginCookies = new Map<string, string>();
/** The raw `Set-Cookie` of the last `/auth/login`. */
let lastLoginSetCookie = '';

/** `/auth/login` → the issuer's authorization URL. */
async function startLogin(api: RunningApi, params = 'return_to=/app/'): Promise<URL> {
  const response = await get(`${api.url}/auth/login?${params}`);
  expect(response.status).toBe(302);
  const location = new URL(response.headers.get('location') ?? '');
  const state = location.searchParams.get('state') ?? '';
  secrets.add(state);
  secrets.add(location.searchParams.get('nonce') ?? '');
  lastLoginSetCookie = response.headers.getSetCookie().find((c) => c.startsWith('aiops_login=')) ?? '';
  loginCookies.set(state, lastLoginSetCookie.split(';')[0] ?? '');
  return location;
}

/** Follows the callback like the browser that started the login: with its `aiops_login` cookie unless `cookie` is given. */
function complete(callback: URL, cookie?: string): Promise<Response> {
  const sent = cookie ?? loginCookies.get(callback.searchParams.get('state') ?? '') ?? '';
  return get(callback.toString(), sent === '' ? {} : { cookie: sent });
}

/** The callback always clears the login cookie on its own path. */
const LOGIN_CLEARED = /^aiops_login=; (?=.*Path=\/auth\/callback)(?=.*Max-Age=0)/;

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
    const response = await complete(callback);
    expect(response.status).toBe(302);
    expect(response.headers.get('location')).toBe('/app/credentials');
    expect(response.headers.getSetCookie()).toEqual(expect.arrayContaining([expect.stringMatching(LOGIN_CLEARED)]));
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
      fresh: true,
      expiresAt: expect.any(String) as unknown,
      viewAudit: false,
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
    expect((await complete(callback)).status).toBe(302);
    const replay = await complete(callback);
    expect(replay.status).toBe(400);
    expect(replay.headers.getSetCookie()).toEqual([expect.stringMatching(LOGIN_CLEARED)]);
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
      const response = await complete(await authorize(await startLogin(a)));
      expect(response.status).toBe(400);
      expect(response.headers.getSetCookie()).toEqual([expect.stringMatching(LOGIN_CLEARED)]);
      expect(await loginRows(response.headers.get('x-correlation-id'))).toEqual([expect.objectContaining({ outcome: 'error', details: { reason: 'id_token_invalid' } })]);
    } finally {
      issuer.tamperIdToken(undefined);
    }
  });

  it('AUTH-5 a code the token endpoint refuses ends in code_exchange_failed', async () => {
    const state = (await startLogin(a)).searchParams.get('state') ?? '';
    const response = await get(`${a.url}/auth/callback?state=${encodeURIComponent(state)}&code=not-a-code`, { cookie: loginCookies.get(state) ?? '' });
    expect(response.status).toBe(400);
    expect(await loginRows(response.headers.get('x-correlation-id'))).toEqual([expect.objectContaining({ details: { reason: 'code_exchange_failed' } })]);
  });

  it('AUTH-5 an error from the identity provider ends in idp_error', async () => {
    issuer.setLoginUser(undefined);
    try {
      const callback = await authorize(await startLogin(a));
      expect(callback.searchParams.get('error')).toBe('access_denied');
      const response = await complete(callback);
      expect(response.status).toBe(400);
      expect(await response.text()).not.toContain('access_denied');
      expect(await loginRows(response.headers.get('x-correlation-id'))).toEqual([expect.objectContaining({ details: { reason: 'idp_error' } })]);
    } finally {
      issuer.setLoginUser(CAROL);
    }
  });

  it('SEC-8 /auth/login binds the state to the browser with a Lax cookie scoped to the callback', async () => {
    const location = await startLogin(a);
    const state = location.searchParams.get('state') ?? '';
    expect(lastLoginSetCookie.split(';')[0]).toBe(`aiops_login=${state}`);
    expect(lastLoginSetCookie).toMatch(/; HttpOnly/);
    expect(lastLoginSetCookie).toMatch(/; SameSite=Lax/);
    expect(lastLoginSetCookie).toMatch(/; Path=\/auth\/callback/);
    expect(lastLoginSetCookie).toMatch(/; Max-Age=600/);
    expect(lastLoginSetCookie).not.toMatch(/Secure/);
  });

  it('SEC-8 a valid state and code without the login cookie are refused as state_unknown', async () => {
    const callback = await authorize(await startLogin(a));
    const response = await complete(callback, '');
    expect(response.status).toBe(400);
    expect(response.headers.getSetCookie()).toEqual([expect.stringMatching(LOGIN_CLEARED)]);
    expect(await loginRows(response.headers.get('x-correlation-id'))).toEqual([
      expect.objectContaining({ actor: 'unknown', outcome: 'error', details: { reason: 'state_unknown' } }),
    ]);
    // The refused attempt did not consume the login; the browser that started it can still finish.
    expect((await complete(callback)).status).toBe(302);
  });

  it("SEC-8 a callback carrying someone else's login cookie is refused (login CSRF)", async () => {
    const attacker = await authorize(await startLogin(a));
    await startLogin(a);
    const victimCookie = lastLoginSetCookie.split(';')[0] ?? '';
    const response = await complete(attacker, victimCookie);
    expect(response.status).toBe(400);
    expect(response.headers.getSetCookie().some((c) => c.startsWith('aiops_session='))).toBe(false);
    expect(await loginRows(response.headers.get('x-correlation-id'))).toEqual([expect.objectContaining({ details: { reason: 'state_unknown' } })]);
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
      const response = await complete(await authorize(location));
      expect(await loginRows(response.headers.get('x-correlation-id'))).toEqual([expect.objectContaining({ outcome: 'ok', details: { fresh: true } })]);
      const session = (await (await get(`${a.url}/api/v1/session`, { cookie: sessionCookieOf(response) })).json()) as { authTime: string };
      expect(Date.now() - Date.parse(session.authTime)).toBeLessThan(60_000);
    } finally {
      issuer.setLoginUser(CAROL);
    }
  });

  it('AUTH-5 SEC-8 the session keeps the auth_time of the ID token and reports whether it is fresh', async () => {
    const authTime = Math.floor(Date.now() / 1000) - 3600;
    issuer.setLoginUser({ ...CAROL, authTime });
    try {
      const { cookie } = await pageLogin(a.url, 'carol', 'unused');
      const session = (await (await get(`${a.url}/api/v1/session`, { cookie })).json()) as { authTime: string; fresh: boolean };
      expect(Date.parse(session.authTime)).toBe(authTime * 1000);
      // SEC-8: older than AIOPS_FRESH_AUTH_SECONDS, so the page knows to re-authenticate before a credential change.
      expect(session.fresh).toBe(false);
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
  it('SEC-1 every route handler, including the approval page routes, is marked @Public or @PageAccess', () => {
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
      expect.arrayContaining(['McpController.handle', 'HealthController.live', 'AuthController.login', 'AuthController.callback', 'SessionController.current', 'CredentialsController.list', 'CredentialsController.put', 'ConnectionsController.test',
        'ApprovalsController.queue',
        'ChangeSetPagesController.detail',
        'ChangeSetPagesController.items',
        'ChangeSetPagesController.sample',
        'ChangeSetPagesController.decide',
        'ChangeSetPagesController.start',
        'ChangeSetExportController.download',
        'ChangeSetActionsController.submit',
        'ChangeSetActionsController.exclude',
        'ChangeSetActionsController.rollback',
        'AuditController.search',
        'AuditController.export',
      ]),
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

describe('AUTH-5 expired login state and sessions are purged', () => {
  it('AUTH-5 the first /auth/login of an instance removes expired web_login and web_session rows', async () => {
    await query("insert into web_login (state_hash, code_verifier, nonce, return_to, fresh, expires_at) values ('expired-login', 'v', 'n', '/app/', false, now() - interval '1 minute')");
    await query(
      "insert into web_session (id_hash, subject, client_id, groups, auth_time, csrf_token, expires_at) values ('expired-session', 's', 'aiops-web', '[]', now(), 'c', now() - interval '1 minute')",
    );
    // Instance b has not served /auth/login yet, so its first one purges.
    await startLogin(b);
    expect(await query("select state_hash from web_login where state_hash = 'expired-login'")).toEqual([]);
    expect(await query("select id_hash from web_session where id_hash = 'expired-session'")).toEqual([]);
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
