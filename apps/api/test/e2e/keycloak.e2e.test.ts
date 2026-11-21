// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The AI Operations Layer Authors
import { cp, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { decodeJwt } from 'jose';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { CookieJar, loginWithPkce, pageLogin, registerClient, startKeycloak, type LoginResult, type StartedKeycloak, type StartedPostgres } from '@aiops/testing';
import { auditRows, connectClient, FIXTURE_CONFIG, freePort, modernRequest, rawPost, startApi, startDatabase, type RunningApi } from './helpers.js';

/** Built-in tools every authenticated user sees (MCP-8). */
const BUILTIN_NAMES = ['ping', 'list_my_operations', 'get_changeset', 'cancel_changeset', 'submit_for_approval', 'exclude_changeset_items', 'rollback_changeset'];
const PASSWORD = 'dev-only-password';
const LOOPBACK = 'http://localhost:33418/callback';
const SERVICE_CLIENT = 'aiops-sa-ci';
/** Service-account clients the bootstrap creates in every run of this file (AUTH-4). */
const SERVICE_ACCOUNTS = { AIOPS_KEYCLOAK_SERVICE_ACCOUNTS: SERVICE_CLIENT };
/** Role `integration` for the service account, added to a copy of the fixture configuration. */
const SERVICE_ACCOUNTS_YAML = `version: 1
roles:
  - id: integration
    grants:
      - operation: support.lookup_order
service_accounts:
  - { client_id: ${SERVICE_CLIENT}, role: integration }
`;

let postgres: StartedPostgres;
let databaseUrl: string;
let configDir: string;
let keycloak: StartedKeycloak;
let api: RunningApi;
let resource: string;
let cimdServer: Server;
let cimdClientId: string;

function tokenOf(result: LoginResult): string {
  if ('error' in result) throw new Error(result.error);
  return result.accessToken;
}

const login = (clientId: string, username: string, extra: Partial<Parameters<typeof loginWithPkce>[0]> = {}) =>
  loginWithPkce({ baseUrl: keycloak.baseUrl, clientId, redirectUri: LOOPBACK, username, password: PASSWORD, resource, ...extra });

beforeAll(async () => {
  ({ postgres, databaseUrl } = await startDatabase());
  configDir = await mkdtemp(join(tmpdir(), 'aiops-keycloak-e2e-'));
  await cp(FIXTURE_CONFIG, configDir, { recursive: true });
  await writeFile(join(configDir, 'service-accounts.yaml'), SERVICE_ACCOUNTS_YAML);
  const port = await freePort();
  resource = `http://127.0.0.1:${String(port)}/mcp`;

  // A CIMD document served from the test process; Keycloak fetches it over plain
  // HTTP because the test sets AIOPS_CIMD_ALLOW_HTTP (the shipped default is false).
  cimdServer = createServer((_req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(
      JSON.stringify({
        client_id: cimdClientId,
        client_name: 'aiops test CIMD client',
        redirect_uris: [LOOPBACK],
        grant_types: ['authorization_code', 'refresh_token'],
        response_types: ['code'],
        token_endpoint_auth_method: 'none',
      }),
    );
  });
  await new Promise<void>((resolve) => cimdServer.listen(0, '0.0.0.0', resolve));
  cimdClientId = `http://host.docker.internal:${String((cimdServer.address() as AddressInfo).port)}/client.json`;

  keycloak = await startKeycloak({ mcpResource: resource, publicUrl: `http://127.0.0.1:${String(port)}` });
  await keycloak.bootstrap({ AIOPS_CIMD_ALLOW_HTTP: 'true', AIOPS_CIMD_CLIENT_DOMAINS: 'host.docker.internal', ...SERVICE_ACCOUNTS });
  api = await startApi(databaseUrl, { issuer: keycloak, port, resource, configDir });
}, 300_000);

afterAll(async () => {
  // Each resource exists only if beforeAll got that far.
  await (api as RunningApi | undefined)?.close();
  await (keycloak as StartedKeycloak | undefined)?.stop();
  await (postgres as StartedPostgres | undefined)?.stop();
  if ((configDir as string | undefined) !== undefined) await rm(configDir, { recursive: true });
  const server = cimdServer as Server | undefined;
  if (server !== undefined) await new Promise((resolve) => server.close(resolve));
});

describe('AUTH-8 bundled realm registration policy', () => {
  it('AUTH-8 the pre-registered client gets a token for exactly the MCP resource, with groups', async () => {
    const claims = decodeJwt(tokenOf(await login('aiops-mcp', 'alice')));
    expect([claims.aud].flat()).toEqual([resource]);
    expect([...(claims.groups as string[])].sort()).toEqual(['content', 'content-leads']);
    expect(claims.azp).toBe('aiops-mcp');
  });

  it('APR-1 the development realm has dave in content-leads', async () => {
    const claims = decodeJwt(tokenOf(await login('aiops-mcp', 'dave')));
    expect(claims.groups).toEqual(['content-leads']);
  });

  it('AUTH-8 a Client ID Metadata Document client from a trusted domain gets a token', async () => {
    const claims = decodeJwt(tokenOf(await login(cimdClientId, 'bob')));
    expect([claims.aud].flat()).toEqual([resource]);
    expect(claims.azp).toBe(cimdClientId);
  });

  it('AUTH-8 anonymous Dynamic Client Registration is off by default', async () => {
    expect((await registerClient(keycloak.baseUrl, [LOOPBACK])).status).toBe(403);
  });

  it('AUTH-8 PKCE S256 is required for pre-registered and CIMD clients', async () => {
    for (const clientId of ['aiops-mcp', cimdClientId]) {
      for (const pkce of ['none', 'plain'] as const) {
        const result = await login(clientId, 'alice', { pkce });
        expect(result, `${clientId} ${pkce}`).toEqual({ error: expect.stringMatching(/^invalid_request/) as unknown });
      }
    }
  });

  it('AUTH-8 a refresh token is issued when the client asks for offline_access', async () => {
    const result = await login('aiops-mcp', 'alice', { scope: 'openid offline_access' });
    if ('error' in result) throw new Error(result.error);
    expect(result.refreshToken).toBeDefined();
    expect(result.scope).toContain('offline_access');
  });

  it('AUTH-8 the DCR switch admits listed redirect hosts only, enforces PKCE, and switches back off', async () => {
    const on = await keycloak.bootstrap({ AIOPS_DCR: 'on', AIOPS_DCR_REDIRECT_HOSTS: 'localhost', AIOPS_CIMD_ALLOW_HTTP: 'true', AIOPS_CIMD_CLIENT_DOMAINS: 'host.docker.internal', ...SERVICE_ACCOUNTS });
    expect(on).toContain('dcr=on');
    const registered = await registerClient(keycloak.baseUrl, [LOOPBACK]);
    expect(registered.status).toBe(201);
    expect((await registerClient(keycloak.baseUrl, ['https://evil.example.test/cb'])).status).toBe(403);
    const clientId = registered.clientId ?? '';
    expect(decodeJwt(tokenOf(await login(clientId, 'alice'))).azp).toBe(clientId);
    expect(await login(clientId, 'alice', { pkce: 'none' })).toEqual({ error: expect.stringMatching(/^invalid_request/) as unknown });

    // Idempotent, and back to the default.
    const off = await keycloak.bootstrap({ AIOPS_CIMD_ALLOW_HTTP: 'true', AIOPS_CIMD_CLIENT_DOMAINS: 'host.docker.internal', ...SERVICE_ACCOUNTS });
    expect(off).toContain('dcr=off');
    await keycloak.bootstrap({ AIOPS_CIMD_ALLOW_HTTP: 'true', AIOPS_CIMD_CLIENT_DOMAINS: 'host.docker.internal', ...SERVICE_ACCOUNTS });
    expect((await registerClient(keycloak.baseUrl, [LOOPBACK])).status).toBe(403);
  });
});

describe('AUTH-4 service accounts with real Keycloak tokens', () => {
  const serviceToken = async (options: { resource?: string } = {}): Promise<string> => {
    const result = await keycloak.clientCredentialsToken(SERVICE_CLIENT, options);
    if ('error' in result) throw new Error(result.error);
    return result.accessToken;
  };

  it('AUTH-4 bootstrap creates aiops-sa-ci idempotently and keeps its secret', async () => {
    // The secret is compared, never printed (SEC-3).
    const before = await keycloak.clientSecret(SERVICE_CLIENT);
    const summary = await keycloak.bootstrap({ AIOPS_CIMD_ALLOW_HTTP: 'true', AIOPS_CIMD_CLIENT_DOMAINS: 'host.docker.internal', ...SERVICE_ACCOUNTS });
    expect(summary).toContain('service_accounts=1');
    expect(summary).not.toContain(before);
    expect((await keycloak.clientSecret(SERVICE_CLIENT)) === before).toBe(true);
    const clients = await keycloak.clients(SERVICE_CLIENT);
    expect(clients).toHaveLength(1);
    expect(clients[0]).toMatchObject({ clientId: SERVICE_CLIENT, standardFlowEnabled: false, serviceAccountsEnabled: true, publicClient: false });
  });

  it('AUTH-4 a client-credentials token with resource has exactly the MCP audience and no sid', async () => {
    const claims = decodeJwt(await serviceToken({ resource }));
    expect([claims.aud].flat()).toEqual([resource]);
    expect(claims.azp).toBe(SERVICE_CLIENT);
    expect(claims.client_id).toBe(SERVICE_CLIENT);
    expect(claims.sid).toBeUndefined();
    expect(claims.auth_time).toBeUndefined();
  });

  it('AUTH-4 AUTH-1 the service account sees its role tools at the api', async () => {
    const token = await serviceToken({ resource });
    const client = await connectClient({ era: 'modern', baseUrls: [api.url], token });
    const names = (await client.listTools()).tools.map((t) => t.name);
    await client.close();
    expect(names).toContain('support.lookup_order');
    for (const absent of ['catalog.search_products', 'review_changeset', 'decide_changeset']) expect(names).not.toContain(absent);

    const { body, headers } = modernRequest('tools/call', { name: 'catalog.search_products', arguments: { brand: 'acme' } });
    const response = await rawPost(api.url, body, { ...headers, authorization: `Bearer ${token}` });
    const json = (await response.json()) as { error?: { message: string } };
    expect(json.error?.message).toContain('Tool catalog.search_products not found');
    const rows = await auditRows(databaseUrl, 'correlation_id = $1', [response.headers.get('x-correlation-id')]);
    expect(rows).toEqual([
      expect.objectContaining({ action: 'policy.decision', decision: 'deny', actor: `service:${SERVICE_CLIENT}`, client_id: SERVICE_CLIENT, subject: 'catalog.search_products' }),
    ]);
  });
});

describe('AUTH-1 AUTH-3 real Keycloak tokens at the api', () => {
  it('AUTH-3 alice (content) and bob (support) see different tool lists', async () => {
    const alice = await connectClient({ era: 'modern', baseUrls: [api.url], token: tokenOf(await login('aiops-mcp', 'alice')) });
    const bob = await connectClient({ era: 'modern', baseUrls: [api.url], token: tokenOf(await login('aiops-mcp', 'bob')) });
    expect((await alice.listTools()).tools.map((t) => t.name)).toEqual([...BUILTIN_NAMES, 'catalog.search_products']);
    expect((await bob.listTools()).tools.map((t) => t.name)).toEqual([...BUILTIN_NAMES, 'support.lookup_order']);
    await alice.close();
    await bob.close();
  });

  it('AUTH-1 a token requested without resource still carries the MCP audience from the mapper', async () => {
    const token = tokenOf(await login('aiops-mcp', 'alice', { resource: undefined }));
    expect([decodeJwt(token).aud].flat()).toContain(resource);
    const { body, headers } = modernRequest('tools/list');
    expect((await rawPost(api.url, body, { ...headers, authorization: `Bearer ${token}` })).status).toBe(200);
  });

  it('AUTH-1 a token whose payload was changed is refused', async () => {
    const [header, payload, signature] = tokenOf(await login('aiops-mcp', 'bob')).split('.');
    const claims = JSON.parse(Buffer.from(payload ?? '', 'base64url').toString()) as Record<string, unknown>;
    const forged = `${header ?? ''}.${Buffer.from(JSON.stringify({ ...claims, groups: ['content'] })).toString('base64url')}.${signature ?? ''}`;
    const { body, headers } = modernRequest('tools/list');
    expect((await rawPost(api.url, body, { ...headers, authorization: `Bearer ${forged}` })).status).toBe(401);
  });
});

describe('AUTH-5 login through aiops-web in the shipped realm', () => {
  interface PageSession {
    subject: string;
    username?: string;
    roles: string[];
    authTime: string;
  }
  const sessionOf = async (cookie: string): Promise<PageSession> => (await (await fetch(`${api.url}/api/v1/session`, { headers: { cookie } })).json()) as PageSession;

  it('AUTH-5 carol logs in to the pages and gets integration_admin from group admins; fresh login shows the form again', async () => {
    const jar = new CookieJar();
    const first = await pageLogin(api.url, 'carol', PASSWORD, { cookieJar: jar });
    expect(first.formShown).toBe(true);
    expect(first.landedAt.pathname).toBe('/app/');
    const session = await sessionOf(first.cookie);
    expect(session.username).toBe('carol');
    expect(session.roles).toContain('integration_admin');

    // SSO: no form, same auth_time.
    const silent = await pageLogin(api.url, 'carol', PASSWORD, { cookieJar: jar });
    expect(silent.formShown).toBe(false);
    expect((await sessionOf(silent.cookie)).authTime).toBe(session.authTime);

    // auth_time has second granularity.
    await new Promise((resolve) => setTimeout(resolve, 1_100));
    const fresh = await pageLogin(api.url, 'carol', PASSWORD, { cookieJar: jar, fresh: true });
    expect(fresh.formShown).toBe(true);
    expect(Date.parse((await sessionOf(fresh.cookie)).authTime)).toBeGreaterThan(Date.parse(session.authTime));
  });

  it('AUTH-5 a wrong password never yields a session', async () => {
    await expect(pageLogin(api.url, 'carol', 'wrong-password')).rejects.toThrow(/page login stopped/);
  });
});
