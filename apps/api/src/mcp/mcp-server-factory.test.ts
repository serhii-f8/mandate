import { createMcpHandler } from '@modelcontextprotocol/server';
import { describe, expect, it } from 'vitest';
import { TASK_TTL_MS, type ChangeSetExecutor } from '@aiops/core';
import { createTaskResult } from './tasks/task-result.js';
import type { BuiltinTool } from './tool-catalog.js';
import { loadConfigurationSources } from '@aiops/config';
import { InMemoryAuditLog, InMemoryChangeSetRepository, InMemoryTaskRepository } from '@aiops/testing';
import { authInfoFor, createServerFactory } from './mcp-server-factory.js';
import { snapshotOf, type PipelineDeps } from './tool-pipeline.js';
import type { TaskHandlerDeps } from './tasks/task-handlers.js';

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
 * helpers, which this unit test does not import: they pull in the database and Nest). Task methods
 * carry the task ID in `Mcp-Name`, as the SDK's header ladder requires.
 */
function modernRequest(method: string, params: Record<string, unknown> = {}, capabilities: Record<string, unknown> = {}): Request {
  const mcpName = typeof params.taskId === 'string' ? params.taskId : typeof params.name === 'string' ? params.name : undefined;
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

function handler(builtins: PipelineDeps['builtins'] = [], tasks = new InMemoryTaskRepository()) {
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
  return async (request: Request): Promise<{ status: number; json: Record<string, unknown> }> => {
    const response = await mcp.fetch(request, { authInfo });
    return { status: response.status, json: (await response.json()) as Record<string, unknown> };
  };
}

describe('MCP-7 server factory', () => {
  it('MCP-7 server/discover advertises the Tasks extension', async () => {
    const { json } = await handler()(modernRequest('server/discover'));
    const result = json.result as { capabilities: { extensions?: Record<string, unknown>; tools?: unknown } };
    expect(result.capabilities.extensions?.[TASKS]).toEqual({});
    expect(result.capabilities.tools).toEqual({ listChanged: false });
  });

  it('MCP-7 tasks/get is routed to the handler', async () => {
    const { json } = await handler()(modernRequest('tasks/get', { taskId: '33333333-3333-4333-8333-333333333333' }, { extensions: { [TASKS]: {} } }));
    expect(json.error).toMatchObject({ code: -32602, message: 'Failed to retrieve task: Task not found' });
  });

  it('MCP-7 tasks/cancel without the declaration answers -32021', async () => {
    const { json } = await handler()(modernRequest('tasks/cancel', { taskId: '33333333-3333-4333-8333-333333333333' }));
    expect(json.error).toMatchObject({ code: -32021, data: { requiredCapabilities: { extensions: { [TASKS]: {} } } } });
  });

  it('MCP-7 tasks/update is routed to the handler', async () => {
    const { json } = await handler()(
      modernRequest('tasks/update', { taskId: '33333333-3333-4333-8333-333333333333', inputResponses: {} }, { extensions: { [TASKS]: {} } }),
    );
    expect(json.error).toMatchObject({ code: -32602, message: 'Failed to retrieve task: Task not found' });
  });

  it('MCP-7 tasks/update of an owned task answers resultType complete', async () => {
    const tasks = new InMemoryTaskRepository();
    const taskId = '44444444-4444-4444-8444-444444444444';
    await tasks.create({ taskId, owner: 'alice', changesetId: '55555555-5555-4555-8555-555555555555', kind: 'prepare', tool: 'shop.update_content', createdAt: new Date(0), ttlMs: TASK_TTL_MS });
    const { status, json } = await handler([], tasks)(modernRequest('tasks/update', { taskId, inputResponses: {} }, { extensions: { [TASKS]: {} } }));
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
    const { status, json } = await handler([probe(seen)])(modernRequest('tools/call', { name: 'probe', arguments: {} }, { extensions: { [TASKS]: {} } }));
    expect(status).toBe(200);
    expect(json.result).toMatchObject({ resultType: 'task', status: 'working', ttlMs: 604800000 });
    expect((json.result as { taskId?: string }).taskId).toBe('44444444-4444-4444-8444-444444444444');
    // Tripwire: today the SDK's tools/call wrapper adds an empty `content` to a task answer (ADR 0029).
    expect(json.result).toHaveProperty('content', []);
    expect(seen).toEqual([true]);
  });

  it('MCP-7 MCP-1 a request without the declaration reaches the built-in with tasks false', async () => {
    const seen: boolean[] = [];
    const { json } = await handler([probe(seen)])(modernRequest('tools/call', { name: 'probe', arguments: {} }));
    expect(seen).toEqual([false]);
    expect(json.result).toMatchObject({ content: [{ type: 'text', text: 'plain' }] });
    expect(json.result).not.toHaveProperty('taskId');
  });
});
