import type { ConnectionSettings, CredentialSource, UpstreamMapping } from '@aiops/connector-sdk';
import { startFakeMcpServer, startFakeUpstream, type FakeMcpServer, type FakeUpstream } from '@aiops/testing';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createAdapters } from './composite.js';

const TOKEN = 'composite-s3cr3t-token';
const bearer: CredentialSource = { ref: 'mcp-cred', scheme: 'bearer', open: () => Promise.resolve({ token: TOKEN }) };

let up: FakeUpstream;
let mcp: FakeMcpServer;
let seq = 0;

beforeEach(async () => {
  up = await startFakeUpstream();
  mcp = await startFakeMcpServer({ tools: [{ name: 'lookup', inputSchema: { type: 'object', properties: { key: { type: 'string' } } } }] });
});
afterEach(async () => {
  await Promise.all([up.close(), mcp.close()]);
});

function settings(baseUrl: string, over: Partial<ConnectionSettings> = {}): ConnectionSettings {
  seq += 1;
  return {
    id: `composite-${seq}`,
    baseUrl,
    timeoutMs: 5000,
    retry: { maxAttempts: 1, initialBackoffMs: 1 },
    maxConcurrency: 4,
    allowPrivateNetwork: true,
    extraHosts: [],
    ...over,
  };
}

const openapi = (over: Partial<ConnectionSettings> = {}): ConnectionSettings => settings(up.url, over);
const mcpConnection = (over: Partial<ConnectionSettings> = {}): ConnectionSettings => settings(mcp.url, { kind: 'mcp', ...over });

const getMapping: UpstreamMapping = { method: 'GET', path: '/items', pathParams: {}, query: {}, headers: {}, response: { items: 'items', maxItems: 10 } };
const bulkMapping: UpstreamMapping = {
  method: 'POST',
  path: '/bulk',
  pathParams: {},
  query: {},
  headers: {},
  response: { maxItems: 1 },
  bulk: {
    body: {},
    batchId: 'id',
    status: { method: 'GET', path: '/bulk/{batch_id}', items: 'items', index: 'i', state: 's', states: { ok: ['ok'], failed: [], retriable: [], open: [] } },
  },
};

describe('CONN-1 composite adapter', () => {
  it('CONN-1 an OpenAPI read hits the upstream', async () => {
    up.route('GET', '/items', () => ({ status: 200, body: { items: [{ id: 1 }] } }));
    const r = await createAdapters().read({ connection: openapi(), mapping: getMapping, args: {} });
    expect(r).toMatchObject({ ok: true, status: 200, items: [{ id: 1 }] });
    expect(up.requests).toHaveLength(1);
  });

  it('CONN-1 an absent kind is OpenAPI', async () => {
    up.route('GET', '/items', () => ({ status: 200, body: { items: [] } }));
    const r = await createAdapters().read({ connection: openapi({ kind: 'openapi' }), mapping: getMapping, args: {} });
    expect(r.ok).toBe(true);
  });

  it('CONN-1 read, submitBulk and bulkStatus on an mcp connection are refused without a request', async () => {
    const adapters = createAdapters();
    const connection = mcpConnection();
    expect(await adapters.read({ connection, mapping: getMapping, args: {} })).toMatchObject({ ok: false, code: 'mapping' });
    expect(await adapters.submitBulk({ connection, mapping: bulkMapping, records: [{ a: 1 }] })).toEqual({
      ok: false,
      code: 'mapping',
      durationMs: 0,
      retriable: false,
    });
    expect(await adapters.bulkStatus({ connection, mapping: bulkMapping, batchId: 'b1' })).toEqual({
      ok: false,
      code: 'mapping',
      durationMs: 0,
      retriable: false,
    });
    expect(mcp.requests).toHaveLength(0);
  });

  it('CONN-1 listTools and callTool on an mcp connection hit the MCP server', async () => {
    const adapters = createAdapters();
    const connection = mcpConnection();
    const listed = await adapters.listTools({ connection });
    if (!listed.ok) throw new Error(`list failed: ${listed.code}`);
    expect(listed.tools.map((t) => t.definition.name)).toEqual(['lookup']);
    const called = await adapters.callTool({ connection, tool: 'lookup', args: { key: 'k' }, retryable: true });
    expect(called).toMatchObject({ ok: true, value: { text: ['ok'] } });
    expect(mcp.requests.some((r) => r.rpcMethod === 'tools/call')).toBe(true);
  });

  it('CONN-1 listTools and callTool on a non-mcp connection are refused without a request', async () => {
    const adapters = createAdapters();
    for (const connection of [openapi(), openapi({ kind: 'openapi' })]) {
      expect(await adapters.listTools({ connection })).toMatchObject({ ok: false, code: 'mapping', durationMs: 0 });
      expect(await adapters.callTool({ connection, tool: 'lookup', args: {}, retryable: true })).toMatchObject({ ok: false, code: 'mapping' });
    }
    expect(up.requests).toHaveLength(0);
  });

  it('SEC-7 detectScopes on an mcp connection is not detectable', async () => {
    const scopes = await createAdapters().detectScopes({ connection: mcpConnection({ auth: { scheme: 'bearer' } }), credential: bearer });
    expect(scopes).toEqual({ detectable: false, source: 'none', values: [] });
    expect(mcp.requests).toHaveLength(0);
  });

  it('CONN-1 resolveSpec is the OpenAPI resolver', async () => {
    up.route('GET', '/spec.json', () => ({ status: 200, body: { openapi: '3.0.3', info: { title: 't', version: '1' }, paths: {} } }));
    const r = await createAdapters().resolver.resolveSpec({ connection: openapi(), spec: { url: `${up.url}/spec.json` } });
    expect(r).toEqual({ ok: true, catalog: [] });
  });

  describe('resolveTools (R10)', () => {
    it('CONN-1 lists with the credential credentialFor returns for the connection', async () => {
      const refs: string[] = [];
      const adapters = createAdapters({
        credentialFor: (ref) => {
          refs.push(ref);
          return Promise.resolve(bearer);
        },
      });
      const r = await adapters.resolver.resolveTools({ connection: mcpConnection({ auth: { scheme: 'bearer' }, credentialRef: 'mcp-cred' }) });
      expect(r.ok).toBe(true);
      expect(refs).toEqual(['mcp-cred']);
      const listCall = mcp.requests.find((q) => q.rpcMethod === 'tools/list');
      expect(listCall?.headers.authorization).toBe(`Bearer ${TOKEN}`);
    });

    it('CONN-1 lists without a credential when the connection names none or no credentialFor is given', async () => {
      const refs: string[] = [];
      const withLookup = createAdapters({
        credentialFor: (ref) => {
          refs.push(ref);
          return Promise.resolve(bearer);
        },
      });
      expect((await withLookup.resolver.resolveTools({ connection: mcpConnection() })).ok).toBe(true);
      expect(refs).toEqual([]);
      expect((await createAdapters().resolver.resolveTools({ connection: mcpConnection({ credentialRef: 'mcp-cred' }) })).ok).toBe(true);
      expect(mcp.requests.every((q) => q.headers.authorization === undefined)).toBe(true);
    });

    it('CONN-1 a credential lookup that answers nothing lists without one', async () => {
      const adapters = createAdapters({ credentialFor: () => Promise.resolve(undefined) });
      expect((await adapters.resolver.resolveTools({ connection: mcpConnection({ credentialRef: 'mcp-cred' }) })).ok).toBe(true);
    });

    it('CONN-1 a failing credential lookup is an outcome, not a rejection, and sends nothing', async () => {
      const adapters = createAdapters({ credentialFor: () => Promise.reject(new Error(`vault down ${TOKEN}`)) });
      const r = await adapters.resolver.resolveTools({ connection: mcpConnection({ auth: { scheme: 'bearer' }, credentialRef: 'mcp-cred' }) });
      expect(r).toEqual({ ok: false, code: 'credential_unusable', durationMs: 0, message: 'upstream tool list failed (credential_unusable)' });
      expect(mcp.requests).toHaveLength(0);
    });

    it('CONN-1 resolveTools on a non-mcp connection is refused without a request', async () => {
      const r = await createAdapters().resolver.resolveTools({ connection: openapi() });
      expect(r).toMatchObject({ ok: false, code: 'mapping', durationMs: 0 });
      expect(up.requests).toHaveLength(0);
    });
  });
});
