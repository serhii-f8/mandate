// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The AI Operations Layer Authors
import { describe, expect, it } from 'vitest';
import { loadConfigurationSources, type LoadedConfiguration } from '@aiops/config';
import type { McpToolAdapter, ReadAdapter, ReadOutcome } from '@aiops/connector-sdk';
import type { CredentialHandle, CredentialStatus, CredentialVault } from '@aiops/core';
import { performRead, type ReadDeps, type UpstreamCallLog } from './read.js';
import { createUpstreamReader } from './upstream-reader.js';

const PIN = `sha256:${'ab'.repeat(32)}`;

const SOURCES = {
  'connections.yaml': `version: 1
connections:
  - { id: tools, adapter: mcp, mcp_url: http://tools.example.test/mcp, credential_ref: tools-token, auth: { scheme: bearer } }
  - { id: shop, adapter: openapi, base_url: https://shop.example.test/rest }
`,
  'operations.yaml': `version: 1
operations:
  - id: tools.echo
    connection: tools
    risk: read
    description: Echo.
    upstream: { tool: echo, pin: ${PIN} }
    input_schema: { type: object, properties: { text: { type: string } }, required: [text], additionalProperties: false }
  - id: shop.get_product
    connection: shop
    risk: read
    description: One product.
    upstream: { method: GET, path: '/V1/products/{sku}', path_params: { sku: { arg: sku } } }
    input_schema: { type: object, properties: { sku: { type: string } }, required: [sku] }
`,
};

const loaded = await loadConfigurationSources(Object.entries(SOURCES).map(([file, text]) => ({ file, text })));
if (!loaded.ok) throw new Error(JSON.stringify(loaded.issues));
const CONFIG: LoadedConfiguration = loaded.configuration;

class MemoryVault implements CredentialVault {
  readonly rows = new Map<string, { scheme: string; secret: Readonly<Record<string, string>> }>();
  put(input: { ref: string; scheme: string; secret: Readonly<Record<string, string>>; actor: string }): Promise<{ keyVersion: number }> {
    this.rows.set(input.ref, { scheme: input.scheme, secret: input.secret });
    return Promise.resolve({ keyVersion: 1 });
  }
  describe(refs: readonly string[]): Promise<CredentialStatus[]> {
    return Promise.resolve(refs.map((ref) => ({ ref, set: this.rows.has(ref) })));
  }
  handle(ref: string): Promise<CredentialHandle | undefined> {
    const row = this.rows.get(ref);
    if (row === undefined) return Promise.resolve(undefined);
    return Promise.resolve({ ref, scheme: row.scheme, open: () => Promise.resolve(row.secret) });
  }
}

type CallInput = Parameters<McpToolAdapter['callTool']>[0];

/** A read adapter that optionally also calls MCP tools, recording every call. */
class StubAdapter implements ReadAdapter {
  readonly reads: Parameters<ReadAdapter['read']>[0][] = [];
  readonly calls: CallInput[] = [];
  constructor(private readonly outcome: ReadOutcome) {}
  read(input: Parameters<ReadAdapter['read']>[0]): Promise<ReadOutcome> {
    this.reads.push(input);
    return Promise.resolve(this.outcome);
  }
  detectScopes(): ReturnType<ReadAdapter['detectScopes']> {
    return Promise.resolve({ detectable: false, source: 'none', values: [] });
  }
}

class StubMcpAdapter extends StubAdapter {
  callTool(input: CallInput): Promise<ReadOutcome> {
    this.calls.push(input);
    return Promise.resolve(OK);
  }
}

const OK: ReadOutcome = { ok: true, status: 200, durationMs: 4, value: { structured: { text: 'hi' }, text: [], omitted: 0 }, truncated: false };
const ARGS = { text: 'hi', nested: { keep: [1, 2] } };

function setup(adapter: StubAdapter = new StubMcpAdapter(OK)) {
  const lines: UpstreamCallLog[] = [];
  const vault = new MemoryVault();
  const deps: ReadDeps = { configuration: CONFIG, vault, adapter, correlationId: 'corr-m', log: (l) => lines.push(l) };
  return { adapter, lines, vault, deps };
}

describe('CONN-1 MCP reads through performRead', () => {
  it('CONN-1 MCP-4 calls the bound tool with the arguments unchanged, the vault credential and retryable true', async () => {
    const { adapter, vault, deps } = setup();
    await vault.put({ ref: 'tools-token', scheme: 'bearer', secret: { token: 'tok' }, actor: 'admin' });
    const read = await performRead(deps, 'tools.echo', ARGS);
    expect(read).toEqual({ ok: true, outcome: OK, connection: 'tools' });
    expect(adapter.calls).toHaveLength(1);
    const call = adapter.calls[0];
    expect(call?.tool).toBe('echo');
    expect(call?.args).toBe(ARGS);
    expect(call?.retryable).toBe(true);
    expect(call?.connection).toBe(CONFIG.connectionSettings.get('tools'));
    expect(call?.credential).toMatchObject({ ref: 'tools-token', scheme: 'bearer' });
    expect(adapter.reads).toEqual([]);
  });

  it('CONN-1 passes no credential when none is stored', async () => {
    const { adapter, deps } = setup();
    await performRead(deps, 'tools.echo', ARGS);
    expect(adapter.calls[0] !== undefined && 'credential' in adapter.calls[0]).toBe(false);
  });

  it('CONN-1 SEC-3 logs one record with method tools/call and no arguments', async () => {
    const { lines, deps } = setup();
    await performRead(deps, 'tools.echo', ARGS);
    expect(lines).toEqual([{ correlationId: 'corr-m', operation: 'tools.echo', connection: 'tools', method: 'tools/call', status: 200, durationMs: 4 }]);
    expect(JSON.stringify(lines)).not.toContain('hi');
  });

  it('CONN-1 SEC-3 logs a failed call with its code, never the message', async () => {
    const failing: ReadOutcome = { ok: false, code: 'upstream_error', durationMs: 2, message: 'secret-detail' };
    const adapter = new (class extends StubAdapter {
      callTool(): Promise<ReadOutcome> {
        return Promise.resolve(failing);
      }
    })(OK);
    const { lines, deps } = setup(adapter);
    expect(await performRead(deps, 'tools.echo', ARGS)).toEqual({ ok: true, outcome: failing, connection: 'tools' });
    expect(lines).toEqual([{ correlationId: 'corr-m', operation: 'tools.echo', connection: 'tools', method: 'tools/call', durationMs: 2, errorCode: 'upstream_error' }]);
  });

  it('CONN-1 answers not_bound when the adapter cannot call tools', async () => {
    const { adapter, lines, deps } = setup(new StubAdapter(OK));
    expect(await performRead(deps, 'tools.echo', ARGS)).toEqual({ ok: false, code: 'not_bound' });
    expect(adapter.reads).toEqual([]);
    expect(lines).toEqual([]);
  });

  it('CONN-1 SEC-2 answers credential_unusable for an unknown stored scheme, without calling the tool', async () => {
    const { adapter, vault, deps } = setup();
    await vault.put({ ref: 'tools-token', scheme: 'kerberos', secret: { t: 'x' }, actor: 'admin' });
    expect(await performRead(deps, 'tools.echo', ARGS)).toEqual({ ok: false, code: 'credential_unusable', connection: 'tools' });
    expect(adapter.calls).toEqual([]);
  });

  it('CONN-1 CS-1 createUpstreamReader refuses an MCP-backed read with not_readable (manifests cannot read MCP tools)', async () => {
    const { adapter, deps } = setup();
    const reader = createUpstreamReader({ ...deps, correlationId: 'corr-m' });
    expect(await reader.read('tools.echo', { text: 'hi' })).toEqual({ ok: false, code: 'not_readable' });
    expect(adapter.calls).toEqual([]);
    expect(adapter.reads).toEqual([]);
  });

  it('CS-1 the HTTP path is unchanged: reads through adapter.read with method GET', async () => {
    const { adapter, lines, deps } = setup();
    const read = await performRead(deps, 'shop.get_product', { sku: 'a' });
    expect(read).toEqual({ ok: true, outcome: OK, connection: 'shop' });
    expect(adapter.reads).toHaveLength(1);
    expect(adapter.calls).toEqual([]);
    expect(lines).toEqual([{ correlationId: 'corr-m', operation: 'shop.get_product', connection: 'shop', method: 'GET', status: 200, durationMs: 4 }]);
  });
});

describe('OPS-5 code bindings that cannot be served', () => {
  it('OPS-5 answers not_bound for a code binding without a code read operation or adapter, without reading or logging', async () => {
    const configuration: LoadedConfiguration = {
      ...CONFIG,
      bindings: new Map([...CONFIG.bindings, ['shop.get_product', { kind: 'code', connection: 'shop', preset: 'shop', name: 'get_product', response: { maxItems: 100 } }]]),
    };
    const { adapter, lines, deps } = setup(new StubMcpAdapter(OK));
    expect(await performRead({ ...deps, configuration }, 'shop.get_product', { sku: 'a' })).toEqual({ ok: false, code: 'not_bound' });
    expect(adapter.reads).toEqual([]);
    expect(adapter.calls).toEqual([]);
    expect(lines).toEqual([]);
  });
});
