import { describe, expect, it } from 'vitest';
import { loadConfigurationSources, type LoadedConfiguration } from '@aiops/config';
import type { BulkStatusOutcome, BulkSubmitOutcome, CallOutcome, WriteAdapter } from '@aiops/connector-sdk';
import type { CredentialHandle, CredentialStatus, CredentialVault } from '@aiops/core';
import { createBulkWriter } from './bulk-writer.js';
import type { UpstreamCallLog } from './read.js';

const SOURCES = {
  'connections.yaml': `version: 1
connections:
  - { id: magento, adapter: openapi, base_url: https://shop.example.test/rest, credential_ref: magento-integration, auth: { scheme: bearer } }
`,
  'operations.yaml': `version: 1
operations:
  - id: catalog.get_products_by_sku
    connection: magento
    risk: read
    description: Products by SKU.
    upstream: { method: GET, path: /V1/products, query: { skus: { arg: skus, join: ',' }, brand: { arg: brand } }, response: { items: items, fields_from_arg: fields } }
    input_schema:
      type: object
      properties: { skus: { type: array, items: { type: string } }, brand: { type: string }, fields: { type: array, items: { type: string } } }
      required: [skus, fields]
    fields_arg: fields
  - id: catalog.update_content
    connection: magento
    risk: write
    description: Update content.
    upstream:
      method: POST
      path: /async/bulk/V1/products
      bulk:
        body:
          wrap: product
          nest: { path: custom_attributes, key: attribute_code, value: value, keep: [sku, name, status] }
        batch_id: bulk_uuid
        status:
          method: GET
          path: /V1/bulk/{batch_id}/detailed-status
          items: operations_list
          index: id
          state: status
          states: { ok: [1], retriable: [2], failed: [3, 5], open: [4] }
    input_schema:
      type: object
      properties:
        brand: { type: string }
        skus: { type: array, items: { type: string } }
        changes: { type: object, properties: { description: { type: string } }, additionalProperties: false }
      required: [brand, changes]
    manifest:
      id_field: sku
      ids_arg: skus
      values_arg: changes
      fields: [description]
      scope_args: { brand: brand }
      read_before:
        operation: catalog.get_products_by_sku
        ids_arg: skus
        args: { brand: { arg: brand } }
      rollback: { strategy: replay_previous_state }
  - id: catalog.update_plain
    connection: magento
    risk: write_opaque
    description: Update without bulk.
    upstream: { method: PUT, path: '/V1/products/{sku}', path_params: { sku: { arg: sku } } }
    input_schema: { type: object, properties: { sku: { type: string } }, required: [sku] }
`,
};

const loaded = await loadConfigurationSources(Object.entries(SOURCES).map(([file, text]) => ({ file, text })));
if (!loaded.ok) throw new Error(JSON.stringify(loaded.issues));
const CONFIG: LoadedConfiguration = loaded.configuration;

const SECRET = 'unit-only-fake-token';
const RECORD_VALUE = 'a-distinctive-record-value';

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

class FakeWriteAdapter implements WriteAdapter {
  readonly submits: Parameters<WriteAdapter['submitBulk']>[0][] = [];
  readonly statuses: Parameters<WriteAdapter['bulkStatus']>[0][] = [];
  constructor(
    private readonly submitOutcome: BulkSubmitOutcome,
    private readonly statusOutcome: BulkStatusOutcome,
  ) {}
  submitBulk(input: Parameters<WriteAdapter['submitBulk']>[0]): Promise<BulkSubmitOutcome> {
    this.submits.push(input);
    return Promise.resolve(this.submitOutcome);
  }
  bulkStatus(input: Parameters<WriteAdapter['bulkStatus']>[0]): Promise<BulkStatusOutcome> {
    this.statuses.push(input);
    return Promise.resolve(this.statusOutcome);
  }  callOnce(): Promise<CallOutcome> {
    return Promise.resolve({ result: 'not_sent', code: 'mapping', durationMs: 0 });
  }
}

const SUBMIT_OK: BulkSubmitOutcome = { ok: true, batchId: 'b-1', status: 202, durationMs: 11 };
const STATUS_OK: BulkStatusOutcome = { ok: true, items: [{ index: 0, state: 'ok' }], durationMs: 5 };
const RECORDS = [{ sku: 'A', status: 2, description: RECORD_VALUE }];

async function setup(submit: BulkSubmitOutcome = SUBMIT_OK, status: BulkStatusOutcome = STATUS_OK, scheme = 'bearer') {
  const adapter = new FakeWriteAdapter(submit, status);
  const vault = new MemoryVault();
  await vault.put({ ref: 'magento-integration', scheme, secret: { token: SECRET }, actor: 'test' });
  const lines: UpstreamCallLog[] = [];
  const writer = createBulkWriter({
    configuration: CONFIG,
    vault,
    adapter,
    operationId: 'catalog.update_content',
    correlationId: 'corr-w',
    log: (l) => lines.push(l),
  });
  if (writer === undefined) throw new Error('expected a bulk writer');
  return { adapter, vault, lines, writer };
}

describe('OPS-6 EXE-4 bulk writer port over the connection write adapter', () => {
  it('OPS-6 passes connection settings, the bulk mapping, the records and the stored credential to the adapter', async () => {
    const { adapter, writer } = await setup();
    await writer.submit(RECORDS);
    await writer.status('b-1');
    const binding = CONFIG.bindings.get('catalog.update_content');
    if (binding?.kind !== 'http') throw new Error('fixture has no HTTP binding');
    const connection = CONFIG.connectionSettings.get('magento');
    expect(adapter.submits).toHaveLength(1);
    expect(adapter.submits[0]?.connection).toBe(connection);
    expect(adapter.submits[0]?.mapping).toBe(binding.mapping);
    expect(adapter.submits[0]?.mapping.bulk?.batchId).toBe('bulk_uuid');
    expect(adapter.submits[0]?.records).toEqual(RECORDS);
    expect(adapter.submits[0]?.credential).toMatchObject({ ref: 'magento-integration', scheme: 'bearer' });
    expect(await adapter.submits[0]?.credential?.open()).toEqual({ token: SECRET });
    expect(adapter.statuses).toHaveLength(1);
    expect(adapter.statuses[0]?.connection).toBe(connection);
    expect(adapter.statuses[0]?.mapping).toBe(binding.mapping);
    expect(adapter.statuses[0]?.batchId).toBe('b-1');
    expect(adapter.statuses[0]?.credential).toMatchObject({ ref: 'magento-integration', scheme: 'bearer' });
  });

  it('EXE-4 keeps code and retriable, drops status and duration from the port result', async () => {
    const ok = await setup();
    expect(await ok.writer.submit(RECORDS)).toEqual({ ok: true, batchId: 'b-1' });
    expect(await ok.writer.status('b-1')).toEqual({ ok: true, items: [{ index: 0, state: 'ok' }] });

    const failed = await setup(
      { ok: false, code: 'http_status', status: 503, durationMs: 9, retriable: true },
      { ok: false, code: 'rejected', status: 404, durationMs: 3, retriable: false },
    );
    expect(await failed.writer.submit(RECORDS)).toEqual({ ok: false, code: 'http_status', retriable: true });
    expect(await failed.writer.status('b-1')).toEqual({ ok: false, code: 'rejected', retriable: false });
  });

  it('EXE-4 a status http_status failure keeps its HTTP status, so the writer can retry a 401 or 403', async () => {
    const unauthorized = await setup(SUBMIT_OK, { ok: false, code: 'http_status', status: 401, durationMs: 3, retriable: false });
    expect(await unauthorized.writer.status('b-1')).toEqual({ ok: false, code: 'http_status', status: 401, retriable: false });
  });

  it('OPS-6 is undefined for an operation without bulk and for an unknown operation', () => {
    const base = { configuration: CONFIG, vault: new MemoryVault(), adapter: new FakeWriteAdapter(SUBMIT_OK, STATUS_OK), correlationId: 'c' };
    expect(createBulkWriter({ ...base, operationId: 'catalog.update_plain' })).toBeUndefined();
    expect(createBulkWriter({ ...base, operationId: 'catalog.get_products_by_sku' })).toBeUndefined();
    expect(createBulkWriter({ ...base, operationId: 'catalog.unknown' })).toBeUndefined();
  });

  it('SEC-3 a credential of an unknown scheme answers credential_unusable without calling the adapter', async () => {
    const { adapter, writer, lines } = await setup(SUBMIT_OK, STATUS_OK, 'carrier-pigeon');
    expect(await writer.submit(RECORDS)).toEqual({ ok: false, code: 'credential_unusable', retriable: false });
    expect(await writer.status('b-1')).toEqual({ ok: false, code: 'credential_unusable', retriable: false });
    expect(adapter.submits).toEqual([]);
    expect(adapter.statuses).toEqual([]);
    expect(lines).toEqual([]);
  });

  it('SEC-3 logs one record per call with identifiers, method, status and duration only', async () => {
    const { writer, lines } = await setup(SUBMIT_OK, { ok: false, code: 'http_status', status: 503, durationMs: 4, retriable: true });
    await writer.submit(RECORDS);
    await writer.status('b-1');
    expect(lines).toEqual([
      { correlationId: 'corr-w', operation: 'catalog.update_content', connection: 'magento', method: 'POST', status: 202, durationMs: 11 },
      { correlationId: 'corr-w', operation: 'catalog.update_content', connection: 'magento', method: 'GET', status: 503, durationMs: 4, errorCode: 'http_status' },
    ]);
    for (const line of lines) expect(line).not.toHaveProperty('records');
    const text = JSON.stringify(lines);
    expect(text).not.toContain(RECORD_VALUE);
    expect(text).not.toContain(SECRET);
    expect(text).not.toContain('b-1');
  });
});
