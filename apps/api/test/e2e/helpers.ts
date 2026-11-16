import type { AddressInfo } from 'node:net';
import { Client, StreamableHTTPClientTransport, type FetchLike } from '@modelcontextprotocol/client';
import type { INestApplication } from '@nestjs/common';
import type { ApiEnv } from '@aiops/config';
import { runMigrations } from '@aiops/db';
import { startPostgres, type StartedPostgres } from '@aiops/testing';
import { createApp, type AppOverrides } from '../../src/app.js';

export const MODERN = '2026-07-28';

export interface RunningApi {
  readonly app: INestApplication;
  readonly url: string;
  close(): Promise<void>;
}

export async function startDatabase(): Promise<{ postgres: StartedPostgres; databaseUrl: string }> {
  const postgres = await startPostgres();
  const databaseUrl = await postgres.createDatabase();
  await runMigrations(databaseUrl);
  return { postgres, databaseUrl };
}

export async function startApi(databaseUrl: string, overrides?: AppOverrides): Promise<RunningApi> {
  const env: ApiEnv = { databaseUrl, port: 0, allowedHosts: ['localhost', '127.0.0.1'], logLevel: 'error' };
  const app = await createApp({ env, ...(overrides === undefined ? {} : { overrides }) });
  await app.listen(0, '127.0.0.1');
  const server = app.getHttpServer() as import('node:http').Server;
  const address = server.address() as AddressInfo;
  return { app, url: `http://127.0.0.1:${address.port}`, close: () => app.close() };
}

export interface ClientOptions {
  /** `modern` pins 2026-07-28; `legacy` is the plain 2025 connect sequence. */
  readonly era: 'modern' | 'legacy';
  /** Base URLs to send requests to, rotated per request (NFR-3 test). */
  readonly baseUrls: readonly string[];
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
