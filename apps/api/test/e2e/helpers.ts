import { createServer } from 'node:net';
import type { AddressInfo } from 'node:net';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { Client, StreamableHTTPClientTransport, type FetchLike } from '@modelcontextprotocol/client';
import type { INestApplication } from '@nestjs/common';
import type { Logger } from 'pino';
import { createOpenApiAdapter, type OpenApiAdapter } from '@aiops/adapters';
import { ConfigurationHolder, type ApiEnv } from '@aiops/config';
import type { CredentialVault, OperationInvoker } from '@aiops/core';
import { runMigrations } from '@aiops/db';
import { startPostgres, TEST_WEB_CLIENT_SECRET, type StartedPostgres, type TestIssuer } from '@aiops/testing';
import { createApp } from '../../src/app.js';
import { CONFIGURATION, CREDENTIAL_VAULT } from '../../src/tokens.js';
import { configurationLoadOptions } from '../../src/upstream/upstream-runtime.js';

export const MODERN = '2026-07-28';
export const FIXTURE_CONFIG = fileURLToPath(new URL('./fixtures/config', import.meta.url));

export interface RunningApi {
  readonly app: INestApplication;
  readonly url: string;
  /** The canonical MCP URL, also the token audience. */
  readonly resource: string;
  close(): Promise<void>;
}

export async function startDatabase(): Promise<{ postgres: StartedPostgres; databaseUrl: string }> {
  const postgres = await startPostgres();
  const databaseUrl = await postgres.createDatabase();
  await runMigrations(databaseUrl);
  return { postgres, databaseUrl };
}

export function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address() as AddressInfo;
      server.close(() => {
        resolve(port);
      });
    });
  });
}

export interface StartApiOptions {
  readonly issuer: { readonly issuer: string; readonly jwksUrl: string };
  readonly configDir?: string;
  readonly invoker?: OperationInvoker;
  /** Canonical MCP URL to serve as, e.g. a second instance behind the same load balancer URL. */
  readonly resource?: string;
  /** Port to listen on; a free one by default. */
  readonly port?: number;
  /** The api logger, e.g. one writing to a captured stream. */
  readonly logger?: Logger;
  /** The read adapter; a fresh OpenAPI adapter by default, as `main.ts` uses. */
  readonly adapter?: OpenApiAdapter;
}

export async function startApi(databaseUrl: string, options: StartApiOptions): Promise<RunningApi> {
  const port = options.port ?? (await freePort());
  const resource = options.resource ?? `http://127.0.0.1:${String(port)}/mcp`;
  const env: ApiEnv = {
    databaseUrl,
    port,
    allowedHosts: ['localhost', '127.0.0.1'],
    logLevel: 'error',
    configDir: options.configDir ?? FIXTURE_CONFIG,
    mcpResource: new URL(resource),
    oidcIssuer: options.issuer.issuer,
    oidcJwksUrl: new URL(options.issuer.jwksUrl),
    publicUrl: new URL(`http://127.0.0.1:${String(port)}`),
    webClientId: 'aiops-web',
    webClientSecret: TEST_WEB_CLIENT_SECRET,
    oidcAuthorizationUrl: new URL(`${options.issuer.issuer}/protocol/openid-connect/auth`),
    oidcTokenUrl: new URL(`${options.issuer.issuer}/protocol/openid-connect/token`),
    masterKeys: '1:ZGV2LW9ubHktbWFzdGVyLWtleS0wMTIzNDU2Nzg5YWI=',
    sessionMaxAgeSeconds: 28_800,
    freshAuthSeconds: 300,
    presetDirs: [],
  };
  const adapter = options.adapter ?? createOpenApiAdapter();
  // Loaded as `main.ts` loads it: with the adapter's spec resolver and the preset directories.
  const configuration = await ConfigurationHolder.load(env.configDir, configurationLoadOptions(adapter, env));
  const app = await createApp({
    env,
    configuration,
    overrides: { adapter, ...(options.invoker === undefined ? {} : { invoker: options.invoker }) },
    ...(options.logger === undefined ? {} : { logger: options.logger }),
  });
  await app.listen(port, '127.0.0.1');
  return { app, url: `http://127.0.0.1:${String(port)}`, resource, close: () => app.close() };
}

/** The running api's credential vault (the real `PostgresCredentialVault`). */
export function vaultOf(api: RunningApi): CredentialVault {
  return api.app.get<CredentialVault>(CREDENTIAL_VAULT);
}

/** Reloads the configuration of a running api, as SIGHUP does. */
export function reloadConfiguration(api: RunningApi): ReturnType<ConfigurationHolder['reload']> {
  return api.app.get<ConfigurationHolder>(CONFIGURATION).reload();
}

/** A token for the api's resource, as Keycloak would issue it for the pre-registered client. */
export function tokenFor(issuer: TestIssuer, api: RunningApi, sub: string, groups: string[]): Promise<string> {
  return issuer.token({ sub, groups, aud: api.resource, azp: 'aiops-mcp' });
}

export interface ClientOptions {
  /** `modern` pins 2026-07-28; `legacy` is the plain 2025 connect sequence. */
  readonly era: 'modern' | 'legacy';
  /** Base URLs to send requests to, rotated per request (NFR-3 test). */
  readonly baseUrls: readonly string[];
  readonly token?: string;
  readonly headers?: Record<string, string>;
  /** Receives every HTTP response, e.g. to read `x-correlation-id`. */
  readonly onResponse?: (response: Response) => void;
}

/** An MCP client whose requests rotate across `baseUrls`. */
export async function connectClient(options: ClientOptions): Promise<Client> {
  let next = 0;
  const rotating: FetchLike = async (input, init) => {
    const base = options.baseUrls[next++ % options.baseUrls.length] ?? '';
    const target = new URL(input instanceof URL ? input.pathname : new URL(input).pathname, base);
    const headers = new Headers(init?.headers);
    for (const [k, v] of Object.entries(options.headers ?? {})) headers.set(k, v);
    if (options.token !== undefined) headers.set('authorization', `Bearer ${options.token}`);
    const response = await fetch(target, { ...init, headers });
    options.onResponse?.(response);
    return response;
  };
  const client = new Client(
    { name: 'aiops-e2e', version: '1.0.0' },
    options.era === 'modern' ? { versionNegotiation: { mode: { pin: MODERN } } } : {},
  );
  const first = options.baseUrls[0] ?? '';
  await client.connect(new StreamableHTTPClientTransport(new URL('/mcp', first), { fetch: rotating }));
  return client;
}

export interface AuditRow {
  seq: string;
  actor: string;
  client_id: string | null;
  details: Record<string, unknown>;
  action: string;
  subject: string | null;
  decision: string | null;
  outcome: string;
  correlation_id: string;
}

export async function auditRows(databaseUrl: string, where = 'true', params: unknown[] = []): Promise<AuditRow[]> {
  const client = new pg.Client({ connectionString: databaseUrl });
  await client.connect();
  try {
    return (await client.query<AuditRow>(`select * from audit_event where ${where} order by seq`, params)).rows;
  } finally {
    await client.end();
  }
}

export function text(result: unknown): string {
  const content = (result as { content?: { type: string; text?: string }[] }).content ?? [];
  return content.map((c) => c.text ?? '').join('');
}

export function rawPost(baseUrl: string, body: unknown, headers: Record<string, string> = {}): Promise<Response> {
  return fetch(`${baseUrl}/mcp`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', ...headers },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });
}

/** A 2026-07-28 request body for `method`, as a raw client sends it. */
export function modernRequest(method: string, params: Record<string, unknown> = {}, id = 1): { body: unknown; headers: Record<string, string> } {
  return {
    headers: { 'mcp-protocol-version': MODERN, 'mcp-method': method, ...(method === 'tools/call' ? { 'mcp-name': String(params.name) } : {}) },
    body: {
      jsonrpc: '2.0',
      id,
      method,
      params: {
        ...params,
        _meta: {
          'io.modelcontextprotocol/protocolVersion': MODERN,
          'io.modelcontextprotocol/clientInfo': { name: 'raw', version: '1' },
          'io.modelcontextprotocol/clientCapabilities': {},
        },
      },
    },
  };
}
