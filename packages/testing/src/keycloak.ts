/**
 * Real Keycloak for tests (AUTH-8): the shipped realm file, the shipped bootstrap
 * script, and an authorization-code + PKCE login that posts the login form like a
 * browser would. Ported from spike 2 (`spikes/2-auth-keycloak/check.mjs`).
 */
import { execFile } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { GenericContainer, Wait, type StartedTestContainer } from 'testcontainers';
import { TEST_WEB_CLIENT_SECRET } from './test-issuer.js';

export const KEYCLOAK_IMAGE = 'quay.io/keycloak/keycloak:26.8.2';
const REPO = new URL('../../../', import.meta.url);
const REALM_FILE = fileURLToPath(new URL('deploy/keycloak/realm-aiops.json', REPO));
const BOOTSTRAP = fileURLToPath(new URL('deploy/keycloak/bootstrap.mjs', REPO));
const ADMIN_PASSWORD = 'dev-only-test-admin-password';
const run = promisify(execFile);

export interface StartedKeycloak {
  /** Base URL as seen from the test process (also the issuer's origin). */
  readonly baseUrl: string;
  readonly issuer: string;
  readonly jwksUrl: string;
  /** Runs `deploy/keycloak/bootstrap.mjs` against this Keycloak with extra environment. */
  bootstrap(env?: Record<string, string>): Promise<string>;
  stop(): Promise<void>;
}

export interface StartKeycloakOptions {
  readonly mcpResource: string;
  /** Origin of the api's pages; `aiops-web` redirects to `${publicUrl}/auth/callback`. Default `http://localhost:8400`. */
  readonly publicUrl?: string;
  /** Secret of `aiops-web`; default the e2e api's (`TEST_WEB_CLIENT_SECRET`). */
  readonly webClientSecret?: string;
}

export async function startKeycloak(options: StartKeycloakOptions): Promise<StartedKeycloak> {
  const container: StartedTestContainer = await new GenericContainer(KEYCLOAK_IMAGE)
    .withCommand(['start-dev', '--import-realm', '--http-port=8080', '--features=cimd,resource-indicators'])
    .withEnvironment({
      KC_BOOTSTRAP_ADMIN_USERNAME: 'admin',
      KC_BOOTSTRAP_ADMIN_PASSWORD: ADMIN_PASSWORD,
      MCP_RESOURCE: options.mcpResource,
      // Substituted into the realm file at import (ADR 0019).
      AIOPS_PUBLIC_URL: options.publicUrl ?? 'http://localhost:8400',
      AIOPS_WEB_CLIENT_SECRET: options.webClientSecret ?? TEST_WEB_CLIENT_SECRET,
    })
    .withCopyFilesToContainer([{ source: REALM_FILE, target: '/opt/keycloak/data/import/realm-aiops.json' }])
    // CIMD documents served by the test process are fetched from inside the container.
    .withExtraHosts([{ host: 'host.docker.internal', ipAddress: 'host-gateway' }])
    .withExposedPorts(8080)
    .withWaitStrategy(Wait.forHttp('/realms/aiops/.well-known/openid-configuration', 8080).forStatusCode(200))
    .withStartupTimeout(240_000)
    .start();
  const baseUrl = `http://localhost:${String(container.getMappedPort(8080))}`;
  const issuer = `${baseUrl}/realms/aiops`;
  return {
    baseUrl,
    issuer,
    jwksUrl: `${issuer}/protocol/openid-connect/certs`,
    async bootstrap(env = {}) {
      const { stdout } = await run(process.execPath, [BOOTSTRAP], {
        env: {
          PATH: process.env.PATH ?? '',
          KEYCLOAK_URL: baseUrl,
          KEYCLOAK_ADMIN_USER: 'admin',
          KEYCLOAK_ADMIN_PASSWORD: ADMIN_PASSWORD,
          AIOPS_MCP_RESOURCE: options.mcpResource,
          ...env,
        },
      });
      return stdout.trim();
    },
    async stop() {
      await container.stop();
    },
  };
}

/** Cookie jar plus manual redirects; stops at the first redirect that leaves Keycloak. */
class Browser {
  private readonly cookies = new Map<string, string>();

  constructor(private readonly keycloakOrigin: string) {}

  private async request(url: string, form?: Record<string, string>): Promise<Response> {
    const response = await fetch(url, {
      method: form === undefined ? 'GET' : 'POST',
      redirect: 'manual',
      headers: {
        cookie: [...this.cookies].map(([k, v]) => `${k}=${v}`).join('; '),
        ...(form === undefined ? {} : { 'content-type': 'application/x-www-form-urlencoded' }),
      },
      ...(form === undefined ? {} : { body: new URLSearchParams(form) }),
    });
    for (const cookie of response.headers.getSetCookie()) {
      const [pair = ''] = cookie.split(';');
      const i = pair.indexOf('=');
      this.cookies.set(pair.slice(0, i).trim(), pair.slice(i + 1).trim());
    }
    return response;
  }

  async go(url: string, form?: Record<string, string>): Promise<{ redirect: URL } | { page: string; url: string; status: number }> {
    let current = url;
    let response = await this.request(current, form);
    for (let i = 0; i < 10 && response.status >= 300 && response.status < 400; i++) {
      const location = new URL(response.headers.get('location') ?? '', current);
      if (location.origin !== this.keycloakOrigin) return { redirect: location };
      current = location.toString();
      response = await this.request(current);
    }
    return { page: await response.text(), url: current, status: response.status };
  }
}

function formAction(html: string, id?: string): string | undefined {
  const tag = html.match(id === undefined ? /<form[^>]*>/i : new RegExp(`<form[^>]*id="${id}"[^>]*>`, 'i'))?.[0];
  const action = tag?.match(/action="([^"]+)"/i)?.[1];
  return action?.replace(/&amp;/g, '&');
}

function pageError(html: string): string {
  const m = /id="kc-error-message"[\s\S]*?<p[^>]*>([\s\S]*?)<\/p>/i.exec(html) ?? /<title>([\s\S]*?)<\/title>/i.exec(html);
  return m?.[1]?.replace(/<[^>]+>/g, '').trim() ?? 'unknown page';
}

const b64url = (b: Buffer): string => b.toString('base64url');

export interface LoginOptions {
  readonly baseUrl: string;
  readonly clientId: string;
  readonly redirectUri: string;
  readonly username: string;
  readonly password: string;
  /** RFC 8707 resource; omitted when undefined. */
  readonly resource?: string | undefined;
  readonly scope?: string;
  readonly pkce?: 'S256' | 'plain' | 'none';
}

export type LoginResult = { readonly accessToken: string; readonly refreshToken?: string; readonly scope?: string } | { readonly error: string };

/** Authorization code flow against the `aiops` realm, login and consent forms included. */
export async function loginWithPkce(options: LoginOptions): Promise<LoginResult> {
  const realm = `${options.baseUrl}/realms/aiops/protocol/openid-connect`;
  const verifier = b64url(randomBytes(32));
  const pkce = options.pkce ?? 'S256';
  const state = b64url(randomBytes(16));
  const params = new URLSearchParams({
    response_type: 'code',
    client_id: options.clientId,
    redirect_uri: options.redirectUri,
    state,
    scope: options.scope ?? 'openid',
  });
  if (pkce !== 'none') {
    params.set('code_challenge', pkce === 'S256' ? b64url(createHash('sha256').update(verifier).digest()) : verifier);
    params.set('code_challenge_method', pkce);
  }
  if (options.resource !== undefined) params.set('resource', options.resource);

  const browser = new Browser(new URL(options.baseUrl).origin);
  let step = await browser.go(`${realm}/auth?${params.toString()}`);
  if ('page' in step) {
    const action = formAction(step.page, 'kc-form-login');
    if (action === undefined) return { error: `no login form (HTTP ${String(step.status)}): ${pageError(step.page)}` };
    step = await browser.go(new URL(action, step.url).toString(), { username: options.username, password: options.password, credentialId: '' });
  }
  if ('page' in step && step.page.includes('name="accept"')) {
    const action = formAction(step.page) ?? '';
    step = await browser.go(new URL(action, step.url).toString(), { accept: 'Yes' });
  }
  if ('page' in step) return { error: `no redirect to the client (HTTP ${String(step.status)}): ${pageError(step.page)}` };
  const query = step.redirect.searchParams;
  const error = query.get('error');
  if (error !== null) return { error: `${error}: ${query.get('error_description') ?? ''}` };
  if (query.get('state') !== state) return { error: 'state mismatch' };

  const body = new URLSearchParams({
    grant_type: 'authorization_code',
    code: query.get('code') ?? '',
    redirect_uri: options.redirectUri,
    client_id: options.clientId,
    code_verifier: verifier,
  });
  if (options.resource !== undefined) body.set('resource', options.resource);
  const response = await fetch(`${realm}/token`, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body });
  const tokens = (await response.json()) as { access_token?: string; refresh_token?: string; scope?: string; error?: string; error_description?: string };
  if (!response.ok || tokens.access_token === undefined) return { error: `token ${String(response.status)}: ${tokens.error ?? ''} ${tokens.error_description ?? ''}` };
  return {
    accessToken: tokens.access_token,
    ...(tokens.refresh_token === undefined ? {} : { refreshToken: tokens.refresh_token }),
    ...(tokens.scope === undefined ? {} : { scope: tokens.scope }),
  };
}

/** Anonymous Dynamic Client Registration (RFC 7591) of a public client. */
export async function registerClient(baseUrl: string, redirectUris: string[]): Promise<{ status: number; clientId?: string }> {
  const response = await fetch(`${baseUrl}/realms/aiops/clients-registrations/openid-connect`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      client_name: 'aiops test DCR client',
      redirect_uris: redirectUris,
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
      token_endpoint_auth_method: 'none',
      application_type: 'native',
    }),
  });
  const body = (await response.json().catch(() => ({}))) as { client_id?: string };
  return { status: response.status, ...(body.client_id === undefined ? {} : { clientId: body.client_id }) };
}

/** Cookies per host name (ports share cookies, as in browsers); paths and expiry are ignored except deletion. */
export class CookieJar {
  private readonly byHost = new Map<string, Map<string, string>>();

  header(url: URL): string {
    return [...(this.byHost.get(url.hostname) ?? new Map<string, string>())].map(([k, v]) => `${k}=${v}`).join('; ');
  }

  store(url: URL, response: Response): void {
    const cookies = this.byHost.get(url.hostname) ?? new Map<string, string>();
    this.byHost.set(url.hostname, cookies);
    for (const cookie of response.headers.getSetCookie()) {
      const [pair = '', ...attributes] = cookie.split(';');
      const i = pair.indexOf('=');
      const name = pair.slice(0, i).trim();
      const value = pair.slice(i + 1).trim();
      const expired = attributes.some((a) => /^\s*max-age\s*=\s*0\s*$/i.test(a));
      if (expired || value === '') cookies.delete(name);
      else cookies.set(name, value);
    }
  }

  get(url: URL, name: string): string | undefined {
    return this.byHost.get(url.hostname)?.get(name);
  }
}

export interface PageLoginOptions {
  /** `fresh=1`: the IdP must show the login form again (SEC-8). */
  readonly fresh?: boolean;
  /** Keeps the IdP's SSO cookies between logins. */
  readonly cookieJar?: CookieJar;
  readonly returnTo?: string;
}

export interface PageLoginResult {
  /** Ready for a `Cookie` header: `aiops_session=…`. */
  readonly cookie: string;
  readonly csrfToken: string;
  /** Whether the IdP showed a login form (Keycloak); the test issuer never does. */
  readonly formShown: boolean;
  /** Where the api sent the browser after the callback. */
  readonly landedAt: URL;
}

/**
 * Logs in to the api's trusted pages like a browser (AUTH-5): `/auth/login` → IdP
 * (posting Keycloak's login form when it appears) → `/auth/callback` → the return path.
 * The jar carries the api's `aiops_login` cookie from `/auth/login` to `/auth/callback`
 * (login state bound to the browser, SEC-8). Then reads the CSRF token from `GET /api/v1/session`.
 */
export async function pageLogin(apiBaseUrl: string, username: string, password: string, options: PageLoginOptions = {}): Promise<PageLoginResult> {
  const jar = options.cookieJar ?? new CookieJar();
  const api = new URL(apiBaseUrl);
  const request = async (url: URL, form?: Record<string, string>): Promise<Response> => {
    const response = await fetch(url, {
      method: form === undefined ? 'GET' : 'POST',
      redirect: 'manual',
      headers: { cookie: jar.header(url), ...(form === undefined ? {} : { 'content-type': 'application/x-www-form-urlencoded' }) },
      ...(form === undefined ? {} : { body: new URLSearchParams(form) }),
    });
    jar.store(url, response);
    return response;
  };

  const query = new URLSearchParams({ return_to: options.returnTo ?? '/app/' });
  if (options.fresh === true) query.set('fresh', '1');
  let url = new URL(`/auth/login?${query.toString()}`, api);
  let response = await request(url);
  let formShown = false;
  let landedAt: URL | undefined;
  for (let i = 0; i < 20 && landedAt === undefined; i++) {
    if (response.status >= 300 && response.status < 400) {
      const next = new URL(response.headers.get('location') ?? '', url);
      if (next.origin === api.origin && !next.pathname.startsWith('/auth/')) {
        landedAt = next;
        break;
      }
      url = next;
      response = await request(url);
      continue;
    }
    const page = await response.text();
    const action = response.status === 200 && !formShown ? formAction(page, 'kc-form-login') : undefined;
    if (action === undefined) throw new Error(`page login stopped at ${url.pathname} with HTTP ${String(response.status)}: ${pageError(page)}`);
    formShown = true;
    url = new URL(action, url);
    response = await request(url, { username, password, credentialId: '' });
  }
  if (landedAt === undefined) throw new Error('page login: too many redirects');

  const value = jar.get(api, 'aiops_session');
  if (value === undefined) throw new Error('page login: no session cookie was set');
  const cookie = `aiops_session=${value}`;
  const session = await fetch(new URL('/api/v1/session', api), { headers: { cookie } });
  const body = (await session.json()) as { csrfToken?: string };
  if (!session.ok || body.csrfToken === undefined) throw new Error(`page login: GET /api/v1/session answered ${String(session.status)}`);
  return { cookie, csrfToken: body.csrfToken, formShown, landedAt };
}
