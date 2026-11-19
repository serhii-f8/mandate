import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startTestIssuer, type StartedPostgres, type TestIssuer } from '@aiops/testing';
import type { ConfigurationHolder } from '@aiops/config';
import {
  auditRows,
  connectClient,
  modernRequest,
  rawPost,
  startApi,
  startDatabase,
  text,
  tokenFor,
  type RunningApi,
} from './helpers.js';
import { CONFIGURATION } from '../../src/tokens.js';

let postgres: StartedPostgres;
let databaseUrl: string;
let issuer: TestIssuer;
let api: RunningApi;
let aliceToken: string;

beforeAll(async () => {
  ({ postgres, databaseUrl } = await startDatabase());
  issuer = await startTestIssuer();
  api = await startApi(databaseUrl, { issuer });
  aliceToken = await tokenFor(issuer, api, 'alice-id', ['content']);
});

afterAll(async () => {
  await api.close();
  await issuer.close();
  await postgres.stop();
});

describe('MCP-1 stateless Streamable HTTP endpoint at protocol 2026-07-28', () => {
  it('MCP-1 lists and calls the ping tool without initialize or session', async () => {
    const client = await connectClient({ era: 'modern', baseUrls: [api.url], token: aliceToken });
    const tools = await client.listTools();
    expect(tools.tools.map((t) => t.name)).toContain('ping');
    expect(text(await client.callTool({ name: 'ping', arguments: { message: 'hi' } }))).toBe('pong: hi');
    await client.close();
  });

  it('MCP-1 answers a raw 2026-07-28 request with no Mcp-Session-Id', async () => {
    const { body, headers } = modernRequest('tools/list');
    const response = await rawPost(api.url, body, { ...headers, authorization: `Bearer ${aliceToken}` });
    expect(response.status).toBe(200);
    expect(response.headers.get('mcp-session-id')).toBeNull();
    const json = (await response.json()) as { result?: { tools?: { name: string }[] } };
    expect(json.result?.tools?.map((t) => t.name)).toContain('ping');
  });

  it('MCP-1 the tool call appears in audit with its correlation ID, actor and verified client', async () => {
    const correlationIds: string[] = [];
    const client = await connectClient({
      era: 'modern',
      baseUrls: [api.url],
      token: aliceToken,
      onResponse: (r) => {
        const id = r.headers.get('x-correlation-id');
        if (id !== null) correlationIds.push(id);
      },
    });
    correlationIds.length = 0;
    await client.callTool({ name: 'ping', arguments: {} });
    await client.close();
    const callId = correlationIds.at(-1);
    expect(callId).toMatch(/^[0-9a-f-]{36}$/);
    const rows = await auditRows(databaseUrl, "correlation_id = $1 and action = 'tool.call'", [callId]);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      actor: 'alice-id',
      client_id: 'aiops-mcp',
      details: { declaredClientName: 'aiops-e2e' },
      subject: 'ping',
      outcome: 'ok',
    });
  });

  it('MCP-1 serves a 2025-era client through the stateless legacy fallback', async () => {
    const client = await connectClient({ era: 'legacy', baseUrls: [api.url], token: aliceToken });
    expect(text(await client.callTool({ name: 'ping', arguments: { message: 'old' } }))).toBe('pong: old');
    await client.close();
  });
});

describe('NFR-3 api is stateless across instances', () => {
  it('NFR-3 a client alternating between two api instances works and every call is audited', async () => {
    // Behind one load balancer both instances serve the same canonical URL.
    const second = await startApi(databaseUrl, { issuer, resource: api.resource });
    const sharedToken = await tokenFor(issuer, api, 'nfr3-user', ['content']);
    const before = (await auditRows(databaseUrl, "subject = 'ping' and actor = 'nfr3-user' and action = 'tool.call'")).length;
    try {
      const client = await connectClient({ era: 'modern', baseUrls: [api.url, second.url], token: sharedToken });
      for (let i = 0; i < 4; i++) {
        expect(text(await client.callTool({ name: 'ping', arguments: { message: `n${String(i)}` } }))).toBe(`pong: n${String(i)}`);
      }
      await client.close();
    } finally {
      await second.close();
    }
    expect((await auditRows(databaseUrl, "subject = 'ping' and actor = 'nfr3-user' and action = 'tool.call'")).length - before).toBe(4);
  });
});

describe('MCP endpoint HTTP edges', () => {
  it.each(['GET', 'DELETE'])('%s /mcp answers 405 with Allow: POST', async (method) => {
    const response = await fetch(`${api.url}/mcp`, { method });
    expect(response.status).toBe(405);
    expect(response.headers.get('allow')).toBe('POST');
  });

  it('rejects a foreign Host with 403 (DNS rebinding)', async () => {
    // fetch() does not allow overriding Host, so use node:http.
    const { request } = await import('node:http');
    const status = await new Promise<number>((resolve, reject) => {
      const req = request(`${api.url}/mcp`, { method: 'POST', headers: { host: 'evil.example', 'content-type': 'application/json' } }, (res) => {
        res.resume();
        resolve(res.statusCode ?? 0);
      });
      req.on('error', reject);
      req.end('{}');
    });
    expect(status).toBe(403);
  });

  it('rejects a foreign Origin with 403', async () => {
    expect((await rawPost(api.url, { jsonrpc: '2.0', id: 1, method: 'tools/list' }, { origin: 'https://evil.example' })).status).toBe(403);
  });

  it('rejects malformed JSON with 400', async () => {
    expect((await rawPost(api.url, '{not json', { authorization: `Bearer ${aliceToken}` })).status).toBe(400);
  });

  it('rejects a body over 4 MiB with 413', async () => {
    expect((await rawPost(api.url, JSON.stringify({ pad: 'x'.repeat(4 * 1024 * 1024 + 1) }))).status).toBe(413);
  });

  it('NFR-10 /readyz reports database, configuration revision and hash, and temporal unavailable with the executor replaced', async () => {
    const health = await fetch(`${api.url}/healthz`);
    expect(health.status).toBe(200);
    expect(await health.json()).toEqual({ ok: true });
    const ready = await fetch(`${api.url}/readyz`);
    expect(ready.status).toBe(200);
    expect(ready.headers.get('cache-control')).toBe('no-store');
    const state = api.app.get<ConfigurationHolder>(CONFIGURATION).state();
    expect(state.status).toBe('active');
    const hash = state.status === 'active' ? state.hash : '';
    expect(await ready.json()).toEqual({ database: 'ok', configuration: { revision: null, hash }, temporal: 'unavailable' });
  });
});
