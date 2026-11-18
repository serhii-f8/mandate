import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createMcpHandler } from '@modelcontextprotocol/server';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { TASK_TTL_MS, type ChangeSetExecutor } from '@aiops/core';
import { createTaskResult } from './tasks/task-result.js';
import type { BuiltinTool } from './tool-catalog.js';
import { loadConfigurationSources } from '@aiops/config';
import { InMemoryAuditLog, InMemoryChangeSetRepository, InMemoryTaskRepository } from '@aiops/testing';
import { authInfoFor, createServerFactory } from './mcp-server-factory.js';
import { snapshotOf, type PipelineDeps } from './tool-pipeline.js';
import type { TaskHandlerDeps } from './tasks/task-handlers.js';
import { WidgetBundles, type WidgetCatalog } from './widget-bundles.js';

const MODERN = '2026-07-28';
const TASKS = 'io.modelcontextprotocol/tasks';

const loaded = await loadConfigurationSources([
  { file: 'connections.yaml', text: 'version: 1\nconnections: []\n' },
  { file: 'operations.yaml', text: 'version: 1\noperations: []\n' },
  { file: 'roles.yaml', text: 'version: 1\nroles: []\nrole_mapping: []\n' },
]);
if (!loaded.ok) throw new Error(JSON.stringify(loaded.issues));
const configuration = loaded.configuration;

/**
 * A 2026-07-28 request as a raw client sends it (the same shape as `modernRequest` in the e2e
 * helpers, which this unit test does not import: they pull in the database and Nest). Task methods,
 * `tools/call` and `resources/read` carry the task ID, tool name or URI in `Mcp-Name`, as the SDK's header ladder requires.
 */
function modernRequest(method: string, params: Record<string, unknown> = {}, capabilities: Record<string, unknown> = {}): Request {
  const source = params.taskId ?? params.name ?? params.uri;
  const mcpName = typeof source === 'string' ? source : undefined;
  const name = mcpName === undefined ? {} : { 'mcp-name': mcpName };
  return new Request('http://127.0.0.1/mcp', {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', 'mcp-protocol-version': MODERN, 'mcp-method': method, ...name },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method,
      params: {
        ...params,
        _meta: {
          'io.modelcontextprotocol/protocolVersion': MODERN,
          'io.modelcontextprotocol/clientInfo': { name: 'raw', version: '1' },
          'io.modelcontextprotocol/clientCapabilities': capabilities,
        },
      },
    }),
  });
}

const unusedExecutor: ChangeSetExecutor = {
  start: () => Promise.reject(new Error('not used')),
  cancel: () => Promise.reject(new Error('not used')),
  progress: () => Promise.reject(new Error('not used')),
  wake: () => Promise.resolve(),
};

const CHANGESET_HTML = '<!doctype html><title>changeset widget</title>';
const APPROVAL_HTML = '<!doctype html><title>approval widget</title>';
let widgetDir: string;
let twoBundles: WidgetBundles;

beforeAll(async () => {
  widgetDir = await mkdtemp(join(tmpdir(), 'aiops-factory-widgets-'));
  await writeFile(join(widgetDir, 'changeset.html'), CHANGESET_HTML);
  await writeFile(join(widgetDir, 'approval.html'), APPROVAL_HTML);
  twoBundles = await WidgetBundles.load(widgetDir, (message) => {
    throw new Error(message);
  });
});

afterAll(async () => {
  await rm(widgetDir, { recursive: true });
});

/** The factory behind the SDK's fetch handler; `audit` is the log both the pipeline and the task handlers write. */
function handler(builtins: PipelineDeps['builtins'] = [], tasks = new InMemoryTaskRepository(), widgets: WidgetCatalog = twoBundles) {
  const audit = new InMemoryAuditLog();
  const deps: PipelineDeps = {
    snapshot: () => snapshotOf(configuration),
    builtins,
    invokerFor: () => {
      throw new Error('not used');
    },
    audit,
    newId: () => '00000000-0000-4000-8000-000000000001',
    now: () => 0,
    rateCounter: { hit: () => Promise.reject(new Error('not used')) },
    wallClock: () => new Date(0),
    widgets,
    publicUrl: new URL('https://aiops.example.test'),
  };
  const taskDeps: TaskHandlerDeps = {
    tasks,
    repository: new InMemoryChangeSetRepository(),
    executor: unusedExecutor,
    audit,
    newId: () => '00000000-0000-4000-8000-000000000002',
  };
  const mcp = createMcpHandler(createServerFactory(deps, taskDeps), { legacy: 'stateless', responseMode: 'json' });
  const authInfo = authInfoFor({ caller: { subject: 'alice', groups: [] }, correlationId: 'corr-1' }, undefined);
  const call = async (request: Request): Promise<{ status: number; json: Record<string, unknown> }> => {
    const response = await mcp.fetch(request, { authInfo });
    return { status: response.status, json: (await response.json()) as Record<string, unknown> };
  };
  return { call, audit };
}

describe('MCP-7 server factory', () => {
  it('MCP-7 server/discover advertises the Tasks extension', async () => {
    const { json } = await handler().call(modernRequest('server/discover'));
    const result = json.result as { capabilities: { extensions?: Record<string, unknown>; tools?: unknown } };
    expect(result.capabilities.extensions?.[TASKS]).toEqual({});
    expect(result.capabilities.tools).toEqual({ listChanged: false });
  });

  it('MCP-7 tasks/get is routed to the handler', async () => {
    const { json } = await handler().call(modernRequest('tasks/get', { taskId: '33333333-3333-4333-8333-333333333333' }, { extensions: { [TASKS]: {} } }));
    expect(json.error).toMatchObject({ code: -32602, message: 'Failed to retrieve task: Task not found' });
  });

  it('MCP-7 tasks/cancel without the declaration answers -32021', async () => {
    const { json } = await handler().call(modernRequest('tasks/cancel', { taskId: '33333333-3333-4333-8333-333333333333' }));
    expect(json.error).toMatchObject({ code: -32021, data: { requiredCapabilities: { extensions: { [TASKS]: {} } } } });
  });

  it('MCP-7 tasks/update is routed to the handler', async () => {
    const { json } = await handler().call(
      modernRequest('tasks/update', { taskId: '33333333-3333-4333-8333-333333333333', inputResponses: {} }, { extensions: { [TASKS]: {} } }),
    );
    expect(json.error).toMatchObject({ code: -32602, message: 'Failed to retrieve task: Task not found' });
  });

  it('MCP-7 tasks/update of an owned task answers resultType complete', async () => {
    const tasks = new InMemoryTaskRepository();
    const taskId = '44444444-4444-4444-8444-444444444444';
    await tasks.create({ taskId, owner: 'alice', changesetId: '55555555-5555-4555-8555-555555555555', kind: 'prepare', tool: 'shop.update_content', createdAt: new Date(0), ttlMs: TASK_TTL_MS });
    const { status, json } = await handler([], tasks).call(modernRequest('tasks/update', { taskId, inputResponses: {} }, { extensions: { [TASKS]: {} } }));
    expect(status).toBe(200);
    expect(json.error).toBeUndefined();
    // The SDK adds `_meta` (serverInfo) to every 2026-07-28 result; the handler's answer is the rest.
    const result = json.result as Record<string, unknown>;
    expect(Object.keys(result).filter((key) => key !== '_meta')).toEqual(['resultType']);
    expect(result.resultType).toBe('complete');
  });

  const probe = (seen: boolean[]): BuiltinTool => ({
    name: 'probe',
    description: 'probe',
    inputSchema: { type: 'object' },
    validate: () => ({ ok: true }),
    handler(_args, ctx) {
      seen.push(ctx.tasks);
      return Promise.resolve(
        ctx.tasks
          ? createTaskResult({ taskId: '44444444-4444-4444-8444-444444444444', owner: 'alice', changesetId: 'cs', kind: 'prepare', tool: 'probe', createdAt: new Date(), ttlMs: 604800000 })
          : { content: [{ type: 'text', text: 'plain' }] },
      );
    },
  });

  it('MCP-7 a declaring request reaches the built-in with tasks true; resultType and taskId survive the SDK wrapper', async () => {
    const seen: boolean[] = [];
    const { status, json } = await handler([probe(seen)]).call(modernRequest('tools/call', { name: 'probe', arguments: {} }, { extensions: { [TASKS]: {} } }));
    expect(status).toBe(200);
    expect(json.result).toMatchObject({ resultType: 'task', status: 'working', ttlMs: 604800000 });
    expect((json.result as { taskId?: string }).taskId).toBe('44444444-4444-4444-8444-444444444444');
    // Tripwire: today the SDK's tools/call wrapper adds an empty `content` to a task answer (ADR 0029).
    expect(json.result).toHaveProperty('content', []);
    expect(seen).toEqual([true]);
  });

  it('MCP-7 MCP-1 a request without the declaration reaches the built-in with tasks false', async () => {
    const seen: boolean[] = [];
    const { json } = await handler([probe(seen)]).call(modernRequest('tools/call', { name: 'probe', arguments: {} }));
    expect(seen).toEqual([false]);
    expect(json.result).toMatchObject({ content: [{ type: 'text', text: 'plain' }] });
    expect(json.result).not.toHaveProperty('taskId');
  });
});

describe('MCP-5 UI resources', () => {
  const UI_META = { ui: { csp: {}, prefersBorder: true } };
  const CHANGESET = { uri: 'ui://aiops/changeset.html', name: 'changeset', title: 'Change-set', mimeType: 'text/html;profile=mcp-app', _meta: UI_META };
  const APPROVAL = { uri: 'ui://aiops/approval.html', name: 'approval', title: 'Approval', mimeType: 'text/html;profile=mcp-app', _meta: UI_META };

  it('MCP-5 server/discover declares the resources capability next to tools and the Tasks extension', async () => {
    const { json } = await handler().call(modernRequest('server/discover'));
    const result = json.result as { capabilities: Record<string, unknown> & { extensions?: Record<string, unknown> } };
    expect(result.capabilities.resources).toEqual({ listChanged: false });
    expect(result.capabilities.tools).toEqual({ listChanged: false });
    expect(result.capabilities.extensions?.[TASKS]).toEqual({});
  });

  it('MCP-5 UI-6 resources/list names both bundles with the MCP Apps MIME type and an empty CSP', async () => {
    const { json } = await handler().call(modernRequest('resources/list'));
    expect(json.error).toBeUndefined();
    const { resources } = json.result as { resources: unknown[] };
    expect(resources).toHaveLength(2);
    expect(resources[0]).toEqual(CHANGESET);
    expect(resources[1]).toEqual(APPROVAL);
  });

  it('MCP-5 resources/read returns the bundle text with the same _meta', async () => {
    const h = handler();
    for (const [entry, html] of [
      [CHANGESET, CHANGESET_HTML],
      [APPROVAL, APPROVAL_HTML],
    ] as const) {
      const { json } = await h.call(modernRequest('resources/read', { uri: entry.uri }));
      expect(json.error).toBeUndefined();
      expect((json.result as { contents: unknown }).contents).toEqual([{ uri: entry.uri, mimeType: 'text/html;profile=mcp-app', text: html, _meta: UI_META }]);
    }
  });

  it('MCP-5 an unknown URI answers -32602 with data.uri', async () => {
    const h = handler();
    for (const uri of ['ui://aiops/nope.html', 'ui://aiops/changeset.html?x=1', 'UI://aiops/changeset.html', 'ui://aiops/../aiops/changeset.html']) {
      const { json } = await h.call(modernRequest('resources/read', { uri }));
      expect(json.result).toBeUndefined();
      expect(json.error).toMatchObject({ code: -32602, data: { uri } });
    }
  });

  it('MCP-5 resources/templates/list is empty', async () => {
    const { json } = await handler().call(modernRequest('resources/templates/list'));
    expect(json.error).toBeUndefined();
    expect((json.result as { resourceTemplates: unknown }).resourceTemplates).toEqual([]);
  });

  it('MCP-6 without bundles resources/list is empty and every read is -32602', async () => {
    const h = handler([], new InMemoryTaskRepository(), WidgetBundles.empty());
    const listed = await h.call(modernRequest('resources/list'));
    expect((listed.json.result as { resources: unknown }).resources).toEqual([]);
    for (const uri of [CHANGESET.uri, APPROVAL.uri]) {
      const { json } = await h.call(modernRequest('resources/read', { uri }));
      expect(json.error).toMatchObject({ code: -32602, data: { uri } });
    }
  });

  it('AUD-1 resource reads write no audit row', async () => {
    const h = handler();
    const listed = await h.call(modernRequest('resources/list'));
    const read = await h.call(modernRequest('resources/read', { uri: CHANGESET.uri }));
    await h.call(modernRequest('resources/read', { uri: 'ui://aiops/nope.html' }));
    await h.call(modernRequest('resources/templates/list'));
    expect((listed.json.result as { resources: unknown[] }).resources).toHaveLength(2);
    expect((read.json.result as { contents: unknown[] }).contents).toHaveLength(1);
    expect(h.audit.events).toEqual([]);
  });
});
