import { ProtocolError } from '@modelcontextprotocol/server';
import { describe, expect, it } from 'vitest';
import type { AuditEventInput, Caller } from '@aiops/core';
import { loadConfigurationSources, type LoadedConfiguration } from '@aiops/config';
import { FakeInvoker, InMemoryAuditLog } from '@aiops/testing';
import { callerFromAuthInfo } from '../auth/caller-from-auth.js';
import { pingTool } from './builtin-tools.js';
import { NoAdapterInvoker } from './no-adapter-invoker.js';
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
    invoker,
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

describe('NoAdapterInvoker', () => {
  it('explains that no adapter can run the operation yet', async () => {
    const config = configuration();
    const invoker = new NoAdapterInvoker(() => config.connections);
    const operation = config.policy.operations[0];
    if (operation === undefined) throw new Error('fixture');
    expect(await invoker.invoke({ operation, args: {}, caller: alice })).toEqual({
      isError: true,
      text: 'Operation catalog.search_products cannot run: no adapter is available for connection magento (adapter openapi).',
    });
  });
});
