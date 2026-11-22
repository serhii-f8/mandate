// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Mandate Authors
import { describe, expect, it } from 'vitest';
import { loadConfigurationSources, type LoadedConfiguration } from '@mandate/config';
import type { CodeAdapter, ReadAdapter, ReadOutcome } from '@mandate/connector-sdk';
import type { CredentialHandle, CredentialStatus, CredentialVault } from '@mandate/core';
import { loadCodeFixture } from '../test/code-fixture.js';
import type { UpstreamCallLog } from './read.js';
import { createUpstreamReader } from './upstream-reader.js';

const SOURCES = {
  'connections.yaml': `version: 1
connections:
  - { id: magento, adapter: openapi, base_url: https://shop.example.test/rest, credential_ref: magento-integration, auth: { scheme: bearer } }
`,
  'operations.yaml': `version: 1
operations:
  - id: catalog.get_products
    connection: magento
    risk: read
    description: Products by SKU.
    upstream: { method: GET, path: /V1/products, query: { skus: { arg: skus, join: ',' }, brand: { arg: brand } }, response: { items: items, total: total_count, fields_from_arg: fields } }
    input_schema:
      type: object
      properties: { skus: { type: array, items: { type: string } }, brand: { type: string }, fields: { type: array, items: { type: string } } }
      required: [skus, fields]
      additionalProperties: false
    fields_arg: fields
  - id: catalog.get_product
    connection: magento
    risk: read
    description: One product.
    upstream: { method: GET, path: '/V1/products/{sku}', path_params: { sku: { arg: sku } } }
    input_schema: { type: object, properties: { sku: { type: string } }, required: [sku] }
  - id: catalog.update_product
    connection: magento
    risk: write_opaque
    description: Update a product.
    upstream: { method: PUT, path: '/V1/products/{sku}', path_params: { sku: { arg: sku } } }
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

class FakeAdapter implements ReadAdapter {
  readonly reads: Parameters<ReadAdapter['read']>[0][] = [];
  constructor(private readonly outcome: ReadOutcome) {}
  read(input: Parameters<ReadAdapter['read']>[0]): Promise<ReadOutcome> {
    this.reads.push(input);
    return Promise.resolve(this.outcome);
  }
  detectScopes(): ReturnType<ReadAdapter['detectScopes']> {
    return Promise.resolve({ detectable: false, source: 'none', values: [] });
  }
}

const ITEMS = [{ sku: 'a', name: 'A' }, { sku: 'b', name: 'B' }];
const OK: ReadOutcome = { ok: true, status: 200, durationMs: 7, items: ITEMS, total: 2, truncated: false };
const ARGS = { skus: ['a', 'b'], brand: 'acme', fields: ['sku', 'name'] };

function setup(outcome: ReadOutcome = OK, configuration: LoadedConfiguration = CONFIG) {
  const adapter = new FakeAdapter(outcome);
  const lines: UpstreamCallLog[] = [];
  const vault = new MemoryVault();
  const reader = createUpstreamReader({ configuration, vault, adapter, correlationId: 'corr-r', log: (l) => lines.push(l) });
  return { adapter, lines, vault, reader };
}

describe('CS-1 upstream reader for preparation', () => {
  it('CS-1 reads a GET read operation through the adapter and returns its items', async () => {
    const { reader, adapter } = setup();
    const page = await reader.read('catalog.get_products', ARGS);
    expect(page).toEqual({ ok: true, items: ITEMS, total: 2, truncated: false });
    expect(adapter.reads).toHaveLength(1);
    const binding = CONFIG.bindings.get('catalog.get_products');
    if (binding?.kind !== 'http') throw new Error('fixture has no HTTP binding');
    expect(adapter.reads[0]?.mapping).toBe(binding.mapping);
    expect(adapter.reads[0]?.args).toEqual(ARGS);
  });

  it('CS-2 asks the adapter for exact values so before values are never clipped', async () => {
    const { reader, adapter } = setup();
    await reader.read('catalog.get_products', ARGS);
    expect(adapter.reads[0]?.exactValues).toBe(true);
  });

  it('CS-1 refuses an operation that is not a read, without calling the upstream', async () => {
    const { reader, adapter } = setup();
    expect(await reader.read('catalog.update_product', { sku: 'a' })).toEqual({ ok: false, code: 'not_readable' });
    expect(await reader.read('catalog.unknown', {})).toEqual({ ok: false, code: 'not_readable' });
    expect(adapter.reads).toEqual([]);
  });

  it('CS-1 refuses a read operation whose binding is not GET, without calling the upstream', async () => {
    const binding = CONFIG.bindings.get('catalog.get_products');
    if (binding?.kind !== 'http') throw new Error('fixture has no HTTP binding');
    const bindings = new Map(CONFIG.bindings);
    bindings.set('catalog.get_products', { ...binding, mapping: { ...binding.mapping, method: 'POST' } });
    const { reader, adapter } = setup(OK, { ...CONFIG, bindings });
    expect(await reader.read('catalog.get_products', ARGS)).toEqual({ ok: false, code: 'not_readable' });
    expect(adapter.reads).toEqual([]);
  });

  it('CS-1 refuses arguments the read operation validator rejects, without calling the upstream', async () => {
    const { reader, adapter } = setup();
    expect(await reader.read('catalog.get_products', { ...ARGS, extra: 1 })).toEqual({ ok: false, code: 'invalid_read_arguments' });
    expect(await reader.read('catalog.get_products', { brand: 'acme' })).toEqual({ ok: false, code: 'invalid_read_arguments' });
    expect(adapter.reads).toEqual([]);
  });

  it('CS-1 SEC-3 logs one line per call with method GET and no data', async () => {
    const { reader, lines } = setup();
    await reader.read('catalog.get_products', ARGS);
    expect(lines).toEqual([{ correlationId: 'corr-r', operation: 'catalog.get_products', connection: 'magento', method: 'GET', status: 200, durationMs: 7 }]);
  });

  it('CS-1 maps a single-object response to one item and an absent value to none', async () => {
    const single = setup({ ok: true, status: 200, durationMs: 1, value: { sku: 'a' }, truncated: false });
    expect(await single.reader.read('catalog.get_product', { sku: 'a' })).toEqual({ ok: true, items: [{ sku: 'a' }], truncated: false });
    const empty = setup({ ok: true, status: 200, durationMs: 1, truncated: false });
    expect(await empty.reader.read('catalog.get_product', { sku: 'a' })).toEqual({ ok: true, items: [], truncated: false });
  });

  it('CS-1 passes truncation through so preparation can refuse an incomplete read', async () => {
    const { reader } = setup({ ...OK, truncated: true });
    expect(await reader.read('catalog.get_products', ARGS)).toMatchObject({ ok: true, truncated: true });
  });

  it('CS-1 SEC-3 maps a failure to its code and status, never the message', async () => {
    const { reader, lines } = setup({ ok: false, code: 'http_status', status: 500, durationMs: 3, message: 'secret-detail' });
    const page = await reader.read('catalog.get_products', ARGS);
    expect(page).toEqual({ ok: false, code: 'http_status', status: 500 });
    expect(lines[0]).toEqual({ correlationId: 'corr-r', operation: 'catalog.get_products', connection: 'magento', method: 'GET', status: 500, durationMs: 3, errorCode: 'http_status' });
    expect(JSON.stringify([page, lines])).not.toContain('secret-detail');
  });

  it('SEC-2 hands the connection credential to the adapter and refuses an unusable one', async () => {
    const { reader, adapter, vault } = setup();
    await vault.put({ ref: 'magento-integration', scheme: 'bearer', secret: { token: 'tok' }, actor: 'admin' });
    await reader.read('catalog.get_products', ARGS);
    expect(adapter.reads[0]?.credential).toMatchObject({ ref: 'magento-integration', scheme: 'bearer' });
    await vault.put({ ref: 'magento-integration', scheme: 'kerberos', secret: { t: 'x' }, actor: 'admin' });
    expect(await reader.read('catalog.get_products', ARGS)).toEqual({ ok: false, code: 'credential_unusable' });
    expect(adapter.reads).toHaveLength(1);
  });

  it('OPS-5 CS-1 a code read serves read_before with exact values; a code operation of another kind is not readable', async () => {
    const configuration = await loadCodeFixture();
    const items = [{ id: '1', title: 'One' }];
    const codeReads: Parameters<CodeAdapter['codeRead']>[0][] = [];
    const adapter = new FakeAdapter(OK);
    const codeRead: CodeAdapter['codeRead'] = (input) => {
      codeReads.push(input);
      return Promise.resolve({ ok: true, status: 200, durationMs: 6, items, truncated: false });
    };
    const lines: UpstreamCallLog[] = [];
    const vault = new MemoryVault();
    await vault.put({ ref: 'items-token', scheme: 'bearer', secret: { token: 'tok' }, actor: 'admin' });
    const reader = createUpstreamReader({ configuration, vault, adapter: Object.assign(adapter, { codeRead }), correlationId: 'corr-r', log: (l) => lines.push(l) });
    const args = { ids: ['1'], fields: ['id', 'title'] };

    expect(await reader.read('fixture.get_many', args)).toEqual({ ok: true, items, truncated: false });
    const binding = configuration.bindings.get('fixture.get_many');
    if (binding?.kind !== 'code') throw new Error('fixture.get_many has no code binding');
    const [input] = codeReads;
    expect(input?.name).toBe(binding.name);
    expect(input?.operation).toBe(configuration.codeOperations.get('fixture.get_many'));
    expect(input?.response).toBe(binding.response);
    expect(input?.args).toEqual(args);
    expect(input?.exactValues).toBe(true);
    expect(input?.connection).toBe(configuration.connectionSettings.get('items'));
    expect(input?.credential).toMatchObject({ ref: 'items-token', scheme: 'bearer' });
    expect(adapter.reads).toEqual([]);
    expect(lines).toEqual([{ correlationId: 'corr-r', operation: 'fixture.get_many', connection: 'items', method: 'CODE', status: 200, durationMs: 6 }]);

    // A read operation whose module operation is a write is not readable: nothing runs.
    const setTags = configuration.codeOperations.get('fixture.set_tags');
    if (setTags === undefined) throw new Error('fixture.set_tags has no code operation');
    const tampered = { ...configuration, codeOperations: new Map([...configuration.codeOperations, ['fixture.get_many', setTags]]) };
    const tamperedReader = createUpstreamReader({ configuration: tampered, vault, adapter, correlationId: 'corr-r' });
    expect(await tamperedReader.read('fixture.get_many', args)).toEqual({ ok: false, code: 'not_readable' });
    // An adapter without code reads cannot serve the binding.
    const plain = setup(OK, configuration);
    expect(await plain.reader.read('fixture.get_many', args)).toEqual({ ok: false, code: 'not_bound' });
    expect(codeReads).toHaveLength(1);
    expect(plain.adapter.reads).toEqual([]);
  });
});
