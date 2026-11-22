// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Mandate Authors
import { cp, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import type { Client } from '@modelcontextprotocol/client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startFakeUpstream, startTestIssuer, type FakeUpstream, type StartedPostgres, type TestIssuer } from '@mandate/testing';
import { auditRows, connectClient, MODERN, rawPost, startApi, startDatabase, text, tokenFor, vaultOf, type RunningApi } from './helpers.js';
import { taskSession, type WireEntry } from './tasks-client.js';

const TASKS_CONFIG = fileURLToPath(new URL('./fixtures/tasks-config', import.meta.url));
const TASKS = 'io.modelcontextprotocol/tasks';
const ARGS = { brand: 'acme', skus: ['acme-1', 'acme-2'], changes: { name: 'New name' } };

let postgres: StartedPostgres;
let databaseUrl: string;
let issuer: TestIssuer;
let upstream: FakeUpstream;
let configDir: string;
/** A prepares after a delay; B prepares at once; C answers plain clients after a short bounded wait. */
let a: RunningApi;
let b: RunningApi;
let c: RunningApi;
let alice: string;
let bob: string;
const open: Client[] = [];

interface ToolResult {
  isError?: boolean;
  resultType?: string;
  content: { type: string; text: string }[];
  structuredContent?: Record<string, unknown>;
}

beforeAll(async () => {
  ({ postgres, databaseUrl } = await startDatabase());
  issuer = await startTestIssuer();
  upstream = await startFakeUpstream();
  configDir = await mkdtemp(join(tmpdir(), 'mandate-tasks-e2e-'));
  await cp(TASKS_CONFIG, configDir, { recursive: true });
  const connections = join(configDir, 'connections.yaml');
  await writeFile(connections, (await readFile(connections, 'utf8')).replaceAll('__UPSTREAM_URL__', upstream.url));
  upstream.route('GET', '/rest/V1/products', (req) => {
    const skus = (req.query.get('skus') ?? '').split(',');
    const items = skus.map((sku) => ({ sku, brand: 'acme', name: `Old ${sku}`, description: 'd' }));
    return { status: 200, body: { items, total_count: items.length } };
  });
  // The first task poll comes after the server's pollIntervalMs (2000 ms); A's preparation outlasts two polls.
  a = await startApi(databaseUrl, { issuer, configDir, prepareDelayMs: 4500 });
  // One installation behind one URL: every instance serves A's resource.
  b = await startApi(databaseUrl, { issuer, configDir, resource: a.resource });
  c = await startApi(databaseUrl, { issuer, configDir, resource: a.resource, prepareWaitMs: 300, prepareDelayMs: 1500 });
  await vaultOf(a).put({ ref: 'shop-token', scheme: 'bearer', secret: { token: 'e2e-only-upstream-token-tasks' }, actor: 'e2e-setup' });
  alice = await tokenFor(issuer, a, 'alice-id', ['content']);
  bob = await tokenFor(issuer, a, 'bob-id', ['content']);
});

afterAll(async () => {
  await Promise.all(open.map((client) => client.close()));
  await c.close();
  await b.close();
  await a.close();
  await upstream.close();
  await issuer.close();
  await postgres.stop();
  await rm(configDir, { recursive: true });
});

async function modernClient(token: string, baseUrls: readonly string[]): Promise<Client> {
  const client = await connectClient({ era: 'modern', baseUrls, token });
  open.push(client);
  return client;
}

/** A plain (non-declaring) 2026-07-28 call on `api`. */
async function plainCall(api: RunningApi, name: string, args: Record<string, unknown>, token = alice): Promise<ToolResult> {
  return (await (await modernClient(token, [api.url])).callTool({ name, arguments: args })) as unknown as ToolResult;
}

/** A raw `tasks/*` request that declares the extension, as a task-aware client sends it. */
function taskRequest(method: string, taskId: string, token: string): { body: unknown; headers: Record<string, string> } {
  return {
    headers: { authorization: `Bearer ${token}`, 'mcp-protocol-version': MODERN, 'mcp-method': method, 'mcp-name': taskId },
    body: {
      jsonrpc: '2.0',
      id: 1,
      method,
      params: {
        taskId,
        _meta: {
          'io.modelcontextprotocol/protocolVersion': MODERN,
          'io.modelcontextprotocol/clientInfo': { name: 'raw', version: '1' },
          'io.modelcontextprotocol/clientCapabilities': { extensions: { [TASKS]: {} } },
        },
      },
    },
  };
}

interface RawAnswer {
  json: { result?: Record<string, unknown>; error?: { code: number } };
  correlationId: string;
}

async function rawTask(api: RunningApi, method: string, taskId: string, token: string): Promise<RawAnswer> {
  const { body, headers } = taskRequest(method, taskId, token);
  const response = await rawPost(api.url, body, headers);
  return { json: (await response.json()) as RawAnswer['json'], correlationId: response.headers.get('x-correlation-id') ?? '' };
}

const structured = (result: unknown): Record<string, unknown> => (result as ToolResult).structuredContent ?? {};

describe('MCP-7 Tasks across api instances', () => {
  it('MCP-7 NFR-3 a declaring client gets a task for a write call and polls it to completed across two api instances', async () => {
    const wire: WireEntry[] = [];
    const session = taskSession(await modernClient(alice, [a.url, b.url]), { token: alice, baseUrls: [a.url, b.url], wire });
    try {
      const execution = await session.callTool('shop.update_content', ARGS);
      expect(execution.kind).toBe('task');
      const { outcome } = await execution.settle();
      expect(outcome.status).toBe('completed');
      const result = outcome.status === 'completed' ? outcome.result : undefined;
      expect((structured(result).changeset as { status?: string } | undefined)?.status).toBe('prepared');

      const call = wire.find((w) => w.method === 'tools/call');
      expect(call?.port).toBe(Number(new URL(a.url).port));
      expect(call?.json.result?.resultType).toBe('task');
      const polls = wire.filter((w) => w.method === 'tasks/get');
      expect(new Set(polls.map((p) => p.port))).toEqual(new Set([Number(new URL(a.url).port), Number(new URL(b.url).port)]));
      expect(polls.some((p) => p.json.result?.status === 'working')).toBe(true);
      expect(wire.some((w) => w.method === 'tasks/cancel')).toBe(false);
    } finally {
      await session.close();
    }
  });

  it('MCP-7 MCP-1 a plain client gets the bounded-wait answer and follows it with get_changeset', async () => {
    const result = await plainCall(c, 'shop.update_content', ARGS);
    expect(result.isError).toBeUndefined();
    const changesetId = String(structured(result).changesetId);
    expect(result.structuredContent).toEqual({ changesetId, status: 'preparing', pageUrl: `${c.url}/app/changesets/${changesetId}` });
    expect(text(result)).toBe(
      `Change-set ${changesetId} is being prepared. Call get_changeset with this ID to see the result. Open: ${c.url}/app/changesets/${changesetId}`,
    );

    let status = 'preparing';
    for (const deadline = Date.now() + 10_000; status !== 'prepared' && Date.now() < deadline; ) {
      await sleep(250);
      const read = await plainCall(c, 'get_changeset', { changeset_id: changesetId });
      status = String((structured(read).changeset as { status?: string } | undefined)?.status);
    }
    expect(status).toBe('prepared');
  });

  it('MCP-1 a 2025-era client never gets a task', async () => {
    const client = await connectClient({ era: 'legacy', baseUrls: [b.url], token: alice });
    open.push(client);
    const result = (await client.callTool({ name: 'shop.update_content', arguments: ARGS })) as unknown as ToolResult;
    expect(result.resultType).not.toBe('task');
    expect((structured(result).changeset as { id?: string } | undefined)?.id).toEqual(expect.any(String));
  });

  it('SEC-1 tasks/get by another user answers -32602', async () => {
    const wire: WireEntry[] = [];
    const session = taskSession(await modernClient(alice, [b.url]), { token: alice, baseUrls: [b.url], wire });
    let taskId: string;
    try {
      const execution = await session.callTool('shop.update_content', ARGS);
      expect(execution.kind).toBe('task');
      taskId = execution.handle?.taskId ?? '';
      await execution.settle();
    } finally {
      await session.close();
    }
    const foreign = await rawTask(a, 'tasks/get', taskId, bob);
    expect(foreign.json.error?.code).toBe(-32602);
    expect(foreign.json.result).toBeUndefined();
    const own = await rawTask(a, 'tasks/get', taskId, alice);
    expect(own.json.error).toBeUndefined();
    expect(own.json.result).toMatchObject({ taskId, status: 'completed' });
  });

  it('MCP-7 server/discover advertises the Tasks extension', async () => {
    const response = await rawPost(
      b.url,
      {
        jsonrpc: '2.0',
        id: 1,
        method: 'server/discover',
        params: {
          _meta: {
            'io.modelcontextprotocol/protocolVersion': MODERN,
            'io.modelcontextprotocol/clientInfo': { name: 'raw', version: '1' },
            'io.modelcontextprotocol/clientCapabilities': {},
          },
        },
      },
      { authorization: `Bearer ${alice}`, 'mcp-protocol-version': MODERN, 'mcp-method': 'server/discover' },
    );
    expect(response.status).toBe(200);
    const json = (await response.json()) as { result?: { capabilities?: { extensions?: Record<string, unknown> } } };
    expect(json.result?.capabilities?.extensions).toEqual({ [TASKS]: {} });
  });

  it('MCP-8 POL-6 MCP-7 submit_for_approval starts execution and its task completes with the execution result', async () => {
    const prepared = await plainCall(b, 'shop.update_content', ARGS);
    const { id, hash } = structured(prepared).changeset as { id: string; hash: string };
    expect(hash).toMatch(/^sha256:/);

    const wire: WireEntry[] = [];
    const session = taskSession(await modernClient(alice, [a.url, b.url]), { token: alice, baseUrls: [a.url, b.url], wire });
    try {
      const execution = await session.callTool('submit_for_approval', { changeset_id: id, hash });
      expect(execution.kind).toBe('task');
      const { outcome } = await execution.settle();
      expect(outcome.status).toBe('completed');
      const result = outcome.status === 'completed' ? (outcome.result as unknown as ToolResult) : undefined;
      expect(result?.isError).toBeUndefined();
      // The instance that answered the final poll builds the link from its own public URL.
      const final = wire.filter((w) => w.method === 'tasks/get').at(-1);
      expect(result?.content[0]?.text).toBe(
        `completed: 2 written, 0 failed, 0 skipped (0 changed upstream since preparation). Open: http://127.0.0.1:${String(final?.port)}/app/changesets/${id}`,
      );
    } finally {
      await session.close();
    }
    const read = structured(await plainCall(a, 'get_changeset', { changeset_id: id }));
    expect((read.changeset as { status?: string }).status).toBe('completed');
    expect((read.progress as { done?: number } | undefined)?.done).toBe(2);
  });

  it('AUD-1 task creation and cancellation are audited', async () => {
    const wire: WireEntry[] = [];
    const session = taskSession(await modernClient(alice, [a.url, b.url]), { token: alice, baseUrls: [a.url, b.url], wire });
    let taskId: string;
    try {
      // On A the preparation waits, so the task is still working when it is cancelled.
      const execution = await session.callTool('shop.update_content', ARGS);
      expect(execution.kind).toBe('task');
      taskId = execution.handle?.taskId ?? '';
      await execution.cancel();
    } finally {
      await session.close();
    }
    const call = wire.find((w) => w.method === 'tools/call');
    expect(call?.json.result?.taskId).toBe(taskId);

    const [toolCall] = await auditRows(databaseUrl, "correlation_id = $1 and action = 'tool.call'", [call?.correlationId]);
    expect(toolCall?.details.taskId).toBe(taskId);
    expect(toolCall?.details.changesetId).toMatch(/^[0-9a-f-]{36}$/);

    const cancels = await auditRows(databaseUrl, "action = 'task.cancel' and details->>'taskId' = $1", [taskId]);
    expect(cancels).toHaveLength(1);
    expect(wire.filter((w) => w.method === 'tasks/cancel')).toHaveLength(1);
    const row = cancels[0] as unknown as { changeset_id: string | null; actor: string };
    expect(row.changeset_id).toBe(toolCall?.details.changesetId);
    expect(row.actor).toBe('alice-id');

    // Read it once more (it is cancelled now): reading a task is never audited.
    const own = await rawTask(b, 'tasks/get', taskId, alice);
    expect(own.json.result).toMatchObject({ taskId, status: 'cancelled' });
    const polls = [own.correlationId, ...wire.filter((w) => w.method === 'tasks/get').map((w) => w.correlationId)];
    expect(own.correlationId).not.toBe('');
    expect(await auditRows(databaseUrl, 'correlation_id = any($1)', [polls])).toEqual([]);
    expect((await auditRows(databaseUrl, "details->>'taskId' = $1", [taskId])).map((r) => r.action)).toEqual(['tool.call', 'task.cancel']);
  });
});
