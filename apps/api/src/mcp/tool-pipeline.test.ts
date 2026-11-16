import { ProtocolError } from '@modelcontextprotocol/server';
import { describe, expect, it } from 'vitest';
import type { AuditEventInput, Caller, InvocationRequest, InvocationResult, OperationInvoker } from '@aiops/core';
import { loadConfigurationSources, type LoadedConfiguration } from '@aiops/config';
import { FakeInvoker, InMemoryAuditLog } from '@aiops/testing';
import { callerFromAuthInfo } from '../auth/caller-from-auth.js';
import { pingTool } from './builtin-tools.js';
import { callTool, listTools, snapshotOf, type PipelineDeps, type PipelineRequest } from './tool-pipeline.js';

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
    upstream: { method: GET, path: /V1/products }
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
  };
  const req = (caller: Caller): PipelineRequest => ({ caller, correlationId: 'corr-1', snapshot: deps.snapshot() });
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
    const result = await callTool(deps, req(alice), 'catalog.search_products', { brand: 5, fields: [] });
    expect(result.isError).toBe(true);
    expect(text(result)).toMatch(/^Input validation error: Invalid arguments for tool catalog\.search_products: /);
    expect(actions(audit.events)).toEqual(['tool.call:error']);
    expect(audit.events[0]?.details).toMatchObject({ errorCode: 'invalid_arguments' });
    expect(invoker.calls).toEqual([]);
  });

  it('treats missing arguments as an empty object', async () => {
    const { deps, req } = setup();
    expect(text(await callTool(deps, req(alice), 'catalog.search_products', undefined))).toMatch(/brand/);
  });
});

describe('POL-8 every decision is audited with its rule', () => {
  it('records the allow, runs the operation, then records the call', async () => {
    const { deps, req, audit, invoker } = setup();
    const result = await callTool(deps, req(alice), 'catalog.search_products', { brand: 'acme', fields: ['name'] });
    expect(result.isError).not.toBe(true);
    expect(text(result)).toBe('ran catalog.search_products');
    expect(actions(audit.events)).toEqual(['policy.decision:allow', 'tool.call:ok']);
    expect(audit.events[0]?.details).toMatchObject({ rule: 'role:content_manager/grant:own-brands' });
    expect(invoker.calls).toHaveLength(1);
    expect(invoker.calls[0]).toMatchObject({ operation: { id: 'catalog.search_products' }, args: { brand: 'acme', fields: ['name'] }, caller: { subject: 'alice-id' } });
  });

  it('denies an out-of-scope call with the matching rule', async () => {
    const { deps, req, audit, invoker } = setup();
    const result = await callTool(deps, req(alice), 'catalog.search_products', { brand: 'initech', fields: [] });
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
    expect(text(await callTool(deps, req(alice), 'catalog.search_products', { brand: 'acme', fields: ['cost'] }))).toBe(
      "Denied by policy: field 'cost' is denied (rule role:content_manager/grant:own-brands/deny_fields)",
    );
  });

  it('records built-in tools under the builtin rule', async () => {
    const { deps, req, audit } = setup();
    expect(text(await callTool(deps, req(bob), 'ping', { message: 'hi' }))).toBe('pong: hi');
    expect(actions(audit.events)).toEqual(['policy.decision:allow', 'tool.call:ok']);
    expect(audit.events[0]?.details).toMatchObject({ rule: 'builtin' });
  });
});

describe('SEC-1 nothing runs without an allow decision on record', () => {
  it('does not run when the decision cannot be audited', async () => {
    const { deps, req, audit, invoker } = setup();
    audit.failNext = new Error('database down');
    const result = await callTool(deps, req(alice), 'catalog.search_products', { brand: 'acme', fields: [] });
    expect(text(result)).toBe('Audit unavailable; the call was not completed.');
    expect(invoker.calls).toEqual([]);
  });

  it('reports an invoker failure without its message', async () => {
    const { deps, req, invoker, audit } = setup();
    invoker.failWith = new Error('upstream said: secret detail');
    const result = await callTool(deps, req(alice), 'catalog.search_products', { brand: 'acme', fields: [] });
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
    now: () => 0,
  };
  const req = (caller: Caller): PipelineRequest => ({ caller, correlationId: 'corr-1', snapshot: deps.snapshot() });
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
    const result = await callTool(deps, req(bob), 'support.find_order', { order_number: '100' });
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
    const result = await callTool(deps, req(alice), 'catalog.search_products', { brand: 'acme', fields: ['sku'] });
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
    };
    const req: PipelineRequest = { caller: alice, correlationId: 'corr-9', snapshot: deps.snapshot() };
    current = OVERRIDDEN; // a reload lands while the request is in flight
    await callTool(deps, req, 'catalog.search_products', { brand: 'acme', fields: ['sku'] });
    expect(seen).toHaveLength(1);
    expect(seen[0]?.[0]).toBe(LOADED);
    expect(seen[0]?.[1]).toBe('corr-9');
  });
});
