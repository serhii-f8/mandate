import { cp, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { FakeInvoker, startTestIssuer, type StartedPostgres, type TestIssuer } from '@aiops/testing';
import {
  auditRows,
  connectClient,
  FIXTURE_CONFIG,
  modernRequest,
  rawPost,
  reloadConfiguration,
  startApi,
  startDatabase,
  text,
  tokenFor,
  type RunningApi,
} from './helpers.js';

let postgres: StartedPostgres;
let databaseUrl: string;
let issuer: TestIssuer;
let api: RunningApi;
let configDir: string;
/** Built-in tools every authenticated user sees (MCP-8). */
const BUILTIN_NAMES = ['ping', 'list_my_operations', 'get_changeset', 'cancel_changeset', 'submit_for_approval', 'exclude_changeset_items', 'rollback_changeset'];
const invoker = new FakeInvoker();
let alice: string;
let bob: string;

beforeAll(async () => {
  ({ postgres, databaseUrl } = await startDatabase());
  issuer = await startTestIssuer();
  configDir = await mkdtemp(join(tmpdir(), 'aiops-policy-e2e-'));
  await cp(FIXTURE_CONFIG, configDir, { recursive: true });
  api = await startApi(databaseUrl, { issuer, configDir, invoker });
  alice = await tokenFor(issuer, api, 'alice-id', ['content']);
  bob = await tokenFor(issuer, api, 'bob-id', ['support']);
});

afterAll(async () => {
  await api.close();
  await issuer.close();
  await postgres.stop();
  await rm(configDir, { recursive: true });
});

beforeEach(() => {
  invoker.calls.length = 0;
});

/** Calls a tool and returns the result together with the request's correlation ID. */
async function call(token: string, name: string, args: Record<string, unknown>): Promise<{ result: unknown; correlationId: string }> {
  let correlationId = '';
  const client = await connectClient({
    era: 'modern',
    baseUrls: [api.url],
    token,
    onResponse: (r) => {
      correlationId = r.headers.get('x-correlation-id') ?? correlationId;
    },
  });
  try {
    const result = await client.callTool({ name, arguments: args });
    return { result, correlationId };
  } finally {
    await client.close();
  }
}

describe('MCP-2 alice (content) and bob (support) see different tool lists', () => {
  for (const era of ['modern', 'legacy'] as const) {
    it(`MCP-2 ${era} era`, async () => {
      const a = await connectClient({ era, baseUrls: [api.url], token: alice });
      const b = await connectClient({ era, baseUrls: [api.url], token: bob });
      expect((await a.listTools()).tools.map((t) => t.name)).toEqual([...BUILTIN_NAMES, 'catalog.search_products']);
      expect((await b.listTools()).tools.map((t) => t.name)).toEqual([...BUILTIN_NAMES, 'support.lookup_order']);
      await a.close();
      await b.close();
    });
  }

  it('MCP-2 tools/list results are marked cacheScope private', async () => {
    const { body, headers } = modernRequest('tools/list');
    const response = await rawPost(api.url, body, { ...headers, authorization: `Bearer ${alice}` });
    const json = (await response.json()) as { result?: { cacheScope?: string } };
    expect(json.result?.cacheScope).toBe('private');
  });
});

describe('SEC-1 a hand-written tools/call for another user tool is rejected', () => {
  it('SEC-1 answers -32602 and audits a default-deny', async () => {
    const { body, headers } = modernRequest('tools/call', { name: 'catalog.search_products', arguments: { brand: 'acme', fields: [] } });
    const response = await rawPost(api.url, body, { ...headers, authorization: `Bearer ${bob}` });
    const json = (await response.json()) as { error?: { code: number; message: string } };
    expect(json.error?.code).toBe(-32602);
    expect(json.error?.message).toContain('Tool catalog.search_products not found');
    const rows = await auditRows(databaseUrl, 'correlation_id = $1', [response.headers.get('x-correlation-id')]);
    expect(rows).toEqual([
      expect.objectContaining({ action: 'policy.decision', decision: 'deny', actor: 'bob-id', subject: 'catalog.search_products', details: expect.objectContaining({ rule: 'default-deny', reason: 'no_grant' }) as unknown }),
    ]);
    expect(invoker.calls).toEqual([]);
  });
});

describe('POL-2 an out-of-scope call is denied and audited with the matching rule', () => {
  it('POL-2 POL-8 denies brand initech for the content manager', async () => {
    const { result, correlationId } = await call(alice, 'catalog.search_products', { brand: 'initech', fields: ['name'] });
    expect(result).toMatchObject({ isError: true });
    expect(text(result)).toContain('rule role:content_manager/grant:own-brands/scope:brand');
    const rows = await auditRows(databaseUrl, 'correlation_id = $1', [correlationId]);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      action: 'policy.decision',
      decision: 'deny',
      outcome: 'denied',
      actor: 'alice-id',
      client_id: 'aiops-mcp',
      subject: 'catalog.search_products',
      details: { rule: 'role:content_manager/grant:own-brands/scope:brand', reason: 'out_of_scope', detail: 'brand', roles: ['content_manager'] },
    });
    expect(invoker.calls).toEqual([]);
  });

  it('POL-8 an allowed call leaves an allow decision and the call', async () => {
    const { result, correlationId } = await call(alice, 'catalog.search_products', { brand: 'acme', fields: ['name'] });
    expect(text(result)).toBe('ran catalog.search_products');
    const rows = await auditRows(databaseUrl, 'correlation_id = $1', [correlationId]);
    expect(rows.map((r) => `${r.action}:${r.decision ?? r.outcome}`)).toEqual(['policy.decision:allow', 'tool.call:ok']);
    expect(rows[0]?.details).toMatchObject({ rule: 'role:content_manager/grant:own-brands' });
  });
});

describe('MCP-3 invalid arguments never reach policy or the invoker', () => {
  it('MCP-3 returns a validation error and records only the failed call', async () => {
    const { result, correlationId } = await call(alice, 'catalog.search_products', { brand: ['acme'], fields: [] });
    expect(text(result)).toMatch(/^Input validation error: Invalid arguments for tool catalog\.search_products/);
    const rows = await auditRows(databaseUrl, 'correlation_id = $1', [correlationId]);
    expect(rows.map((r) => r.action)).toEqual(['tool.call']);
    expect(rows[0]?.details).toMatchObject({ errorCode: 'invalid_arguments' });
    expect(invoker.calls).toEqual([]);
  });
});

describe('NFR-6 listing and denying make no invoker calls', () => {
  it('NFR-6 only an allowed call reaches the invoker', async () => {
    const client = await connectClient({ era: 'modern', baseUrls: [api.url], token: alice });
    await client.listTools();
    await client.callTool({ name: 'catalog.search_products', arguments: { brand: 'umbrella', fields: [] } });
    expect(invoker.calls).toEqual([]);
    await client.callTool({ name: 'catalog.search_products', arguments: { brand: 'globex', fields: [] } });
    expect(invoker.calls).toHaveLength(1);
    await client.close();
  });
});

describe('CFG-2 a rejected reload keeps the previous configuration', () => {
  it('CFG-2 alice still sees the search after an invalid reload', async () => {
    await writeFile(join(configDir, 'broken.yaml'), 'version: 1\nroles:\n  - id: Not Valid\n');
    const result = await reloadConfiguration(api);
    expect(result.ok).toBe(false);
    const client = await connectClient({ era: 'modern', baseUrls: [api.url], token: alice });
    expect((await client.listTools()).tools.map((t) => t.name)).toContain('catalog.search_products');
    await client.close();
    await rm(join(configDir, 'broken.yaml'));
  });
});
