// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Mandate Authors
import { describe, expect, it } from 'vitest';
import { formatIssue } from './issues.js';
import { loadConfigurationSources, type LoadedConfiguration, type LoadResult } from './load.js';
import { PLACEHOLDER_SCHEMA } from './registry.js';

const PIN = `sha256:${'ab'.repeat(32)}`;
const OTHER_PIN = `sha256:${'cd'.repeat(32)}`;

const TOOLS = `version: 1
connections:
  - id: tools
    adapter: mcp
    mcp_url: http://tools.example.test/mcp
`;
const SHOP = `version: 1
connections:
  - id: shop
    adapter: openapi
    base_url: https://shop.example.test/api
`;
const ECHO = `  - id: tools.echo
    connection: tools
    risk: read
    description: Echo.
    upstream: { tool: echo, pin: ${PIN} }
`;

function load(files: Record<string, string>): Promise<LoadResult> {
  return loadConfigurationSources(Object.entries({ 'tools.yaml': TOOLS, ...files }).map(([file, text]) => ({ file, text })));
}

const operations = (...ops: string[]): string => `version: 1\noperations:\n${ops.join('')}`;

function ok(result: LoadResult): LoadedConfiguration {
  if (!result.ok) throw new Error(result.issues.map(formatIssue).join('\n'));
  return result.configuration;
}

function issuesOf(result: LoadResult): { path: string; message: string }[] {
  if (result.ok) throw new Error('expected issues');
  return result.issues.map(({ path, message }) => ({ path, message }));
}

describe('CONN-1 CFG-2 MCP-backed operations in configuration', () => {
  it('CONN-1 an operation with upstream { tool, pin } binds kind mcp with schemaFromTool', async () => {
    const config = ok(await load({ 'ops.yaml': operations(ECHO) }));
    expect(config.bindings.get('tools.echo')).toEqual({ kind: 'mcp', connection: 'tools', tool: 'echo', pin: PIN, schemaFromTool: true });
    expect(config.policy.operations.find((o) => o.id === 'tools.echo')?.inputSchema).toEqual(PLACEHOLDER_SCHEMA);
    expect(config.validators.has('tools.echo')).toBe(false);
    expect(config.connectionSettings.get('tools')?.kind).toBe('mcp');
    expect(config.pinCheckSeconds.get('tools')).toBe(300);
  });

  it('CONN-1 with input_schema the binding has schemaFromTool false and a validator', async () => {
    const op = `${ECHO}    input_schema: { type: object, properties: { text: { type: string } }, required: [text], additionalProperties: false }\n`;
    const config = ok(await load({ 'ops.yaml': operations(op) }));
    expect(config.bindings.get('tools.echo')).toEqual({ kind: 'mcp', connection: 'tools', tool: 'echo', pin: PIN, schemaFromTool: false });
    const validate = config.validators.get('tools.echo');
    expect(validate?.({ text: 'hi' })).toEqual({ ok: true });
    expect(validate?.({})).toMatchObject({ ok: false });
  });

  it('CFG-2 a bad pin is reported at upstream.pin', async () => {
    const result = await load({ 'ops.yaml': operations(ECHO.replace(PIN, 'sha256:XYZ')) });
    expect(issuesOf(result)).toEqual([{ path: 'operations[0].upstream.pin', message: 'has an invalid format' }]);
  });

  it('CFG-2 tool with method is an unknown key at upstream', async () => {
    const result = await load({ 'ops.yaml': operations(ECHO.replace(`pin: ${PIN} }`, `pin: ${PIN}, method: GET }`)) });
    expect(issuesOf(result)).toEqual([{ path: 'operations[0].upstream', message: 'unknown key: method' }]);
  });

  it('CFG-2 pin with method and path is the tool variant: tool is required, method and path are unknown keys', async () => {
    const result = await load({ 'ops.yaml': operations(ECHO.replace(`tool: echo, pin: ${PIN} }`, `pin: ${PIN}, method: GET, path: /items }`)) });
    expect(issuesOf(result)).toEqual([
      { path: 'operations[0].upstream.tool', message: 'is required' },
      { path: 'operations[0].upstream', message: 'unknown keys: method, path' },
    ]);
  });

  it('CFG-2 a tool name outside MCP_TOOL_NAME is refused at upstream.tool', async () => {
    const result = await load({ 'ops.yaml': operations(ECHO.replace('tool: echo', "tool: 'bad name'")) });
    expect(issuesOf(result)).toEqual([{ path: 'operations[0].upstream.tool', message: 'has an invalid format' }]);
  });

  it('CFG-2 an HTTP upstream on an mcp connection is refused at upstream', async () => {
    const op = `  - id: tools.get
    connection: tools
    risk: read
    description: Get.
    upstream: { method: GET, path: /items }
    input_schema: { type: object }
`;
    const result = await load({ 'ops.yaml': operations(op) });
    expect(issuesOf(result)).toEqual([{ path: 'operations[0].upstream', message: 'an operation of an mcp connection needs upstream: { tool, pin }' }]);
  });

  it('CFG-2 after the HTTP-upstream issue on an mcp connection no HTTP rule runs, and grants still find the operation', async () => {
    const op = `  - id: tools.post
    connection: tools
    risk: read
    description: Post.
    upstream: { method: POST, path: '/items/{id}' }
    input_schema: { type: object }
`;
    const roles = 'version: 1\nroles:\n  - id: viewer\n    grants:\n      - { operation: tools.post }\n';
    const result = await load({ 'ops.yaml': operations(op), 'roles.yaml': roles });
    expect(issuesOf(result)).toEqual([{ path: 'operations[0].upstream', message: 'an operation of an mcp connection needs upstream: { tool, pin }' }]);
  });

  it('CFG-2 { tool, pin } on an openapi connection is refused at upstream.tool', async () => {
    const op = ECHO.replace('id: tools.echo', 'id: shop.echo').replace('connection: tools', 'connection: shop');
    const result = await load({ 'shop.yaml': SHOP, 'ops.yaml': operations(op) });
    expect(issuesOf(result)).toEqual([{ path: 'operations[0].upstream.tool', message: 'is allowed only for operations of an mcp connection' }]);
  });

  it('CFG-2 risk write on an MCP-backed operation is refused at risk', async () => {
    const result = await load({ 'ops.yaml': operations(ECHO.replace('risk: read', 'risk: write')) });
    expect(issuesOf(result)).toEqual([
      {
        path: 'operations[0].risk',
        message: 'write needs a manifest, which MCP-backed operations cannot carry (use read, write_opaque or destructive)',
      },
    ]);
  });

  it('CFG-2 a manifest on an MCP-backed operation is refused at manifest', async () => {
    const op = `${ECHO.replace('risk: read', 'risk: destructive')}    manifest: { id_field: sku, ids_arg: skus, values_arg: values, fields: [name], read_before: { operation: tools.echo, ids_arg: skus }, rollback: { strategy: none } }\n`;
    const result = await load({ 'ops.yaml': operations(op) });
    expect(issuesOf(result)).toEqual([{ path: 'operations[0].manifest', message: 'is not allowed on an MCP-backed operation' }]);
  });

  it('CFG-2 fields_arg on an MCP-backed operation is refused at fields_arg', async () => {
    const result = await load({ 'ops.yaml': operations(`${ECHO}    fields_arg: fields\n`) });
    expect(issuesOf(result)).toEqual([{ path: 'operations[0].fields_arg', message: 'is not allowed on an MCP-backed operation' }]);
  });

  it('CFG-2 a second operation on the same (connection, tool) is refused at upstream.tool', async () => {
    const second = ECHO.replace('id: tools.echo', 'id: tools.echo_again').replace(PIN, OTHER_PIN);
    const result = await load({ 'ops.yaml': operations(ECHO, second) });
    expect(issuesOf(result)).toEqual([
      { path: 'operations[1].upstream.tool', message: 'tool echo of connection tools is already bound by operation tools.echo' },
    ]);
  });

  it('CFG-2 pin_check_seconds is refused on an openapi connection and bounded 10..86400', async () => {
    const onOpenApi = await load({ 'shop.yaml': `${SHOP}    pin_check_seconds: 60\n` });
    expect(issuesOf(onOpenApi)).toEqual([{ path: 'connections[0]', message: 'unknown key: pin_check_seconds' }]);

    const tooSmall = await load({ 'tools.yaml': `${TOOLS}    pin_check_seconds: 9\n` });
    expect(issuesOf(tooSmall)).toEqual([{ path: 'connections[0].pin_check_seconds', message: 'is too short or too small (minimum 10)' }]);
    const tooBig = await load({ 'tools.yaml': `${TOOLS}    pin_check_seconds: 86401\n` });
    expect(issuesOf(tooBig)).toEqual([{ path: 'connections[0].pin_check_seconds', message: 'is too long or too large (maximum 86400)' }]);

    expect(ok(await load({ 'tools.yaml': `${TOOLS}    pin_check_seconds: 10\n` })).pinCheckSeconds.get('tools')).toBe(10);
    const max = ok(await load({ 'tools.yaml': `${TOOLS}    pin_check_seconds: 86400\n`, 'shop.yaml': SHOP }));
    expect(max.pinCheckSeconds.get('tools')).toBe(86400);
    expect(max.pinCheckSeconds.has('shop')).toBe(false);
    expect(max.connectionSettings.get('shop')?.kind).toBe('openapi');
  });

  it('CONN-1 risk write_opaque and destructive load; grant scope on a derived schema is not checked', async () => {
    const opaque = ECHO.replace('id: tools.echo', 'id: tools.send').replace('tool: echo', 'tool: send').replace('risk: read', 'risk: write_opaque');
    const destructive = ECHO.replace('id: tools.echo', 'id: tools.wipe').replace('tool: echo', 'tool: wipe').replace('risk: read', 'risk: destructive');
    const roles = `version: 1
roles:
  - id: viewer
    grants:
      - { operation: tools.echo, scope: { region: [eu] } }
`;
    const config = ok(await load({ 'ops.yaml': operations(ECHO, opaque, destructive), 'roles.yaml': roles }));
    expect(config.bindings.get('tools.send')).toMatchObject({ kind: 'mcp', tool: 'send' });
    expect(config.bindings.get('tools.wipe')).toMatchObject({ kind: 'mcp', tool: 'wipe' });
    expect(config.policy.operations.map((o) => [o.id, o.risk])).toEqual([
      ['tools.echo', 'read'],
      ['tools.send', 'write_opaque'],
      ['tools.wipe', 'destructive'],
    ]);
  });

  it('OPS-2 read_before naming an MCP-backed operation is refused', async () => {
    const write = `  - id: shop.update
    connection: shop
    risk: write
    description: Update.
    upstream: { method: PUT, path: /items }
    input_schema:
      type: object
      properties:
        skus: { type: array, items: { type: string } }
        values: { type: object, properties: { name: { type: string } }, additionalProperties: false }
      required: [skus, values]
    manifest: { id_field: sku, ids_arg: skus, values_arg: values, fields: [name], read_before: { operation: tools.echo, ids_arg: skus }, rollback: { strategy: none } }
`;
    const result = await load({ 'shop.yaml': SHOP, 'ops.yaml': operations(ECHO, write) });
    expect(issuesOf(result)).toContainEqual({ path: 'operations[1].manifest.read_before.operation', message: 'must name an operation of the same connection' });
  });

  it('OPS-1 an override enabled: false lists the MCP-backed operation as disabled with method MCP', async () => {
    const overrides = 'version: 1\noverrides:\n  - { operation: tools.echo, enabled: false }\n';
    const config = ok(await load({ 'ops.yaml': operations(ECHO), 'overrides.yaml': overrides }));
    expect(config.bindings.has('tools.echo')).toBe(false);
    expect(config.policy.operations).toEqual([]);
    expect(config.disabled).toEqual([{ key: 'tools.echo', connection: 'tools', method: 'MCP', path: 'echo', tool: 'echo' }]);
  });
});
