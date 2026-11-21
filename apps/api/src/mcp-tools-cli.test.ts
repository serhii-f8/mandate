// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The AI Operations Layer Authors
import { describe, expect, it } from 'vitest';
import { createOpenApiAdapter } from '@aiops/adapters';
import { loadConfigurationFiles, OPERATION_ID, revisionSummary } from '@aiops/config';
import { mcpToolHash, type McpToolAdapter, type McpToolDefinition, type ToolListOutcome } from '@aiops/connector-sdk';
import type { CredentialHandle, CredentialStatus, CredentialVault } from '@aiops/core';
import { FakeResolver, InMemoryAuditLog, InMemoryConfigRevisionStore } from '@aiops/testing';
import { runApiCli, type CliAdapter, type CliDeps, type CliStore } from './cli.js';
import { skeletonOperationId } from './mcp-tools-cli.js';

const TOKEN = 'unit-only-mcp-token-0123456789';
const ENV = { DATABASE_URL: 'postgres://u:p@h/db', AIOPS_MASTER_KEYS: 'unit-only-keys' };
const REVIEW_LINE = '# Upstream definition, for operator review only (SEC-6); not shown to clients';

const LOOKUP: McpToolDefinition = {
  name: 'lookup',
  title: 'Lookup',
  description: 'Look up a record.',
  inputSchema: { type: 'object', properties: { key: { type: 'string' } } },
  annotations: { readOnlyHint: true },
};
const ECHO_REVIEWED: McpToolDefinition = { name: 'echo', inputSchema: { type: 'object' } };
const ECHO_NOW: McpToolDefinition = { name: 'echo', description: 'Echo, now different.', inputSchema: { type: 'object' } };
const TINY: McpToolDefinition = {
  name: 'getTinyImage',
  description: 'Returns a tiny image.',
  inputSchema: { type: 'object' },
  outputSchema: { type: 'object', properties: { url: { type: 'string' } } },
};
const OTHER: McpToolDefinition = { name: 'other', inputSchema: { type: 'object' } };

const SOURCES = {
  'connections.yaml': `version: 1
connections:
  - id: tools
    adapter: mcp
    mcp_url: https://tools.example.test/mcp
    credential_ref: tools-token
    auth: { scheme: bearer }
  - { id: shop, adapter: openapi, base_url: https://shop.example.test/api }
`,
  'operations.yaml': `version: 1
operations:
  - id: tools.lookup
    connection: tools
    risk: read
    description: Look up a record by key.
    upstream: { tool: lookup, pin: ${mcpToolHash(LOOKUP)} }
  - id: tools.echo
    connection: tools
    risk: read
    description: Echo the input.
    upstream: { tool: echo, pin: ${mcpToolHash(ECHO_REVIEWED)} }
  - id: shop.list_items
    connection: shop
    risk: read
    description: List items.
    upstream: { method: GET, path: /items }
    input_schema: { type: object, additionalProperties: false }
`,
};

const listed = (dropped: number, ...tools: McpToolDefinition[]): ToolListOutcome => ({
  ok: true,
  tools: tools.map((definition) => ({ definition, hash: mcpToolHash(definition) })),
  dropped,
  durationMs: 3,
});
const LIVE = listed(1, OTHER, LOOKUP, TINY, ECHO_NOW);

class MemoryVault implements CredentialVault {
  put(): Promise<{ keyVersion: number }> {
    return Promise.resolve({ keyVersion: 1 });
  }
  describe(refs: readonly string[]): Promise<CredentialStatus[]> {
    return Promise.resolve(refs.map((ref) => ({ ref, set: ref === 'tools-token' })));
  }
  handle(ref: string): Promise<CredentialHandle | undefined> {
    if (ref !== 'tools-token') return Promise.resolve(undefined);
    return Promise.resolve({ ref, scheme: 'bearer', open: () => Promise.resolve({ token: TOKEN }) });
  }
}

interface Run {
  readonly code: number;
  readonly lines: readonly string[];
  readonly lists: Parameters<McpToolAdapter['listTools']>[0][];
  readonly secrets: readonly (Readonly<Record<string, string>> | undefined)[];
}

async function run(argv: readonly string[], list: ToolListOutcome = LIVE, env: Record<string, string> = ENV): Promise<Run> {
  const lists: Parameters<McpToolAdapter['listTools']>[0][] = [];
  const secrets: (Readonly<Record<string, string>> | undefined)[] = [];
  const adapter: CliAdapter = {
    ...createOpenApiAdapter(),
    // The load-time list (R10): an upstream the CLI cannot reach without the credential.
    resolver: new FakeResolver({}, {}, { tools: { ok: false, code: 'credential_missing', durationMs: 0, message: 'no credential' } }),
    listTools: async (input) => {
      lists.push(input);
      secrets.push(await input.credential?.open());
      return list;
    },
  };
  const loaded = await loadConfigurationFiles(SOURCES, { resolver: adapter.resolver });
  if (!loaded.ok) throw new Error(JSON.stringify(loaded.issues));
  const store = new InMemoryConfigRevisionStore(new InMemoryAuditLog());
  await store.bootstrap({ id: '00000000-0000-4000-8000-000000000001', hash: loaded.configuration.hash, files: SOURCES, summary: revisionSummary(loaded.configuration) });
  const cliStore: CliStore = {
    vault: new MemoryVault(),
    audit: new InMemoryAuditLog(),
    rotate: () => Promise.reject(new Error('not used')),
    close: () => Promise.resolve(),
  };
  const deps: CliDeps = {
    env,
    adapter,
    openConfigStore: () => Promise.resolve({ store, close: () => Promise.resolve() }),
    openStore: () => Promise.resolve(cliStore),
    defaultPresetDir: null,
  };
  const lines: string[] = [];
  const code = await runApiCli(argv, (line) => lines.push(line), deps);
  return { code, lines, lists, secrets };
}

describe('CONN-4 SEC-6 aiops mcp tools', () => {
  it('CONN-4 lists every tool sorted by name with its hash, bound operation and pin state, then the counts', async () => {
    const result = await run(['mcp', 'tools', 'tools']);
    expect(result.lines).toEqual([
      `echo ${mcpToolHash(ECHO_NOW)} tools.echo changed`,
      `getTinyImage ${mcpToolHash(TINY)} - unreferenced`,
      `lookup ${mcpToolHash(LOOKUP)} tools.lookup ok`,
      `other ${mcpToolHash(OTHER)} - unreferenced`,
      'listed 4 tools (dropped 1)',
    ]);
    expect(result.code).toBe(0);
  });

  it('CONN-1 SEC-2 lists live with the stored credential of the connection', async () => {
    const result = await run(['mcp', 'tools', 'tools']);
    expect(result.lists).toHaveLength(1);
    expect(result.lists[0]?.connection.id).toBe('tools');
    expect(result.lists[0]?.credential).toMatchObject({ ref: 'tools-token', scheme: 'bearer' });
    expect(result.secrets).toEqual([{ token: TOKEN }]);
  });

  it('CONN-4 SEC-6 --show prints the upstream definition under the review line, then a skeleton pinned to the live hash', async () => {
    const result = await run(['mcp', 'tools', 'tools', '--show', 'getTinyImage']);
    expect(result.code).toBe(0);
    expect(result.lines[0]).toBe(REVIEW_LINE);
    const skeleton = [
      'operations:',
      '  - id: tools.gettinyimage',
      '    connection: tools',
      '    risk: read',
      '    description: <write your own description>',
      `    upstream: { tool: getTinyImage, pin: ${mcpToolHash(TINY)} }`,
    ];
    expect(result.lines.slice(-skeleton.length)).toEqual(skeleton);
    const json = result.lines.slice(1, -skeleton.length).join('\n');
    expect(JSON.parse(json)).toEqual({
      name: 'getTinyImage',
      title: null,
      description: 'Returns a tiny image.',
      inputSchema: { type: 'object' },
      outputSchema: { type: 'object', properties: { url: { type: 'string' } } },
      annotations: null,
    });
  });

  it('SEC-6 --show escapes terminal control characters of upstream text', async () => {
    const hostile: McpToolDefinition = { name: 'evil', description: 'a\u001b[2Jb\u009bc\u202ed', inputSchema: { type: 'object' } };
    const result = await run(['mcp', 'tools', 'tools', '--show', 'evil'], listed(0, hostile));
    expect(result.code).toBe(0);
    const text = result.lines.join('\n');
    const unsafe = (c: number): boolean => (c < 0x20 && c !== 0x0a) || (c >= 0x7f && c <= 0x9f) || c === 0x2028 || c === 0x2029 || (c >= 0x202a && c <= 0x202e) || (c >= 0x2066 && c <= 0x2069);
    expect(Array.from({ length: text.length }, (_, i) => text.charCodeAt(i)).filter(unsafe)).toEqual([]);
    expect(text).toContain('"description": "a\\u001b[2Jb\\u009bc\\u202ed"');
  });

  it('CONN-4 the skeleton quotes a tool name YAML would not read back as the same string', async () => {
    for (const [name, shown] of [['123', '"123"'], ['true', '"true"'], ['Null', '"Null"'], ['.inf', '".inf"'], ['-x', '"-x"'], ['a.b/c-d', 'a.b/c-d']] as const) {
      const tool: McpToolDefinition = { name, inputSchema: { type: 'object' } };
      const result = await run(['mcp', 'tools', 'tools', '--show', name], listed(0, tool));
      expect(result.lines.at(-1)).toBe(`    upstream: { tool: ${shown}, pin: ${mcpToolHash(tool)} }`);
    }
  });

  it('CONN-4 --show of a tool the upstream does not list exits 1', async () => {
    const result = await run(['mcp', 'tools', 'tools', '--show', 'absent']);
    expect(result.lines).toEqual(['tool absent is not listed by connection tools']);
    expect(result.code).toBe(1);
  });

  it('CONN-4 a failed list prints the code only and exits 1; no output contains the credential (SEC-3)', async () => {
    const failed: ToolListOutcome = { ok: false, code: 'http_status', status: 401, durationMs: 2, message: `rejected bearer ${TOKEN}` };
    const result = await run(['mcp', 'tools', 'tools'], failed);
    expect(result.lines).toEqual(['tools/list failed: http_status']);
    expect(result.code).toBe(1);
  });

  it('SEC-3 no output line of a list or a show contains the credential', async () => {
    const leaky = listed(0, { name: 'lookup', description: 'harmless', inputSchema: { type: 'object' } });
    for (const argv of [['mcp', 'tools', 'tools'], ['mcp', 'tools', 'tools', '--show', 'lookup']]) {
      const result = await run(argv, leaky);
      expect(result.secrets).toEqual([{ token: TOKEN }]);
      for (const line of result.lines) expect(line).not.toContain(TOKEN);
    }
  });

  it('CONN-4 an invalid tool list (duplicate names) is a failed list', async () => {
    const result = await run(['mcp', 'tools', 'tools'], listed(0, OTHER, OTHER));
    expect(result.lines).toEqual(['tools/list failed: invalid_response']);
    expect(result.code).toBe(1);
  });

  it('CONN-4 exits 2 for an openapi connection, an unknown connection, a missing environment and bad usage, without listing', async () => {
    const openapi = await run(['mcp', 'tools', 'shop']);
    expect(openapi.lines).toEqual(['connection shop is not an mcp connection']);
    expect(openapi.code).toBe(2);
    const unknown = await run(['mcp', 'tools', 'nope']);
    expect(unknown.lines).toEqual(['connection nope is not defined in the active revision']);
    expect(unknown.code).toBe(2);
    const noKeys = await run(['mcp', 'tools', 'tools'], LIVE, { DATABASE_URL: ENV.DATABASE_URL });
    expect(noKeys.lines).toEqual(['Invalid environment: AIOPS_MASTER_KEYS: is required']);
    expect(noKeys.code).toBe(2);
    for (const argv of [
      ['mcp', 'tools'],
      ['mcp', 'tools', 'tools', 'extra'],
      ['mcp', 'tools', 'tools', '--show'],
      ['mcp', 'tools', 'tools', '--show', 'a b'],
      ['mcp', 'tools', 'Bad Id'],
      ['mcp', 'tools', 'tools', '--show', 'lookup', '--show', 'echo'],
    ]) {
      const usage = await run(argv);
      expect(usage.lines[0]).toMatch(/^usage: aiops /);
      expect(usage.lines.join('\n')).toContain('aiops mcp tools <connection> [--show <tool>]');
      expect(usage.code).toBe(2);
    }
    for (const r of [openapi, unknown, noKeys]) expect(r.lists).toEqual([]);
  });
});

describe('CONN-4 skeleton operation IDs (ruling F17)', () => {
  it('CONN-4 lower-cases, replaces characters outside [a-z0-9_], prefixes t_ and truncates to 64', () => {
    expect(skeletonOperationId('tools', 'getTinyImage')).toBe('tools.gettinyimage');
    expect(skeletonOperationId('tools', 'a/b.c-d')).toBe('tools.a_b_c_d');
    expect(skeletonOperationId('tools', '1st')).toBe('tools.t_1st');
    expect(skeletonOperationId('tools', '_x')).toBe('tools.t__x');
    expect(skeletonOperationId('my-tools', 'x')).toBe('my_tools.x');
    const long = skeletonOperationId('tools', 'a'.repeat(128));
    expect(long).toHaveLength(64);
    for (const id of ['tools.gettinyimage', 'tools.a_b_c_d', 'tools.t_1st', 'my_tools.x', long]) expect(id).toMatch(OPERATION_ID);
  });
});
