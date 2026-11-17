import { createMcpHandler } from '@modelcontextprotocol/server';
import { describe, expect, it } from 'vitest';
import type { ChangeSetExecutor } from '@aiops/core';
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
  const name = typeof params.taskId === 'string' ? { 'mcp-name': params.taskId } : {};
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
};

function handler() {
  const audit = new InMemoryAuditLog();
  const deps: PipelineDeps = {
    snapshot: () => snapshotOf(configuration),
    builtins: [],
    invokerFor: () => {
      throw new Error('not used');
    },
    audit,
    newId: () => '00000000-0000-4000-8000-000000000001',
    now: () => 0,
  };
  const taskDeps: TaskHandlerDeps = {
    tasks: new InMemoryTaskRepository(),
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
    expect(json.error).toMatchObject({ code: -32602 });
  });
});
