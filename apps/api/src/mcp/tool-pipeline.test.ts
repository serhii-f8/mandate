import { ProtocolError, type CallToolResult } from '@modelcontextprotocol/server';
import { describe, expect, it } from 'vitest';
import type { AuditEventInput, Caller, RateCounter, InvocationRequest, InvocationResult, OperationInvoker } from '@aiops/core';
import { loadConfigurationSources, type LoadedConfiguration } from '@aiops/config';
import {
  FakeInvoker,
  InMemoryAuditLog,
  InMemoryChangeSetRepository,
  InMemoryExecutor,
  InMemoryRateCounter,
  InMemoryTaskRepository,
  ScriptedWriter,
} from '@aiops/testing';
import { ApprovalService } from '../approvals/approval-service.js';
import { callerFromAuthInfo } from '../auth/caller-from-auth.js';
import { pingTool, type BuiltinToolDeps } from './builtin-tools.js';
import { DECIDE_TOOL, decideChangesetTool } from './decide-tool.js';
import { WidgetBundles } from './widget-bundles.js';
import type { BuiltinTool } from './tool-catalog.js';
import { callTool, listTools, minuteWindow, snapshotOf, type PipelineDeps, type PipelineRequest } from './tool-pipeline.js';
import { createTaskResult, isTaskAnswer, type ToolAnswer } from './tasks/task-result.js';

/** Narrows an answer to a plain tool result; these tests never ask for a task. */
function plain(answer: ToolAnswer): CallToolResult {
  if (isTaskAnswer(answer)) throw new Error('unexpected task answer');
  return answer;
}

const SOURCES = {
  'connections.yaml': `version: 1
connections:
  - { id: magento, adapter: openapi, base_url: https://shop.example.test/rest, credential_ref: magento-integration, auth: { scheme: bearer } }
`,
  'operations.yaml': `version: 1
operations:
  - id: catalog.search_products
    connection: magento
    risk: read
    description: Search the catalog by brand.
    upstream: { method: GET, path: /V1/products, query: { brand: { arg: brand } }, response: { items: items, fields_from_arg: fields } }
    input_schema:
      type: object
      properties: { brand: { type: string }, fields: { type: array, items: { type: string } } }
      required: [brand, fields]
      additionalProperties: false
    fields_arg: fields
  - id: support.lookup_order
    connection: magento
    risk: read
    description: Look up an order.
    upstream: { method: GET, path: /V1/orders }
    input_schema: { type: object, properties: { order_number: { type: string } }, required: [order_number] }
`,
  'roles.yaml': `version: 1
roles:
  - id: content_manager
    grants:
      - { operation: catalog.search_products, id: own-brands, scope: { brand: [acme, globex] }, deny_fields: [cost] }
  - id: support_agent
    grants:
      - { operation: support.lookup_order }
role_mapping:
  - { group: content, roles: [content_manager] }
  - { group: support, roles: [support_agent] }
`,
};

const loaded = await loadConfigurationSources(Object.entries(SOURCES).map(([file, text]) => ({ file, text })));
if (!loaded.ok) throw new Error(JSON.stringify(loaded.issues));
const LOADED: LoadedConfiguration = loaded.configuration;

function configuration(): LoadedConfiguration {
  return LOADED;
}

const TOKEN = 'eyJhbGciOiJSUzI1NiJ9.do-not-leak-this-token.sig';
const alice: Caller = callerFromAuthInfo({ token: TOKEN, clientId: 'aiops-mcp', scopes: [], extra: { sub: 'alice-id', groups: ['content'] } });
const bob: Caller = { subject: 'bob-id', clientId: 'aiops-mcp', groups: ['support'] };

function setup() {
  const audit = new InMemoryAuditLog();
  const invoker = new FakeInvoker();
  const config = configuration();
  let n = 0;
  const deps: PipelineDeps = {
    snapshot: () => snapshotOf(config),
    builtins: [pingTool],
    invokerFor: () => invoker,
    audit,
    newId: () => `00000000-0000-4000-8000-${String(++n).padStart(12, '0')}`,
    now: () => 0,
    rateCounter: new InMemoryRateCounter(),
    wallClock: () => new Date('2026-11-17T12:00:30.000Z'),
    widgets: WidgetBundles.empty(),
    publicUrl: new URL('https://aiops.example.test'),
  };
  const req = (caller: Caller): PipelineRequest => ({ caller, correlationId: 'corr-1', snapshot: deps.snapshot(), tasks: false });
  return { audit, invoker, deps, req };
}

function text(result: { content: unknown[] }): string {
  return result.content.map((c) => (c as { text?: string }).text ?? '').join('');
}

function actions(events: readonly AuditEventInput[]): string[] {
  return events.map((e) => `${e.action}:${e.decision ?? e.outcome}`);
}

describe('MCP-2 per-user tool list', () => {
  it('lists the built-ins plus the operations granted to the caller', async () => {
    const { deps, req, audit } = setup();
    const tools = await listTools(deps, req(alice));
    expect(tools.map((t) => t.name)).toEqual(['ping', 'catalog.search_products']);
    const search = tools[1];
    expect(search?.inputSchema).toEqual(configuration().policy.operations[0]?.inputSchema);
    expect(search?.annotations).toMatchObject({ readOnlyHint: true, destructiveHint: false });
    expect((await listTools(deps, req(bob))).map((t) => t.name)).toEqual(['ping', 'support.lookup_order']);
    expect(audit.events[0]).toMatchObject({ action: 'tools.list', actor: 'alice-id', clientId: 'aiops-mcp', outcome: 'ok', details: { count: 2 } });
  });
});

describe('MCP-2 a non-granted tool is an unknown tool', () => {
  it('answers -32602 and audits the denial for a tool of another role', async () => {
    const { deps, req, audit, invoker } = setup();
    const error = await callTool(deps, req(bob), 'catalog.search_products', { brand: 'acme', fields: [] }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ProtocolError);
    expect((error as ProtocolError).code).toBe(-32602);
    expect((error as ProtocolError).message).toContain('Tool catalog.search_products not found');
    expect(audit.events).toEqual([
      expect.objectContaining({ action: 'policy.decision', decision: 'deny', subject: 'catalog.search_products', details: { rule: 'default-deny', reason: 'no_grant', roles: ['support_agent'] } }),
    ]);
    expect(invoker.calls).toEqual([]);
  });

  it('gives the same answer for a tool that does not exist, audited as unknown_tool', async () => {
    const { deps, req, audit } = setup();
    await expect(callTool(deps, req(bob), 'drop_database', {})).rejects.toThrow('Tool drop_database not found');
    expect(audit.events[0]?.details).toMatchObject({ rule: 'default-deny', reason: 'unknown_tool' });
  });
});

describe('MCP-3 arguments are validated before policy', () => {
  it('returns an input validation error and never evaluates policy or calls the invoker', async () => {
    const { deps, req, audit, invoker } = setup();
    const result = plain(await callTool(deps, req(alice), 'catalog.search_products', { brand: 5, fields: [] }));
    expect(result.isError).toBe(true);
    expect(text(result)).toMatch(/^Input validation error: Invalid arguments for tool catalog\.search_products: /);
    expect(actions(audit.events)).toEqual(['tool.call:error']);
    expect(audit.events[0]?.details).toMatchObject({ errorCode: 'invalid_arguments' });
    expect(invoker.calls).toEqual([]);
  });

  it('treats missing arguments as an empty object', async () => {
    const { deps, req } = setup();
    expect(text(plain(await callTool(deps, req(alice), 'catalog.search_products', undefined)))).toMatch(/brand/);
  });
});

describe('POL-8 every decision is audited with its rule', () => {
  it('records the allow, runs the operation, then records the call', async () => {
    const { deps, req, audit, invoker } = setup();
    const result = plain(await callTool(deps, req(alice), 'catalog.search_products', { brand: 'acme', fields: ['name'] }));
    expect(result.isError).not.toBe(true);
    expect(text(result)).toBe('ran catalog.search_products');
    expect(actions(audit.events)).toEqual(['policy.decision:allow', 'tool.call:ok']);
    expect(audit.events[0]?.details).toMatchObject({ rule: 'role:content_manager/grant:own-brands' });
    expect(invoker.calls).toHaveLength(1);
    expect(invoker.calls[0]).toMatchObject({ operation: { id: 'catalog.search_products' }, args: { brand: 'acme', fields: ['name'] }, caller: { subject: 'alice-id' } });
  });

  it('denies an out-of-scope call with the matching rule', async () => {
    const { deps, req, audit, invoker } = setup();
    const result = plain(await callTool(deps, req(alice), 'catalog.search_products', { brand: 'initech', fields: [] }));
    expect(result.isError).toBe(true);
    expect(text(result)).toBe("Denied by policy: argument 'brand' is outside your scope (rule role:content_manager/grant:own-brands/scope:brand)");
    expect(audit.events).toEqual([
      expect.objectContaining({ action: 'policy.decision', decision: 'deny', outcome: 'denied', details: expect.objectContaining({ rule: 'role:content_manager/grant:own-brands/scope:brand', reason: 'out_of_scope' }) as unknown }),
    ]);
    expect(JSON.stringify(audit.events)).not.toContain('initech');
    expect(invoker.calls).toEqual([]);
  });

  it('denies a denied field', async () => {
    const { deps, req } = setup();
    expect(text(plain(await callTool(deps, req(alice), 'catalog.search_products', { brand: 'acme', fields: ['cost'] })))).toBe(
      "Denied by policy: field 'cost' is denied (rule role:content_manager/grant:own-brands/deny_fields)",
    );
  });

  it('records built-in tools under the builtin rule', async () => {
    const { deps, req, audit } = setup();
    expect(text(plain(await callTool(deps, req(bob), 'ping', { message: 'hi' })))).toBe('pong: hi');
    expect(actions(audit.events)).toEqual(['policy.decision:allow', 'tool.call:ok']);
    expect(audit.events[0]?.details).toMatchObject({ rule: 'builtin' });
  });
});

describe('SEC-1 nothing runs without an allow decision on record', () => {
  it('does not run when the decision cannot be audited', async () => {
    const { deps, req, audit, invoker } = setup();
    audit.failNext = new Error('database down');
    const result = plain(await callTool(deps, req(alice), 'catalog.search_products', { brand: 'acme', fields: [] }));
    expect(text(result)).toBe('Audit unavailable; the call was not completed.');
    expect(invoker.calls).toEqual([]);
  });

  it('reports an invoker failure without its message', async () => {
    const { deps, req, invoker, audit } = setup();
    invoker.failWith = new Error('upstream said: secret detail');
    const result = plain(await callTool(deps, req(alice), 'catalog.search_products', { brand: 'acme', fields: [] }));
    expect(text(result)).toBe('Tool failed.');
    expect(audit.events[1]).toMatchObject({ action: 'tool.call', outcome: 'error', details: { errorCode: 'handler_failed' } });
  });
});

describe('AUTH-7 the invoker never receives the token', () => {
  it('passes only the caller built from verified claims', async () => {
    const { deps, req, invoker } = setup();
    await callTool(deps, req(alice), 'catalog.search_products', { brand: 'acme', fields: [] });
    expect(JSON.stringify(invoker.calls)).not.toContain('do-not-leak-this-token');
  });
});

/** An invoker that answers like the direct read invoker: summary, data and audit details. */
class ReadLikeInvoker implements OperationInvoker {
  readonly calls: InvocationRequest[] = [];
  invoke(request: InvocationRequest): Promise<InvocationResult> {
    this.calls.push(request);
    return Promise.resolve({
      text: `${request.operation.id} returned 1 item(s).`,
      structured: { operation: request.operation.id, items: [{ sku: 'a' }], returned: 1, truncated: false },
      dataText: '{"operation":"x","items":[{"sku":"a"}]}',
      auditDetails: { operation: request.operation.id, connection: 'magento', upstreamStatus: 200, itemCount: 1, upstreamMs: 3 },
    });
  }
}

const OVERRIDE_SOURCES = {
  ...SOURCES,
  'overrides.yaml': `version: 1
overrides:
  - { operation: support.lookup_order, tool_name: support.find_order, title: Find an order }
`,
};
const overridden = await loadConfigurationSources(Object.entries(OVERRIDE_SOURCES).map(([file, text]) => ({ file, text })));
if (!overridden.ok) throw new Error(JSON.stringify(overridden.issues));
const OVERRIDDEN: LoadedConfiguration = overridden.configuration;

function setupWith(config: LoadedConfiguration, invoker: OperationInvoker) {
  const audit = new InMemoryAuditLog();
  let n = 0;
  const deps: PipelineDeps = {
    snapshot: () => snapshotOf(config),
    builtins: [pingTool],
    invokerFor: () => invoker,
    audit,
    newId: () => `00000000-0000-4000-8000-${String(++n).padStart(12, '0')}`,
    now: () => 0,    rateCounter: new InMemoryRateCounter(),
    wallClock: () => new Date(0),
    widgets: WidgetBundles.empty(),
    publicUrl: new URL('https://aiops.example.test'),
  };
  const req = (caller: Caller): PipelineRequest => ({ caller, correlationId: 'corr-1', snapshot: deps.snapshot(), tasks: false });
  return { audit, deps, req };
}

describe('MCP-9 tools are published and called by their tool name', () => {
  it('MCP-9 lists the overridden tool name and title', async () => {
    const { deps, req } = setupWith(OVERRIDDEN, new FakeInvoker());
    const tools = await listTools(deps, req(bob));
    expect(tools.map((t) => t.name)).toEqual(['ping', 'support.find_order']);
    expect(tools[1]?.title).toBe('Find an order');
  });

  it('MCP-9 calls the operation by its tool name; audit subject is the tool name, details.operation the operation ID', async () => {
    const invoker = new FakeInvoker();
    const { deps, req, audit } = setupWith(OVERRIDDEN, invoker);
    const result = plain(await callTool(deps, req(bob), 'support.find_order', { order_number: '100' }));
    expect(text(result)).toBe('ran support.lookup_order');
    expect(invoker.calls[0]?.operation.id).toBe('support.lookup_order');
    expect(audit.events).toEqual([
      expect.objectContaining({ action: 'policy.decision', decision: 'allow', subject: 'support.find_order', details: expect.objectContaining({ operation: 'support.lookup_order' }) as unknown }),
      expect.objectContaining({ action: 'tool.call', outcome: 'ok', subject: 'support.find_order', details: expect.objectContaining({ operation: 'support.lookup_order' }) as unknown }),
    ]);
  });

  it('MCP-9 the operation ID of an overridden operation is not a tool name', async () => {
    const invoker = new FakeInvoker();
    const { deps, req, audit } = setupWith(OVERRIDDEN, invoker);
    await expect(callTool(deps, req(bob), 'support.lookup_order', { order_number: '100' })).rejects.toThrow('Tool support.lookup_order not found');
    expect(audit.events[0]?.details).toMatchObject({ reason: 'unknown_tool' });
    expect(invoker.calls).toEqual([]);
  });

  it('MCP-9 records the operation ID on a policy denial and on invalid arguments', async () => {
    const { deps, req, audit } = setupWith(LOADED, new FakeInvoker());
    await callTool(deps, req(alice), 'catalog.search_products', { brand: 'initech', fields: [] });
    await callTool(deps, req(alice), 'catalog.search_products', { brand: 5, fields: [] });
    expect(audit.events.map((e) => e.details.operation)).toEqual(['catalog.search_products', 'catalog.search_products']);
  });

  it('MCP-9 built-in tools carry no operation in their audit details', async () => {
    const { deps, req, audit } = setupWith(LOADED, new FakeInvoker());
    await callTool(deps, req(bob), 'ping', {});
    expect(audit.events.map((e) => e.details.operation)).toEqual([undefined, undefined]);
  });
});

describe('MCP-4 read results reach the client as summary, data block and structured content', () => {
  it('MCP-4 puts the summary first and the data JSON in a second text block', async () => {
    const { deps, req } = setupWith(LOADED, new ReadLikeInvoker());
    const result = plain(await callTool(deps, req(alice), 'catalog.search_products', { brand: 'acme', fields: ['sku'] }));
    expect(result.content).toEqual([
      { type: 'text', text: 'catalog.search_products returned 1 item(s).' },
      { type: 'text', text: '{"operation":"x","items":[{"sku":"a"}]}' },
    ]);
    expect(result.structuredContent).toEqual({ operation: 'catalog.search_products', items: [{ sku: 'a' }], returned: 1, truncated: false });
  });

  it('AUD-1 merges the invoker audit details into the tool.call event', async () => {
    const { deps, req, audit } = setupWith(LOADED, new ReadLikeInvoker());
    await callTool(deps, req(alice), 'catalog.search_products', { brand: 'acme', fields: ['sku'] });
    expect(audit.events[1]).toMatchObject({
      action: 'tool.call',
      details: { operation: 'catalog.search_products', connection: 'magento', upstreamStatus: 200, itemCount: 1, upstreamMs: 3, durationMs: 0 },
    });
    expect(JSON.stringify(audit.events)).not.toContain('acme');
  });
});

describe('SEC-1 POL-2 the operation runs under the snapshot the decision used', () => {
  it('SEC-1 hands the request snapshot configuration and correlation ID to the invoker factory, not the current one', async () => {
    const invoker = new FakeInvoker();
    const seen: [LoadedConfiguration, string][] = [];
    let current: LoadedConfiguration = LOADED;
    const audit = new InMemoryAuditLog();
    const deps: PipelineDeps = {
      snapshot: () => snapshotOf(current),
      builtins: [pingTool],
      invokerFor: (configuration, correlationId) => {
        seen.push([configuration, correlationId]);
        return invoker;
      },
      audit,
      newId: () => '00000000-0000-4000-8000-000000000001',
      now: () => 0,
      rateCounter: new InMemoryRateCounter(),
      wallClock: () => new Date(0),
      widgets: WidgetBundles.empty(),
      publicUrl: new URL('https://aiops.example.test'),
    };
    const req: PipelineRequest = { caller: alice, correlationId: 'corr-9', snapshot: deps.snapshot(), tasks: false };
    current = OVERRIDDEN; // a reload lands while the request is in flight
    await callTool(deps, req, 'catalog.search_products', { brand: 'acme', fields: ['sku'] });
    expect(seen).toHaveLength(1);
    expect(seen[0]?.[0]).toBe(LOADED);
    expect(seen[0]?.[1]).toBe('corr-9');
  });
});

describe('MCP-7 AUD-1 task answers', () => {
  const task = { taskId: '11111111-1111-4111-8111-111111111111', owner: 'alice-id', changesetId: 'cs-1', kind: 'prepare' as const, tool: 'catalog.search_products', createdAt: new Date('2026-01-01T00:00:00Z'), ttlMs: 604800000 };
  const taskInvoker = (): OperationInvoker & { seen: InvocationRequest[] } => {
    const seen: InvocationRequest[] = [];
    return {
      seen,
      invoke(request: InvocationRequest): Promise<InvocationResult> {
        seen.push(request);
        return Promise.resolve({ text: '', task, auditDetails: { changesetId: 'cs-1' } });
      },
    };
  };
  const call = { brand: 'acme', fields: ['sku'] };

  it('a declaring request passes asTask and gets a CreateTaskResult', async () => {
    const invoker = taskInvoker();
    const { deps, req } = setupWith(LOADED, invoker);
    const answer = await callTool(deps, { ...req(alice), tasks: true }, 'catalog.search_products', call);
    expect(answer).toMatchObject({ resultType: 'task', taskId: task.taskId, status: 'working', ttlMs: 604800000, pollIntervalMs: 2000 });
    expect(invoker.seen[0]?.asTask).toBe(true);
  });

  it('the tool.call event of a task carries changesetId and taskId', async () => {
    const { deps, req, audit } = setupWith(LOADED, taskInvoker());
    await callTool(deps, { ...req(alice), tasks: true }, 'catalog.search_products', call);
    const row = audit.events.find((e) => e.action === 'tool.call');
    expect(row?.outcome).toBe('ok');
    expect(row?.details).toMatchObject({ changesetId: 'cs-1', taskId: task.taskId });
  });

  it('AUD-1 an invoker that reports and then throws keeps the reported change-set ID on the tool.call row', async () => {
    const failing: OperationInvoker = {
      invoke(request: InvocationRequest): Promise<InvocationResult> {
        request.report?.({ changesetId: 'cs-1' });
        return Promise.reject(new Error('task store down'));
      },
    };
    const { deps, req, audit } = setupWith(LOADED, failing);
    const answer = await callTool(deps, { ...req(alice), tasks: true }, 'catalog.search_products', call);
    expect(answer).toMatchObject({ isError: true, content: [{ type: 'text', text: 'Tool failed.' }] });
    const row = audit.events.find((e) => e.action === 'tool.call');
    expect(row?.outcome).toBe('error');
    expect(row?.details).toMatchObject({ changesetId: 'cs-1', operation: 'catalog.search_products', errorCode: 'handler_failed' });
  });

  it('a built-in task answer for a non-declaring request is a tool failure', async () => {
    const rogue: BuiltinTool = {
      name: 'rogue',
      description: 'rogue',
      inputSchema: { type: 'object' },
      validate: () => ({ ok: true }),
      handler: () => Promise.resolve(createTaskResult(task)),
    };
    const { deps, req, audit } = setupWith(LOADED, new FakeInvoker());
    const answer = await callTool({ ...deps, builtins: [rogue] }, req(alice), 'rogue', {});
    expect(answer).toMatchObject({ isError: true, content: [{ type: 'text', text: 'Tool failed.' }] });
    expect(audit.events.find((e) => e.action === 'tool.call')?.details).toMatchObject({ errorCode: 'handler_failed' });
  });

  it('a task for a non-declaring request is a tool failure', async () => {
    const invoker = taskInvoker();
    const { deps, req, audit } = setupWith(LOADED, invoker);
    const answer = await callTool(deps, req(alice), 'catalog.search_products', call);
    expect(answer).toMatchObject({ isError: true, content: [{ type: 'text', text: 'Tool failed.' }] });
    expect(audit.events.find((e) => e.action === 'tool.call')?.details).toMatchObject({ errorCode: 'handler_failed' });
    expect(invoker.seen[0]?.asTask).toBe(false);
  });

  it('built-ins receive tasks and report', async () => {
    const seen: boolean[] = [];
    const probe: BuiltinTool = {
      name: 'probe',
      description: 'probe',
      inputSchema: { type: 'object' },
      validate: () => ({ ok: true }),
      handler(_args, ctx) {
        seen.push(ctx.tasks);
        ctx.report({ taskId: 't' });
        return Promise.resolve({ content: [{ type: 'text', text: 'ok' }] });
      },
    };
    const { deps, req, audit } = setupWith(LOADED, new FakeInvoker());
    await callTool({ ...deps, builtins: [probe] }, { ...req(alice), tasks: true }, 'probe', {});
    expect(seen).toEqual([true]);
    expect(audit.events.find((e) => e.action === 'tool.call')?.details).toMatchObject({ taskId: 't' });
  });
});

const LIMITED_SOURCES = {
  ...SOURCES,
  'roles.yaml': SOURCES['roles.yaml'].replace(
    '  - id: content_manager\n',
    '  - id: content_manager\n    limits: { calls_per_minute: 2 }\n',
  ),
};
const limitedLoaded = await loadConfigurationSources(Object.entries(LIMITED_SOURCES).map(([file, text]) => ({ file, text })));
if (!limitedLoaded.ok) throw new Error(JSON.stringify(limitedLoaded.issues));
const LIMITED: LoadedConfiguration = limitedLoaded.configuration;
const SEARCH = { brand: 'acme', fields: ['sku'] };

function limitedSetup(rateCounter?: RateCounter) {
  const s = setup();
  const config = LIMITED;
  const counter = rateCounter ?? new InMemoryRateCounter();
  const deps: PipelineDeps = { ...s.deps, snapshot: () => snapshotOf(config), rateCounter: counter };
  return { ...s, deps, req: (c: Caller): PipelineRequest => ({ caller: c, correlationId: 'corr-1', snapshot: deps.snapshot(), tasks: false }) };
}

describe('POL-4 calls_per_minute', () => {
  it('the third call in a minute is denied and audited with rule role:<id>/limit:calls_per_minute', async () => {
    const { deps, req, audit, invoker } = limitedSetup();
    await callTool(deps, req(alice), 'catalog.search_products', SEARCH);
    await callTool(deps, req(alice), 'catalog.search_products', SEARCH);
    const third = plain(await callTool(deps, req(alice), 'catalog.search_products', SEARCH));
    expect(invoker.calls).toHaveLength(2);
    expect(third.isError).toBe(true);
    expect(text(third)).toBe('Denied by policy: limit calls_per_minute reached (rule role:content_manager/limit:calls_per_minute)');
    const decisions = audit.events.filter((e) => e.action === 'policy.decision');
    expect(decisions).toHaveLength(3);
    expect(decisions[2]).toMatchObject({ decision: 'deny', details: { rule: 'role:content_manager/limit:calls_per_minute', reason: 'limit_exceeded' } });
    expect(decisions[0]).toMatchObject({ decision: 'allow' });
    expect(decisions[1]).toMatchObject({ decision: 'allow' });
  });

  it('a new UTC minute opens a new bucket', async () => {
    expect(minuteWindow(new Date('2026-11-17T12:00:59.999Z')).getTime()).not.toBe(minuteWindow(new Date('2026-11-17T12:01:00.000Z')).getTime());
    const keys: string[] = [];
    const windows: Date[] = [];
    const counter: RateCounter = {
      hit: (key, windowStart) => {
        keys.push(key);
        windows.push(windowStart);
        return Promise.resolve(1);
      },
    };
    const { deps, req } = limitedSetup(counter);
    await callTool(deps, req(alice), 'catalog.search_products', SEARCH);
    expect(keys).toEqual(['alice-id|content_manager']);
    expect(windows.map((w) => w.toISOString())).toEqual(['2026-11-17T12:00:00.000Z']);
  });

  it('built-ins are not counted', async () => {
    const hits: string[] = [];
    const { deps, req } = limitedSetup({
      hit: (key) => {
        hits.push(key);
        return Promise.resolve(1);
      },
    });
    for (let i = 0; i < 3; i++) await callTool(deps, req(alice), 'ping', {});
    expect(hits).toEqual([]);
  });

  it('a role without calls_per_minute never calls the counter', async () => {
    const hits: string[] = [];
    const { deps, req } = setup();
    const counted: PipelineDeps = { ...deps, rateCounter: {
        hit: (key) => {
          hits.push(key);
          return Promise.resolve(1);
        },
      },
    };
    await callTool(counted, req(alice), 'catalog.search_products', SEARCH);
    expect(hits).toEqual([]);
  });

  it('a failing counter fails closed', async () => {
    const { deps, req, invoker, audit } = limitedSetup({ hit: () => Promise.reject(new Error('db down')) });
    const answer = plain(await callTool(deps, req(alice), 'catalog.search_products', SEARCH));
    expect(answer.isError).toBe(true);
    expect(text(answer)).toBe('Rate limit check unavailable; the call was not completed.');
    expect(invoker.calls).toEqual([]);
    const decisions = audit.events.filter((e) => e.action === 'policy.decision');
    expect(decisions).toHaveLength(1);
    expect(decisions[0]).toMatchObject({
      decision: 'deny',
      details: { rule: 'role:content_manager/limit:calls_per_minute', reason: 'limit_exceeded', detail: 'calls_per_minute_unavailable' },
    });
  });
});

/** `content_manager` lets `lead` decide in the widget; `support_agent` names `auditor`, without the widget (APR-8). */
const WIDGET_SOURCES = {
  ...SOURCES,
  'roles.yaml': `version: 1
roles:
  - id: content_manager
    grants:
      - { operation: catalog.search_products, id: own-brands, scope: { brand: [acme, globex] }, deny_fields: [cost] }
    approval: { required: never, steps: [{ role: lead }], allow_widget: true }
  - id: support_agent
    grants:
      - { operation: support.lookup_order }
    approval: { required: never, steps: [{ role: auditor }] }
  - id: lead
    grants: []
  - id: auditor
    grants: []
role_mapping:
  - { group: content, roles: [content_manager] }
  - { group: support, roles: [support_agent] }
  - { group: leads, roles: [lead] }
  - { group: auditors, roles: [auditor] }
`,
};
const widgetLoaded = await loadConfigurationSources(Object.entries(WIDGET_SOURCES).map(([file, text]) => ({ file, text })));
if (!widgetLoaded.ok) throw new Error(JSON.stringify(widgetLoaded.issues));
const WIDGET: LoadedConfiguration = widgetLoaded.configuration;

function widgetSetup() {
  const { audit, deps, req } = setupWith(WIDGET, new FakeInvoker());
  const repository = new InMemoryChangeSetRepository(audit);
  const executor = new InMemoryExecutor({ repository, writer: new ScriptedWriter(), batchSizeOf: () => 100 });
  const approvals = new ApprovalService({ repository, executor, audit, newId: deps.newId, now: () => new Date(0) });
  const toolDeps: BuiltinToolDeps = {
    repository,
    newId: deps.newId,
    now: () => new Date(0),
    executor,
    tasks: new InMemoryTaskRepository(),
    audit,
    approvals,
    publicUrl: new URL('https://aiops.example.test'),
  };
  return { audit, repository, deps: { ...deps, builtins: [pingTool, decideChangesetTool(toolDeps)] }, req };
}

const dave: Caller = { subject: 'dave-id', clientId: 'aiops-mcp', groups: ['leads'] };
const erin: Caller = { subject: 'erin-id', clientId: 'aiops-mcp', groups: ['auditors'] };
const DECIDE_ARGS = {
  changeset_id: '11111111-1111-4111-8111-111111111111',
  decision: 'approve',
  hash: `sha256:${'a'.repeat(64)}`,
  count: 2,
};

describe('APR-8 MCP-2 decide_changeset visibility', () => {
  it('APR-8 MCP-2 decide_changeset is listed only to holders of a widget step role, with _meta.ui.visibility app', async () => {
    const { deps, req, audit } = widgetSetup();
    const forDave = await listTools(deps, req(dave));
    expect(forDave.map((t) => t.name)).toEqual(['ping', DECIDE_TOOL]);
    expect(forDave[1]).toMatchObject({ _meta: { ui: { visibility: ['app'] } }, annotations: { readOnlyHint: false } });
    expect(forDave[0]).not.toHaveProperty('_meta');
    // A step role of a rule without allow_widget, and the requester role itself, do not see it.
    expect((await listTools(deps, req(erin))).map((t) => t.name)).toEqual(['ping']);
    expect((await listTools(deps, req(alice))).map((t) => t.name)).toEqual(['ping', 'catalog.search_products']);
    expect(audit.events.map((e) => e.details)).toEqual([{ count: 2 }, { count: 1 }, { count: 2 }]);
  });

  it('MCP-2 SEC-11 a call from a caller it is not listed to answers Tool decide_changeset not found and writes the unknown-tool denial', async () => {
    const { deps, req, audit, repository } = widgetSetup();
    const hidden = await callTool(deps, req(alice), DECIDE_TOOL, DECIDE_ARGS).catch((e: unknown) => e);
    const unknown = await callTool(deps, req(alice), 'no_such_tool', DECIDE_ARGS).catch((e: unknown) => e);
    expect(hidden).toBeInstanceOf(ProtocolError);
    expect((hidden as ProtocolError).code).toBe((unknown as ProtocolError).code);
    expect((hidden as ProtocolError).message).toBe('Tool decide_changeset not found');
    expect(audit.events).toEqual([
      expect.objectContaining({
        action: 'policy.decision',
        decision: 'deny',
        subject: DECIDE_TOOL,
        details: { rule: 'default-deny', reason: 'unknown_tool', roles: ['content_manager'] },
      }),
      expect.objectContaining({ action: 'policy.decision', subject: 'no_such_tool', details: expect.objectContaining({ reason: 'unknown_tool' }) as unknown }),
    ]);
    expect(await repository.approvals(DECIDE_ARGS.changeset_id)).toEqual([]);
  });
});
