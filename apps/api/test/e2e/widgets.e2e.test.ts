/**
 * Widget bundles as MCP Apps UI resources over the real MCP transport (MCP-5, UI-6, SEC-1, AUTH-2).
 *
 * The api runs on `approval-config` with `AIOPS_WIDGET_DIR` set to `fixtures/widgets`, two small
 * HTML documents that stand in for the built bundles.
 */
import { cp, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startFakeUpstream, startTestIssuer, type FakeUpstream, type StartedPostgres, type TestIssuer } from '@aiops/testing';
import { connectClient, modernRequest, rawPost, startApi, startDatabase, text, tokenFor, vaultOf, type RunningApi } from './helpers.js';
import { taskSession, type WireEntry } from './tasks-client.js';

const APPROVAL_CONFIG = fileURLToPath(new URL('./fixtures/approval-config', import.meta.url));
const WIDGET_DIR = fileURLToPath(new URL('./fixtures/widgets', import.meta.url));
const UI_META = { ui: { csp: {}, prefersBorder: true } };
const MIME = 'text/html;profile=mcp-app';

let postgres: StartedPostgres;
let databaseUrl: string;
let issuer: TestIssuer;
let upstream: FakeUpstream;
let api: RunningApi;
let configDir: string;
let alice: string;
let bob: string;

beforeAll(async () => {
  const started = await startDatabase();
  postgres = started.postgres;
  databaseUrl = started.databaseUrl;
  issuer = await startTestIssuer();
  upstream = await startFakeUpstream();
  configDir = await mkdtemp(join(tmpdir(), 'aiops-widgets-e2e-'));
  await cp(APPROVAL_CONFIG, configDir, { recursive: true });
  const connections = join(configDir, 'connections.yaml');
  await writeFile(connections, (await readFile(connections, 'utf8')).replaceAll('__UPSTREAM_URL__', upstream.url));
  // SKU acme-404 is unknown upstream: the read before fails with HTTP 404 (MCP-6 preparation error).
  upstream.route('GET', '/rest/V1/products', (req) => {
    const skus = (req.query.get('skus') ?? '').split(',');
    if (skus.includes('acme-404')) return { status: 404, body: { message: 'not found' } };
    const items = skus.map((sku) => ({ sku, brand: 'acme', name: `Old ${sku}`, description: 'd' }));
    return { status: 200, body: { items, total_count: items.length } };
  });
  api = await startApi(databaseUrl, { issuer, configDir, widgetDir: WIDGET_DIR });
  await vaultOf(api).put({ ref: 'shop-token', scheme: 'bearer', secret: { token: 'e2e-only-upstream-token-widgets' }, actor: 'e2e-setup' });
  alice = await tokenFor(issuer, api, 'alice-id', ['content']);
  bob = await tokenFor(issuer, api, 'bob-id', ['content']);
});

afterAll(async () => {
  await api.close();
  await upstream.close();
  await issuer.close();
  await postgres.stop();
  await rm(configDir, { recursive: true });
});

describe('MCP-5 UI resources over HTTP', () => {
  it('MCP-5 a real client lists and reads both resources', async () => {
    const client = await connectClient({ era: 'modern', baseUrls: [api.url], token: alice });
    try {
      const { resources } = await client.listResources();
      expect(resources).toEqual([
        { uri: 'ui://aiops/changeset.html', name: 'changeset', title: 'Change-set', mimeType: MIME, _meta: UI_META },
        { uri: 'ui://aiops/approval.html', name: 'approval', title: 'Approval', mimeType: MIME, _meta: UI_META },
      ]);
      for (const file of ['changeset.html', 'approval.html']) {
        const uri = `ui://aiops/${file}`;
        const { contents } = await client.readResource({ uri });
        expect(contents).toEqual([{ uri, mimeType: MIME, text: await readFile(join(WIDGET_DIR, file), 'utf8'), _meta: UI_META }]);
      }
    } finally {
      await client.close();
    }
  });

  it('MCP-5 a legacy-era client lists and reads the resources too', async () => {
    const client = await connectClient({ era: 'legacy', baseUrls: [api.url], token: alice });
    try {
      const { resources } = await client.listResources();
      expect(resources.map((r) => r.uri)).toEqual(['ui://aiops/changeset.html', 'ui://aiops/approval.html']);
      const { contents } = await client.readResource({ uri: 'ui://aiops/changeset.html' });
      expect(contents).toEqual([{ uri: 'ui://aiops/changeset.html', mimeType: MIME, text: await readFile(join(WIDGET_DIR, 'changeset.html'), 'utf8'), _meta: UI_META }]);
    } finally {
      await client.close();
    }
  });

  it('MCP-5 an unknown URI rejects with code -32602 and data.uri', async () => {
    const client = await connectClient({ era: 'modern', baseUrls: [api.url], token: alice });
    try {
      await expect(client.readResource({ uri: 'ui://aiops/nope.html' })).rejects.toMatchObject({ code: -32602, data: { uri: 'ui://aiops/nope.html' } });
    } finally {
      await client.close();
    }
  });

  it('SEC-1 AUTH-2 resources/list without a bearer token is 401', async () => {
    const { body, headers } = modernRequest('resources/list');
    const response = await rawPost(api.url, body, headers);
    expect(response.status).toBe(401);
    expect(response.headers.get('www-authenticate')).not.toBeNull();
  });
});

describe('MCP-5 tool linkage over HTTP', () => {
  it('MCP-5 tools/list links shop.update_content, shop.retire_content and get_changeset to the change-set widget; ping and cancel_changeset link nothing', async () => {
    const client = await connectClient({ era: 'modern', baseUrls: [api.url], token: alice });
    try {
      const { tools } = await client.listTools();
      const meta = (name: string) => tools.find((t) => t.name === name)?._meta;
      const linked = { ui: { resourceUri: 'ui://aiops/changeset.html' }, 'ui/resourceUri': 'ui://aiops/changeset.html' };
      for (const name of ['shop.update_content', 'shop.retire_content', 'get_changeset', 'submit_for_approval', 'exclude_changeset_items']) {
        expect(meta(name), name).toEqual(linked);
      }
      for (const name of ['ping', 'cancel_changeset']) {
        expect(tools.some((t) => t.name === name), name).toBe(true);
        expect(meta(name), name).toBeUndefined();
      }
    } finally {
      await client.close();
    }
  });
});

interface ToolResult {
  isError?: boolean;
  content: { type: string; text: string }[];
  structuredContent?: Record<string, unknown>;
}

async function call(token: string, name: string, args: Record<string, unknown>, on: RunningApi = api): Promise<ToolResult> {
  const client = await connectClient({ era: 'modern', baseUrls: [on.url], token });
  try {
    return (await client.callTool({ name, arguments: args })) as unknown as ToolResult;
  } finally {
    await client.close();
  }
}

const pageOf = (id: string, on: RunningApi = api): string => `${on.url}/app/changesets/${id}`;

/** The summary ends with ` Open: <page>`, `pageUrl` is that page, and a JSON block repeats the structured content. */
function expectLinked(result: ToolResult, id: string, on: RunningApi = api): void {
  const url = pageOf(id, on);
  expect(result.content[0]?.text.endsWith(` Open: ${url}`), result.content[0]?.text).toBe(true);
  expect(result.structuredContent?.pageUrl).toBe(url);
  const data = result.content[1]?.text;
  if (data !== undefined) expect(JSON.parse(data)).toEqual(result.structuredContent);
}

async function prepare(skus: string[]): Promise<{ id: string; hash: string; result: ToolResult }> {
  const result = await call(alice, 'shop.update_content', { brand: 'acme', skus, changes: { name: 'New name' } });
  const changeset = result.structuredContent?.changeset as { id: string; hash: string; status: string };
  expect(changeset.status).toBe('prepared');
  return { id: changeset.id, hash: changeset.hash, result };
}

describe('MCP-6 every result that refers to a change-set links the page', () => {
  it('MCP-6 prepared, get_changeset and exclude_changeset_items', async () => {
    const { id, hash, result } = await prepare(['acme-1', 'acme-2', 'acme-3']);
    expectLinked(result, id);
    expectLinked(await call(alice, 'get_changeset', { changeset_id: id }), id);
    const derived = await call(alice, 'exclude_changeset_items', { changeset_id: id, hash, exclude: ['acme-1'] });
    expect(derived.isError).toBeUndefined();
    const derivedId = (derived.structuredContent?.changeset as { id: string }).id;
    expect(derivedId).not.toBe(id);
    expectLinked(derived, derivedId);
    // A refusal for alice's own change-set links it too (ruling F5).
    const stale = await call(alice, 'exclude_changeset_items', { changeset_id: id, hash: `sha256:${'0'.repeat(64)}`, exclude: ['acme-1'] });
    expect(stale.isError).toBe(true);
    expect(text(stale)).toBe(`The change-set changed; review it again. Open: ${pageOf(id)}`);
    expect(stale.structuredContent).toEqual({ changesetId: id, pageUrl: pageOf(id) });
  });

  it('MCP-6 preparing', async () => {
    const slow = await startApi(databaseUrl, { issuer, configDir, widgetDir: WIDGET_DIR, prepareDelayMs: 3000, prepareWaitMs: 0 });
    try {
      const token = await tokenFor(issuer, slow, 'alice-id', ['content']);
      const result = await call(token, 'shop.update_content', { brand: 'acme', skus: ['acme-1'], changes: { name: 'Slow name' } }, slow);
      expect(result.structuredContent?.status).toBe('preparing');
      const id = String(result.structuredContent?.changesetId);
      expect(text(result)).toBe(`Change-set ${id} is being prepared. Call get_changeset with this ID to see the result. Open: ${pageOf(id, slow)}`);
      expect(result.structuredContent).toEqual({ changesetId: id, status: 'preparing', pageUrl: pageOf(id, slow) });
    } finally {
      await slow.close();
    }
  });

  it('MCP-6 a preparation error with a change-set ID', async () => {
    const result = await call(alice, 'shop.update_content', { brand: 'acme', skus: ['acme-404'], changes: { name: 'New name' } });
    expect(result.isError).toBe(true);
    const id = (result.structuredContent?.changeset as { id: string }).id;
    expect(text(result).startsWith(`shop.update_content failed: the upstream system answered HTTP 404 (change-set ${id}).`)).toBe(true);
    expectLinked(result, id);
  });

  it('MCP-6 submit pending names the URL once; submit executing links it', async () => {
    const pending = await prepare(['acme-1', 'acme-2']);
    const submitted = await call(alice, 'submit_for_approval', { changeset_id: pending.id, hash: pending.hash });
    const url = pageOf(pending.id);
    expect(text(submitted).split(url).length).toBe(2);
    expect(text(submitted).endsWith(`Approvers decide on ${url}.`)).toBe(true);
    expect(submitted.structuredContent?.pageUrl).toBe(url);

    const direct = await prepare(['acme-1']);
    const started = await call(alice, 'submit_for_approval', { changeset_id: direct.id, hash: direct.hash });
    expect(started.structuredContent?.status).toBe('executing');
    expect(text(started)).toBe(`Execution of 1 changes started. Call get_changeset with this ID to follow it. Open: ${pageOf(direct.id)}`);
    expectLinked(started, direct.id);
  });

  it('MCP-6 MCP-7 the final tasks/get result of a submit task links the page', async () => {
    const { id, hash } = await prepare(['acme-1']);
    const wire: WireEntry[] = [];
    const client = await connectClient({ era: 'modern', baseUrls: [api.url], token: alice });
    const session = taskSession(client, { token: alice, baseUrls: [api.url], wire });
    try {
      const execution = await session.callTool('submit_for_approval', { changeset_id: id, hash });
      expect(execution.kind).toBe('task');
      const { outcome } = await execution.settle();
      expect(outcome.status).toBe('completed');
      const result = outcome.status === 'completed' ? (outcome.result as unknown as ToolResult) : undefined;
      expect(result?.content[0]?.text).toBe(`completed: 1 written, 0 failed, 0 skipped (0 changed upstream since preparation). Open: ${pageOf(id)}`);
      expect(result?.structuredContent?.pageUrl).toBe(pageOf(id));
      expect(wire.some((w) => w.method === 'tasks/get')).toBe(true);
    } finally {
      await session.close();
      await client.close();
    }
  });

  it('MCP-6 a policy denial and a foreign change-set carry no URL', async () => {
    const denied = await call(alice, 'shop.update_content', { brand: 'initech', skus: ['acme-1'], changes: { name: 'X' } });
    expect(denied.isError).toBe(true);
    const { id } = await prepare(['acme-1']);
    const foreign = await call(bob, 'get_changeset', { changeset_id: id });
    expect(text(foreign)).toBe(`Change-set ${id} was not found.`);
    for (const result of [denied, foreign]) {
      expect(text(result)).not.toContain('/app/changesets/');
      expect(result.structuredContent ?? {}).not.toHaveProperty('pageUrl');
    }
  });
});
