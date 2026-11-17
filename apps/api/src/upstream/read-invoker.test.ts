import { describe, expect, it } from 'vitest';
import { createOpenApiAdapter } from '@aiops/adapters';
import { loadConfigurationSources, type LoadedConfiguration } from '@aiops/config';
import type { ReadAdapter, ReadOutcome } from '@aiops/connector-sdk';
import { READ_RESULT_TEXT, type Caller, type CredentialHandle, type CredentialStatus, type CredentialVault, type OperationDefinition } from '@aiops/core';
import { DirectReadInvoker, directReadInvokers, WRITE_NEEDS_CHANGESET, type UpstreamCallLog } from './read-invoker.js';

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
    upstream:
      method: GET
      path: /V1/products
      query: { brand: { arg: brand } }
      response: { items: items, total: total_count, fields_from_arg: fields }
    input_schema:
      type: object
      properties: { brand: { type: string }, fields: { type: array, items: { type: string } } }
      required: [brand, fields]
      additionalProperties: false
    fields_arg: fields
  - id: catalog.update_product
    connection: magento
    risk: write
    description: Update a product.
    upstream: { method: PUT, path: '/V1/products/{sku}', path_params: { sku: { arg: sku } } }
    input_schema: { type: object, properties: { sku: { type: string } }, required: [sku] }
`,
};

const loaded = await loadConfigurationSources(Object.entries(SOURCES).map(([file, text]) => ({ file, text })));
if (!loaded.ok) throw new Error(JSON.stringify(loaded.issues));
const CONFIG: LoadedConfiguration = loaded.configuration;

function op(id: string): OperationDefinition {
  const found = CONFIG.policy.operations.find((o) => o.id === id);
  if (found === undefined) throw new Error(`fixture has no ${id}`);
  return found;
}

const caller: Caller = { subject: 'alice-id', clientId: 'aiops-mcp', groups: ['content'] };
const ARGS = { brand: 'acme', fields: ['sku'] };

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

const OK: ReadOutcome = { ok: true, status: 200, durationMs: 12, items: [{ sku: 'a' }, { sku: 'b' }], total: 7, truncated: false };

function setup(outcome: ReadOutcome = OK) {
  const vault = new MemoryVault();
  const adapter = new FakeAdapter(outcome);
  const invoker = new DirectReadInvoker({ configuration: CONFIG, vault, adapter });
  return { vault, adapter, invoker };
}

describe('MCP-4 direct read invoker', () => {
  it('MCP-4 refuses a non-read operation without calling the upstream', async () => {
    const { invoker, adapter } = setup();
    const result = await invoker.invoke({ operation: op('catalog.update_product'), args: { sku: 'x' }, caller });
    expect(result.isError).toBe(true);
    expect(result.text).toBe(`catalog.update_product cannot run: ${WRITE_NEEDS_CHANGESET}.`);
    expect(WRITE_NEEDS_CHANGESET).toBe('write operations need change-sets, which arrive in Phase 4');
    expect(result.auditDetails).toEqual({ operation: 'catalog.update_product', connection: 'magento', errorCode: 'write_not_supported' });
    expect(adapter.reads).toEqual([]);
  });

  it('POL-5 refuses a read operation bound to a non-GET call without calling the upstream (defence in depth)', async () => {
    const binding = CONFIG.bindings.get('catalog.search_products');
    if (binding === undefined) throw new Error('fixture has no binding');
    const bindings = new Map(CONFIG.bindings);
    bindings.set('catalog.search_products', { ...binding, mapping: { ...binding.mapping, method: 'POST' } });
    const adapter = new FakeAdapter(OK);
    const invoker = new DirectReadInvoker({ configuration: { ...CONFIG, bindings }, vault: new MemoryVault(), adapter });
    const result = await invoker.invoke({ operation: op('catalog.search_products'), args: ARGS, caller });
    expect(result.isError).toBe(true);
    expect(result.text).toBe(`catalog.search_products cannot run: ${WRITE_NEEDS_CHANGESET}.`);
    expect(result.auditDetails).toEqual({ operation: 'catalog.search_products', connection: 'magento', errorCode: 'write_not_supported' });
    expect(adapter.reads).toEqual([]);
  });

  it('MCP-4 passes the binding, the connection settings and the validated arguments to the adapter', async () => {
    const { invoker, adapter } = setup();
    await invoker.invoke({ operation: op('catalog.search_products'), args: ARGS, caller });
    expect(adapter.reads).toHaveLength(1);
    const [read] = adapter.reads;
    expect(read?.connection).toBe(CONFIG.connectionSettings.get('magento'));
    expect(read?.mapping).toBe(CONFIG.bindings.get('catalog.search_products')?.mapping);
    expect(read?.args).toEqual(ARGS);
    expect(read?.credential).toBeUndefined();
  });

  it('MCP-4 SEC-5 turns a successful read into summary, structured data and JSON text', async () => {
    const { invoker } = setup();
    const result = await invoker.invoke({ operation: op('catalog.search_products'), args: ARGS, caller });
    expect(result.isError).toBeUndefined();
    expect(result.text).toBe(`catalog.search_products returned 2 item(s) (total 7). ${READ_RESULT_TEXT.dataNote}`);
    expect(result.structured).toEqual({ operation: 'catalog.search_products', items: [{ sku: 'a' }, { sku: 'b' }], returned: 2, total: 7, truncated: false });
    expect(JSON.parse(result.dataText ?? '')).toEqual(result.structured);
  });

  it('AUD-1 sets the audit details of a successful read, without argument values', async () => {
    const { invoker } = setup();
    const result = await invoker.invoke({ operation: op('catalog.search_products'), args: ARGS, caller });
    expect(result.auditDetails).toEqual({ operation: 'catalog.search_products', connection: 'magento', upstreamStatus: 200, itemCount: 2, upstreamMs: 12 });
    expect(JSON.stringify(result.auditDetails)).not.toContain('acme');
  });

  it('AUD-1 SEC-3 maps a failed read to its fixed text and records the code, never the message', async () => {
    const { invoker } = setup({ ok: false, code: 'http_status', status: 500, durationMs: 4, message: 'upstream said secret-detail' });
    const result = await invoker.invoke({ operation: op('catalog.search_products'), args: ARGS, caller });
    expect(result).toEqual({
      isError: true,
      text: READ_RESULT_TEXT.httpStatus('catalog.search_products', 500),
      auditDetails: { operation: 'catalog.search_products', connection: 'magento', upstreamStatus: 500, upstreamMs: 4, errorCode: 'http_status' },
    });
    expect(JSON.stringify(result)).not.toContain('secret-detail');
  });

  it('SEC-2 opens the credential lazily through the vault and hands it to the adapter as a credential source', async () => {
    const { invoker, adapter, vault } = setup();
    await vault.put({ ref: 'magento-integration', scheme: 'bearer', secret: { token: 'tok-123' }, actor: 'admin' });
    await invoker.invoke({ operation: op('catalog.search_products'), args: ARGS, caller });
    const credential = adapter.reads[0]?.credential;
    expect(credential).toMatchObject({ ref: 'magento-integration', scheme: 'bearer' });
    expect(await credential?.open()).toEqual({ token: 'tok-123' });
  });

  it('SEC-2 reports a stored credential of an unknown scheme as unusable without calling the upstream', async () => {
    const { invoker, adapter, vault } = setup();
    await vault.put({ ref: 'magento-integration', scheme: 'kerberos', secret: { ticket: 'x' }, actor: 'admin' });
    const result = await invoker.invoke({ operation: op('catalog.search_products'), args: ARGS, caller });
    expect(result.isError).toBe(true);
    expect(result.text).toBe(READ_RESULT_TEXT.errors.credential_unusable('catalog.search_products'));
    expect(result.auditDetails).toMatchObject({ errorCode: 'credential_unusable' });
    expect(adapter.reads).toEqual([]);
  });

  it('SEC-2 a missing credential gives the credential_missing text through the real adapter', async () => {
    const invoker = new DirectReadInvoker({ configuration: CONFIG, vault: new MemoryVault(), adapter: createOpenApiAdapter() });
    const result = await invoker.invoke({ operation: op('catalog.search_products'), args: ARGS, caller });
    expect(result.isError).toBe(true);
    expect(result.text).toBe(READ_RESULT_TEXT.errors.credential_missing('catalog.search_products'));
    expect(result.auditDetails).toMatchObject({ operation: 'catalog.search_products', connection: 'magento', errorCode: 'credential_missing' });
  });

  it('MCP-4 answers with a fixed error when the operation has no upstream binding', async () => {
    const { adapter } = setup();
    const unbound: LoadedConfiguration = { ...CONFIG, bindings: new Map() };
    const invoker = new DirectReadInvoker({ configuration: unbound, vault: new MemoryVault(), adapter });
    const result = await invoker.invoke({ operation: op('catalog.search_products'), args: ARGS, caller });
    expect(result).toEqual({
      isError: true,
      text: READ_RESULT_TEXT.unknown('catalog.search_products'),
      auditDetails: { operation: 'catalog.search_products', connection: 'magento', errorCode: 'not_bound' },
    });
    expect(adapter.reads).toEqual([]);
  });

  it('SEC-1 POL-2 runs under the configuration it is given, not a newer one', async () => {
    const other = await loadConfigurationSources(
      Object.entries({ ...SOURCES, 'connections.yaml': SOURCES['connections.yaml'].replace('https://shop.example.test/rest', 'https://other.example.test/rest') }).map(([file, text]) => ({ file, text })),
    );
    if (!other.ok) throw new Error(JSON.stringify(other.issues));
    const adapter = new FakeAdapter(OK);
    const invokerFor = directReadInvokers({ vault: new MemoryVault(), adapter });
    await invokerFor(CONFIG, 'corr-a').invoke({ operation: op('catalog.search_products'), args: ARGS, caller });
    await invokerFor(other.configuration, 'corr-b').invoke({ operation: op('catalog.search_products'), args: ARGS, caller });
    expect(adapter.reads.map((r) => r.connection.baseUrl)).toEqual(['https://shop.example.test/rest', 'https://other.example.test/rest']);
    expect(adapter.reads[0]?.mapping).toBe(CONFIG.bindings.get('catalog.search_products')?.mapping);
  });

  it('AUD-1 records the connection of the binding that ran', async () => {
    const binding = CONFIG.bindings.get('catalog.search_products');
    const settings = CONFIG.connectionSettings.get('magento');
    if (binding === undefined || settings === undefined) throw new Error('fixture');
    const rebound: LoadedConfiguration = {
      ...CONFIG,
      bindings: new Map([['catalog.search_products', { ...binding, connection: 'magento-eu' }]]),
      connectionSettings: new Map([['magento-eu', { ...settings, id: 'magento-eu' }]]),
    };
    const adapter = new FakeAdapter(OK);
    const result = await new DirectReadInvoker({ configuration: rebound, vault: new MemoryVault(), adapter }).invoke({ operation: op('catalog.search_products'), args: ARGS, caller });
    expect(result.auditDetails).toMatchObject({ connection: 'magento-eu' });
    expect(adapter.reads[0]?.connection.id).toBe('magento-eu');
  });

  it('SEC-3 logs each upstream call with correlation ID, operation, connection, status and duration only', async () => {
    const lines: UpstreamCallLog[] = [];
    const invokerFor = directReadInvokers({ vault: new MemoryVault(), adapter: new FakeAdapter(OK), log: (l) => lines.push(l) });
    await invokerFor(CONFIG, 'corr-1').invoke({ operation: op('catalog.search_products'), args: ARGS, caller });
    const failing = directReadInvokers({
      vault: new MemoryVault(),
      adapter: new FakeAdapter({ ok: false, code: 'timeout', durationMs: 9, message: 'secret-detail' }),
      log: (l) => lines.push(l),
    });
    await failing(CONFIG, 'corr-2').invoke({ operation: op('catalog.search_products'), args: ARGS, caller });
    expect(lines).toEqual([
      { correlationId: 'corr-1', operation: 'catalog.search_products', connection: 'magento', status: 200, durationMs: 12 },
      { correlationId: 'corr-2', operation: 'catalog.search_products', connection: 'magento', durationMs: 9, errorCode: 'timeout' },
    ]);
  });
});
