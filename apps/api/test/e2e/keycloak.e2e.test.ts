import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { decodeJwt } from 'jose';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { loginWithPkce, registerClient, startKeycloak, type LoginResult, type StartedKeycloak, type StartedPostgres } from '@aiops/testing';
import { connectClient, freePort, modernRequest, rawPost, startApi, startDatabase, type RunningApi } from './helpers.js';

const PASSWORD = 'dev-only-password';
const LOOPBACK = 'http://localhost:33418/callback';

let postgres: StartedPostgres;
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
  const { postgres: pgStarted, databaseUrl } = await startDatabase();
  postgres = pgStarted;
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

  keycloak = await startKeycloak({ mcpResource: resource });
  await keycloak.bootstrap({ AIOPS_CIMD_ALLOW_HTTP: 'true', AIOPS_CIMD_CLIENT_DOMAINS: 'host.docker.internal' });
  api = await startApi(databaseUrl, { issuer: keycloak, port, resource });
}, 300_000);

afterAll(async () => {
  // Each resource exists only if beforeAll got that far.
  await (api as RunningApi | undefined)?.close();
  await (keycloak as StartedKeycloak | undefined)?.stop();
  await (postgres as StartedPostgres | undefined)?.stop();
  const server = cimdServer as Server | undefined;
  if (server !== undefined) await new Promise((resolve) => server.close(resolve));
});

describe('AUTH-8 bundled realm registration policy', () => {
  it('AUTH-8 the pre-registered client gets a token for exactly the MCP resource, with groups', async () => {
    const claims = decodeJwt(tokenOf(await login('aiops-mcp', 'alice')));
    expect([claims.aud].flat()).toEqual([resource]);
    expect(claims.groups).toEqual(['content']);
    expect(claims.azp).toBe('aiops-mcp');
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
    const on = await keycloak.bootstrap({ AIOPS_DCR: 'on', AIOPS_DCR_REDIRECT_HOSTS: 'localhost', AIOPS_CIMD_ALLOW_HTTP: 'true', AIOPS_CIMD_CLIENT_DOMAINS: 'host.docker.internal' });
    expect(on).toContain('dcr=on');
    const registered = await registerClient(keycloak.baseUrl, [LOOPBACK]);
    expect(registered.status).toBe(201);
    expect((await registerClient(keycloak.baseUrl, ['https://evil.example.test/cb'])).status).toBe(403);
    const clientId = registered.clientId ?? '';
    expect(decodeJwt(tokenOf(await login(clientId, 'alice'))).azp).toBe(clientId);
    expect(await login(clientId, 'alice', { pkce: 'none' })).toEqual({ error: expect.stringMatching(/^invalid_request/) as unknown });

    // Idempotent, and back to the default.
    const off = await keycloak.bootstrap({ AIOPS_CIMD_ALLOW_HTTP: 'true', AIOPS_CIMD_CLIENT_DOMAINS: 'host.docker.internal' });
    expect(off).toContain('dcr=off');
    await keycloak.bootstrap({ AIOPS_CIMD_ALLOW_HTTP: 'true', AIOPS_CIMD_CLIENT_DOMAINS: 'host.docker.internal' });
    expect((await registerClient(keycloak.baseUrl, [LOOPBACK])).status).toBe(403);
  });
});

describe('AUTH-1 AUTH-3 real Keycloak tokens at the api', () => {
  it('AUTH-3 alice (content) and bob (support) see different tool lists', async () => {
    const alice = await connectClient({ era: 'modern', baseUrls: [api.url], token: tokenOf(await login('aiops-mcp', 'alice')) });
    const bob = await connectClient({ era: 'modern', baseUrls: [api.url], token: tokenOf(await login('aiops-mcp', 'bob')) });
    expect((await alice.listTools()).tools.map((t) => t.name)).toEqual(['ping', 'catalog.search_products']);
    expect((await bob.listTools()).tools.map((t) => t.name)).toEqual(['ping', 'support.lookup_order']);
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
