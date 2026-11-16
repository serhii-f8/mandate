import pg from 'pg';
import { z } from 'zod';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Caller } from '@aiops/core';
import type { StartedPostgres } from '@aiops/testing';
import type { CallerResolver } from '../../src/mcp/caller-resolver.js';
import { pingTool } from '../../src/mcp/ping.tool.js';
import type { ToolCatalog, ToolDefinition } from '../../src/mcp/tool-catalog.js';
import { connectClient, MODERN, startApi, startDatabase, type RunningApi } from './helpers.js';

let postgres: StartedPostgres;
let databaseUrl: string;
let api: RunningApi;

beforeAll(async () => {
  ({ postgres, databaseUrl } = await startDatabase());
  api = await startApi(databaseUrl);
});

afterAll(async () => {
  await api.close();
  await postgres.stop();
});

interface AuditRow {
  actor: string;
  client_id: string | null;
  details: Record<string, unknown>;
  action: string;
  subject: string;
  outcome: string;
  correlation_id: string;
}

async function auditRows(where = 'true', params: unknown[] = []): Promise<AuditRow[]> {
  const client = new pg.Client({ connectionString: databaseUrl });
  await client.connect();
  try {
    return (await client.query<AuditRow>(`select * from audit_event where ${where} order by seq`, params)).rows;
  } finally {
    await client.end();
  }
}

function text(result: unknown): string {
  const content = (result as { content?: { type: string; text?: string }[] }).content ?? [];
  return content.map((c) => c.text ?? '').join('');
}

function rawPost(body: unknown, headers: Record<string, string> = {}): Promise<Response> {
  return fetch(`${api.url}/mcp`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', ...headers },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });
}

describe('MCP-1 stateless Streamable HTTP endpoint at protocol 2026-07-28', () => {
  it('MCP-1 lists and calls the ping tool without initialize or session', async () => {
    const client = await connectClient({ era: 'modern', baseUrls: [api.url] });
    const tools = await client.listTools();
    expect(tools.tools.map((t) => t.name)).toEqual(['ping']);
    expect(text(await client.callTool({ name: 'ping', arguments: { message: 'hi' } }))).toBe('pong: hi');
    await client.close();
  });

  it('MCP-1 answers a raw 2026-07-28 request with no Mcp-Session-Id', async () => {
    const modernHeaders = { 'mcp-protocol-version': MODERN, 'mcp-method': 'tools/list' };
    const response = await rawPost({
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/list',
      params: {
        _meta: {
          'io.modelcontextprotocol/protocolVersion': MODERN,
          'io.modelcontextprotocol/clientInfo': { name: 'raw', version: '1' },
          'io.modelcontextprotocol/clientCapabilities': {},
        },
      },
    }, modernHeaders);
    expect(response.status).toBe(200);
    expect(response.headers.get('mcp-session-id')).toBeNull();
    const body = (await response.json()) as { result?: { tools?: { name: string }[] } };
    expect(body.result?.tools?.map((t) => t.name)).toEqual(['ping']);
  });

  it('MCP-1 the tool call appears in audit with its correlation ID', async () => {
    const correlationIds: string[] = [];
    const client = await connectClient({
      era: 'modern',
      baseUrls: [api.url],
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
    const rows = await auditRows('correlation_id = $1', [callId]);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      actor: 'anonymous',
      // client_id is reserved for a verified client (Phase 2); the declared name is detail.
      client_id: null,
      details: { declaredClientName: 'aiops-e2e' },
      action: 'tool.call',
      subject: 'ping',
      outcome: 'ok',
    });
  });

  it('MCP-1 serves a 2025-era client through the stateless legacy fallback', async () => {
    const client = await connectClient({ era: 'legacy', baseUrls: [api.url] });
    expect(text(await client.callTool({ name: 'ping', arguments: { message: 'old' } }))).toBe('pong: old');
    await client.close();
  });
});

describe('MCP-1 per-caller tool lists on both protocol eras', () => {
  const aliceOnly: ToolDefinition = {
    name: 'alice_only',
    description: 'Visible to alice only.',
    inputSchema: z.object({}),
    handler: () => Promise.resolve({ content: [{ type: 'text', text: 'secret' }] }),
  };
  const resolver: CallerResolver = {
    resolve: (req) => {
      const user = req.headers['x-test-user'];
      return Promise.resolve<Caller>({ subject: typeof user === 'string' ? user : 'nobody', groups: [] });
    },
  };
  const catalog: ToolCatalog = {
    toolsFor: (caller) => (caller.subject === 'alice' ? [pingTool, aliceOnly] : [pingTool]),
  };
  let perUserApi: RunningApi;

  beforeAll(async () => {
    perUserApi = await startApi(databaseUrl, { callerResolver: resolver, toolCatalog: catalog });
  });

  afterAll(async () => {
    await perUserApi.close();
  });

  for (const era of ['modern', 'legacy'] as const) {
    it(`MCP-1 ${era}: alice and bob see different tools, and bob cannot call alice's`, async () => {
      const alice = await connectClient({ era, baseUrls: [perUserApi.url], headers: { 'x-test-user': 'alice' } });
      const bob = await connectClient({ era, baseUrls: [perUserApi.url], headers: { 'x-test-user': 'bob' } });
      expect((await alice.listTools()).tools.map((t) => t.name).sort()).toEqual(['alice_only', 'ping']);
      expect((await bob.listTools()).tools.map((t) => t.name)).toEqual(['ping']);
      expect(text(await alice.callTool({ name: 'alice_only', arguments: {} }))).toBe('secret');
      const denied = bob.callTool({ name: 'alice_only', arguments: {} }).then(
        (r) => ({ rejected: false as const, result: r }),
        (e: unknown) => ({ rejected: true as const, error: String(e) }),
      );
      const outcome = await denied;
      if (outcome.rejected) expect(outcome.error).toMatch(/alice_only/);
      else expect(outcome.result).toMatchObject({ isError: true });
      if (!outcome.rejected) expect(text(outcome.result)).toMatch(/alice_only/);
      await alice.close();
      await bob.close();
    });
  }
});

describe('NFR-3 api is stateless across instances', () => {
  it('NFR-3 a client alternating between two api instances works and every call is audited', async () => {
    const second = await startApi(databaseUrl);
    const before = (await auditRows("subject = 'ping' and actor = 'anonymous'")).length;
    try {
      const client = await connectClient({ era: 'modern', baseUrls: [api.url, second.url] });
      for (let i = 0; i < 4; i++) {
        expect(text(await client.callTool({ name: 'ping', arguments: { message: `n${i}` } }))).toBe(`pong: n${i}`);
      }
      await client.close();
    } finally {
      await second.close();
    }
    expect((await auditRows("subject = 'ping' and actor = 'anonymous'")).length - before).toBe(4);
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
    expect((await rawPost({ jsonrpc: '2.0', id: 1, method: 'tools/list' }, { origin: 'https://evil.example' })).status).toBe(403);
  });

  it('rejects malformed JSON with 400', async () => {
    expect((await rawPost('{not json')).status).toBe(400);
  });

  it('rejects a body over 4 MiB with 413', async () => {
    expect((await rawPost(JSON.stringify({ pad: 'x'.repeat(4 * 1024 * 1024 + 1) }))).status).toBe(413);
  });

  it('serves liveness and readiness', async () => {
    expect((await fetch(`${api.url}/healthz`)).status).toBe(200);
    expect((await fetch(`${api.url}/readyz`)).status).toBe(200);
  });
});
