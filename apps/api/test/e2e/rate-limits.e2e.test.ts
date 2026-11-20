/**
 * Limits on the MCP endpoint (SEC-10, SEC-11, AUD-1), over the real HTTP transport.
 *
 * Limits (`fixtures/rate-limit-config`): 3 per minute per user, 4 per service account, 2 per
 * service account `aiops-sa-limited` (its override), 2 per anonymous address.
 *
 * Every api instance runs on a fixed wall clock, 12:00:30Z, so all requests of the file fall in one
 * window and `Retry-After` is exactly 30. Each test has its own subject or address, so budgets do not
 * mix. The main instance trusts one proxy hop, so anonymous tests pick their address with
 * X-Forwarded-For; only the trust-proxy test also uses the instance that trusts none.
 */
import { cp, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { RateCounter } from '@aiops/core';
import { startFakeUpstream, startTestIssuer, type FakeUpstream, type StartedPostgres, type TestIssuer } from '@aiops/testing';
import { auditRows, modernRequest, rawPost, startApi, startDatabase, tokenFor, vaultOf, type RunningApi } from './helpers.js';

const RATE_LIMIT_CONFIG = fileURLToPath(new URL('./fixtures/rate-limit-config', import.meta.url));
const NOW = new Date('2026-11-20T12:00:30.000Z');
const wallClock = (): Date => new Date(NOW);
const SEARCH = { name: 'catalog.search_products', arguments: { brand: 'acme' } };

let postgres: StartedPostgres;
let databaseUrl: string;
let issuer: TestIssuer;
let upstream: FakeUpstream;
let configDir: string;
/** Trusts one proxy hop (AIOPS_TRUST_PROXY=1). */
let api: RunningApi;
/** Trusts no proxy (AIOPS_TRUST_PROXY=0), as in production by default. */
let direct: RunningApi;

beforeAll(async () => {
  ({ postgres, databaseUrl } = await startDatabase());
  issuer = await startTestIssuer();
  upstream = await startFakeUpstream();
  configDir = await mkdtemp(join(tmpdir(), 'aiops-rate-limits-e2e-'));
  await cp(RATE_LIMIT_CONFIG, configDir, { recursive: true });
  const connections = join(configDir, 'connections.yaml');
  await writeFile(connections, (await readFile(connections, 'utf8')).replaceAll('__UPSTREAM_URL__', upstream.url));
  api = await startApi(databaseUrl, { issuer, configDir, trustProxy: 1, wallClock });
  direct = await startApi(databaseUrl, { issuer, configDir, trustProxy: 0, wallClock });
  await vaultOf(api).put({ ref: 'shop-token', scheme: 'bearer', secret: { token: 'e2e-only-upstream-token-rate-limits' }, actor: 'e2e-setup' });
});

afterAll(async () => {
  await direct.close();
  await api.close();
  await upstream.close();
  await issuer.close();
  await postgres.stop();
  await rm(configDir, { recursive: true });
});

beforeEach(() => {
  upstream.route('GET', '/rest/V1/products', () => ({ status: 200, body: { items: [{ sku: 'acme-1' }], total_count: 1 } }));
});

interface JsonRpcAnswer {
  id?: unknown;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
}

async function send(
  target: RunningApi,
  method: string,
  params: Record<string, unknown>,
  options: { token?: string; id?: number; headers?: Record<string, string> } = {},
): Promise<{ status: number; retryAfter: string | null; correlationId: string; json: JsonRpcAnswer }> {
  const { body, headers } = modernRequest(method, params, options.id ?? 1);
  const response = await rawPost(target.url, body, {
    ...headers,
    ...options.headers,
    ...(options.token === undefined ? {} : { authorization: `Bearer ${options.token}` }),
  });
  const raw = await response.text();
  return {
    status: response.status,
    retryAfter: response.headers.get('retry-after'),
    correlationId: response.headers.get('x-correlation-id') ?? '',
    json: raw === '' ? {} : (JSON.parse(raw) as JsonRpcAnswer),
  };
}

async function serviceToken(clientId: string): Promise<string> {
  return issuer.token({ sub: `${clientId}-user-id`, azp: clientId, client_id: clientId, aud: api.resource });
}

async function bucketCount(key: string): Promise<number | undefined> {
  const client = new pg.Client({ connectionString: databaseUrl });
  await client.connect();
  try {
    const { rows } = await client.query<{ count: number }>('select count from rate_bucket where key = $1', [key]);
    return rows[0]?.count;
  } finally {
    await client.end();
  }
}

const RATE_LIMITED = (id: number) => ({
  jsonrpc: '2.0',
  id,
  error: {
    code: -32000,
    message: 'Rate limit exceeded; retry after 30 seconds',
    data: { reason: 'rate_limited', retryAfterSeconds: 30 },
  },
});

describe('SEC-10 MCP endpoint rate limits', () => {
  it('SEC-10 SEC-11 the fourth request of a user in a minute gets 429 with Retry-After and the JSON-RPC error', async () => {
    const token = await tokenFor(issuer, api, 'user-fourth', ['catalog']);
    expect((await send(api, 'tools/list', {}, { token, id: 1 })).status).toBe(200);
    expect((await send(api, 'tools/call', { name: 'ping', arguments: {} }, { token, id: 2 })).status).toBe(200);
    const read = await send(api, 'tools/call', SEARCH, { token, id: 3 });
    expect(read.status).toBe(200);
    expect(read.json.error).toBeUndefined();

    const upstreamBefore = upstream.requests.length;
    const fourth = await send(api, 'tools/call', SEARCH, { token, id: 4 });
    expect(fourth.status).toBe(429);
    expect(fourth.retryAfter).toBe('30');
    expect(fourth.json).toEqual(RATE_LIMITED(4));
    expect(upstream.requests.length).toBe(upstreamBefore);
    expect(await bucketCount('mcp:user:user-fourth')).toBe(4);
  });

  it('SEC-10 SEC-11 built-ins and tools/list count; the SDK does not run when limited', async () => {
    const token = await tokenFor(issuer, api, 'user-sdk', ['catalog']);
    const answers = [];
    for (let id = 1; id <= 4; id += 1) answers.push(await send(api, 'tools/call', SEARCH, { token, id }));
    expect(answers.map((a) => a.status)).toEqual([200, 200, 200, 429]);
    const calls = await auditRows(databaseUrl, "actor = $1 and action in ('tool.call', 'tools.list')", ['user-sdk']);
    expect(calls).toHaveLength(3);
    // The refused request reached no audit row but its rate.limited row.
    const refused = await auditRows(databaseUrl, 'correlation_id = $1', [answers[3]?.correlationId]);
    expect(refused.map((r) => r.action)).toEqual(['rate.limited']);
  });

  it('SEC-10 SEC-11 a service account uses its override', async () => {
    const token = await serviceToken('aiops-sa-limited');
    const statuses = [];
    for (let id = 1; id <= 3; id += 1) statuses.push((await send(api, 'tools/call', SEARCH, { token, id })).status);
    expect(statuses).toEqual([200, 200, 429]);
    expect(await bucketCount('mcp:sa:aiops-sa-limited')).toBe(3);
    const [row] = await auditRows(databaseUrl, "action = 'rate.limited' and actor = $1", ['service:aiops-sa-limited']);
    expect(row).toMatchObject({ client_id: 'aiops-sa-limited', outcome: 'denied', details: { scope: 'mcp', limit: 2 } });
  });

  it('SEC-10 SEC-11 a service account without override uses mcp_service_account_per_minute', async () => {
    const token = await serviceToken('aiops-sa-default');
    const statuses = [];
    for (let id = 1; id <= 5; id += 1) statuses.push((await send(api, 'tools/call', SEARCH, { token, id })).status);
    expect(statuses).toEqual([200, 200, 200, 200, 429]);
    expect(await bucketCount('mcp:sa:aiops-sa-default')).toBe(5);
  });

  it('SEC-10 SEC-11 AUD-1 one rate.limited row per window', async () => {
    const token = await tokenFor(issuer, api, 'user-flood', ['catalog']);
    for (let id = 1; id <= 3; id += 1) expect((await send(api, 'tools/list', {}, { token, id })).status).toBe(200);
    const refused = [];
    for (let id = 4; id < 24; id += 1) refused.push((await send(api, 'tools/list', {}, { token, id })).status);
    expect(refused).toEqual(Array.from({ length: 20 }, () => 429));
    const rows = await auditRows(databaseUrl, "action = 'rate.limited' and actor = $1", ['user-flood']);
    expect(rows).toEqual([expect.objectContaining({ outcome: 'denied', details: { scope: 'mcp', limit: 3 } })]);
    const all = await auditRows(databaseUrl, "action = 'rate.limited'");
    expect(JSON.stringify(all)).not.toContain('127.0.0.1');
  });

  it('SEC-10 SEC-11 X-Forwarded-For is ignored at AIOPS_TRUST_PROXY=0 and used at 1', async () => {
    // A refused token: under the limit it is answered 401 and audited as auth.rejected.
    const badToken = { authorization: 'Bearer not-a-token' };
    const viaProxy = async (address: string) => send(api, 'tools/list', {}, { headers: { ...badToken, 'x-forwarded-for': address } });

    // Trust 1: the forwarded address is the key, so each address has its own budget.
    const first = [await viaProxy('203.0.113.7'), await viaProxy('203.0.113.7'), await viaProxy('203.0.113.7')];
    expect(first.map((a) => a.status)).toEqual([401, 401, 429]);
    expect(first[2]?.retryAfter).toBe('30');
    expect(first[2]?.json).toEqual(RATE_LIMITED(1));
    expect(await auditRows(databaseUrl, 'correlation_id = $1', [first[2]?.correlationId])).toEqual([
      expect.objectContaining({ action: 'rate.limited', actor: 'unknown', outcome: 'denied', details: { scope: 'unauthenticated', limit: 2 } }),
    ]);
    expect((await viaProxy('203.0.113.8')).status).toBe(401);
    expect(await bucketCount('anon:203.0.113.7')).toBe(3);

    // Trust 0: X-Forwarded-For is ignored; every request counts against the socket address.
    const statuses = [];
    for (const address of ['198.51.100.1', '198.51.100.2', '198.51.100.3']) {
      statuses.push((await send(direct, 'tools/list', {}, { headers: { ...badToken, 'x-forwarded-for': address } })).status);
    }
    expect(statuses).toEqual([401, 401, 429]);
    expect(await bucketCount('anon:127.0.0.1')).toBe(3);
    expect(await bucketCount('anon:198.51.100.1')).toBeUndefined();

    const anonymousRows = await auditRows(databaseUrl, "action = 'rate.limited' and actor = 'unknown'");
    expect(anonymousRows).toHaveLength(2);
    for (const address of ['127.0.0.1', '203.0.113', '198.51.100']) expect(JSON.stringify(anonymousRows)).not.toContain(address);
  });
});

describe('SEC-10 MCP endpoint when the rate counter fails', () => {
  let failing: RunningApi;
  const brokenCounter: RateCounter = {
    hit: () => Promise.reject(new Error('counter down')),
  };

  beforeAll(async () => {
    failing = await startApi(databaseUrl, { issuer, configDir, wallClock, rateCounter: brokenCounter });
  });

  afterAll(async () => {
    await failing.close();
  });

  it('SEC-10 SEC-11 a failing counter answers 503 with Retry-After 5 and the SDK does not run', async () => {
    const unavailable = (id: number) => ({
      jsonrpc: '2.0',
      id,
      error: {
        code: -32000,
        message: 'Rate limit check unavailable; retry later',
        data: { reason: 'rate_limit_unavailable', retryAfterSeconds: 5 },
      },
    });
    const token = await tokenFor(issuer, failing, 'user-unavailable', ['catalog']);
    const upstreamBefore = upstream.requests.length;
    const authenticated = await send(failing, 'tools/call', SEARCH, { token, id: 9 });
    expect(authenticated.status).toBe(503);
    expect(authenticated.retryAfter).toBe('5');
    expect(authenticated.json).toEqual(unavailable(9));
    expect(upstream.requests.length).toBe(upstreamBefore);
    expect(await auditRows(databaseUrl, 'correlation_id = $1', [authenticated.correlationId])).toEqual([]);

    const anonymous = await send(failing, 'tools/list', {}, { id: 10, headers: { authorization: 'Bearer not-a-token' } });
    expect(anonymous.status).toBe(503);
    expect(anonymous.retryAfter).toBe('5');
    expect(anonymous.json).toEqual(unavailable(10));
    expect(await auditRows(databaseUrl, 'correlation_id = $1', [anonymous.correlationId])).toEqual([]);
  });
});
