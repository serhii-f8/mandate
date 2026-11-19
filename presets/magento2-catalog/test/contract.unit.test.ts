/**
 * Contract tests of the Magento catalog preset (NFR-17 first cut, CONN-2; design part 1 §6).
 * The preset is loaded the way the api loads it: `@aiops/config` with the OpenAPI adapter's
 * resolver over the vendored spec. Each recording (from `pnpm record` against the sandbox)
 * pins the exact request the preset must send and the response it must map. With
 * MAGENTO_SANDBOX_URL and MAGENTO_SANDBOX_TOKEN set, the same cases run against the sandbox.
 */
import { readdir, readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildBulkBody, buildRequest, createOpenApiAdapter, mapBulkStatus, mapResponse } from '@aiops/adapters';
import { loadConfigurationSources, type HttpOperationBinding, type LoadedConfiguration } from '@aiops/config';
import type { BulkItemState, BulkMapping, ConnectionSettings, CredentialSource } from '@aiops/connector-sdk';
import { startFakeUpstream, type FakeUpstream } from '@aiops/testing';
import { PRESET_DIR } from '../src/index.js';

interface RecordedRequest {
  readonly method: string;
  readonly path: string;
  readonly query: Readonly<Record<string, string>>;
}
interface ContractCase {
  readonly name: string;
  readonly operation: string;
  readonly args: Readonly<Record<string, unknown>>;
  readonly request: RecordedRequest;
  readonly expect: { readonly skus: readonly string[]; readonly total: number };
}
interface Recording {
  readonly request: RecordedRequest;
  readonly response: { readonly status: number; readonly body: unknown };
}

const RECORDINGS = join(PRESET_DIR, 'test', 'recordings');
const BASE_PATH = '/rest/all';
const FAKE_TOKEN = 'contract-test-only-token';

const cases = JSON.parse(await readFile(join(PRESET_DIR, 'test', 'cases.json'), 'utf8')) as ContractCase[];
const recordings = new Map<string, { file: string; text: string; recording: Recording }>();
for (const c of cases) {
  const file = join(RECORDINGS, `${c.name}.json`);
  const text = await readFile(file, 'utf8');
  recordings.set(c.name, { file, text, recording: JSON.parse(text) as Recording });
}
const recordingOf = (c: ContractCase): Recording => {
  const r = recordings.get(c.name);
  if (r === undefined) throw new Error(`no recording for ${c.name}`);
  return r.recording;
};

/** The preset bound to connection `magento`, loaded with the real resolver (CONN-2). */
async function loadPreset(baseUrl: string): Promise<LoadedConfiguration> {
  const config = [
    'version: 1',
    'presets:',
    "  - { id: magento-catalog, package: '@aiops/magento2-catalog', version: '0.3.0' }",
    'connections:',
    '  - id: magento',
    '    adapter: openapi',
    `    base_url: ${baseUrl}`,
    '    credential_ref: magento-token',
    '    preset: magento-catalog',
    '    allow_private_network: true',
    '',
  ].join('\n');
  const result = await loadConfigurationSources([{ file: 'config.yaml', text: config }], {
    resolver: createOpenApiAdapter().resolver,
    presetDirs: [resolve(PRESET_DIR, '..')],
  });
  if (!result.ok) throw new Error(`preset did not load: ${JSON.stringify(result.issues)}`);
  return result.configuration;
}

function bindingOf(config: LoadedConfiguration, operation: string): HttpOperationBinding {
  const binding = config.bindings.get(operation);
  if (binding?.kind !== 'http') throw new Error(`no HTTP binding for ${operation}`);
  return binding;
}

function settingsOf(config: LoadedConfiguration): ConnectionSettings {
  const settings = config.connectionSettings.get('magento');
  if (settings === undefined) throw new Error('no settings for connection magento');
  return settings;
}

interface Poll {
  readonly status: number;
  readonly body: unknown;
}
interface WriteCase {
  readonly name: string;
  readonly operation: string;
  readonly records: readonly Record<string, unknown>[];
  readonly verify: { readonly operation: string; readonly args: Readonly<Record<string, unknown>> };
  readonly expect: { readonly states: readonly BulkItemState[]; readonly values: Readonly<Record<string, Record<string, unknown>>> };
}
interface WriteRecording {
  readonly request: { readonly method: string; readonly path: string; readonly body: unknown };
  readonly response: { readonly status: number; readonly body: unknown };
  readonly polls: readonly Poll[];
  readonly verify: { readonly response: { readonly status: number; readonly body: unknown } };
}
const writeCases = JSON.parse(await readFile(join(PRESET_DIR, 'test', 'write-cases.json'), 'utf8')) as WriteCase[];
const writeRecordings = new Map<string, WriteRecording>();
for (const c of writeCases) {
  writeRecordings.set(c.name, JSON.parse(await readFile(join(RECORDINGS, 'write', `${c.name}.json`), 'utf8')) as WriteRecording);
}
const writeRecordingOf = (c: WriteCase): WriteRecording => {
  const r = writeRecordings.get(c.name);
  if (r === undefined) throw new Error(`no write recording for ${c.name}`);
  return r;
};
const lastPoll = (c: WriteCase): Poll => {
  const polls = writeRecordingOf(c).polls;
  const last = polls[polls.length - 1];
  if (last === undefined) throw new Error(`no polls recorded for ${c.name}`);
  return last;
};
function bulkOf(config: LoadedConfiguration): BulkMapping {
  const bulk = bindingOf(config, 'catalog.update_content').mapping.bulk;
  if (bulk === undefined) throw new Error('catalog.update_content has no bulk binding');
  return bulk;
}
const sortedStates = (items: readonly { index: number; state: BulkItemState }[] | undefined): BulkItemState[] =>
  [...(items ?? [])].sort((a, b) => a.index - b.index).map((i) => i.state);
/** The verify read mapped to sku -> the checked fields only. */
function verifyValues(c: WriteCase, items: readonly Record<string, unknown>[] | undefined): Record<string, Record<string, unknown>> {
  const fields = c.verify.args.fields as string[];
  const out: Record<string, Record<string, unknown>> = {};
  for (const item of items ?? []) {
    out[String(item.sku)] = Object.fromEntries(fields.filter((f) => f !== 'sku').map((f) => [f, item[f]]));
  }
  return out;
}

const bearer = (token: string): CredentialSource => ({ ref: 'magento-token', scheme: 'bearer', open: () => Promise.resolve({ token }) });

/** The `brand` custom attribute of a raw Magento product. */
function rawBrand(item: unknown): unknown {
  if (typeof item !== 'object' || item === null || !('custom_attributes' in item) || !Array.isArray(item.custom_attributes)) return undefined;
  const entry: unknown = item.custom_attributes.find(
    (a: unknown) => typeof a === 'object' && a !== null && 'attribute_code' in a && a.attribute_code === 'brand',
  );
  return typeof entry === 'object' && entry !== null && 'value' in entry ? entry.value : undefined;
}

function expectMappedItems(c: ContractCase, items: readonly Record<string, unknown>[] | undefined): void {
  const fields = c.args.fields as string[];
  expect(items?.map((i) => i.sku)).toEqual(c.expect.skus);
  for (const item of items ?? []) {
    // Projection keeps exactly the requested fields: nothing more (cost, POL-3), nothing less.
    // Unset meta_* attributes are absent upstream, so they are absent here (ADR 0024).
    const maybeAbsent = new Set(['meta_title', 'meta_keyword', 'meta_description']);
    expect(Object.keys(item).sort()).toEqual(fields.filter((f) => f in item || !maybeAbsent.has(f)).sort());
    expect(Object.keys(item).every((k) => fields.includes(k))).toBe(true);
    if (fields.includes('brand')) expect(item.brand).toBe(c.args.brand);
  }
}

describe('NFR-17 magento2-catalog contract', () => {
  let config: LoadedConfiguration;

  beforeAll(async () => {
    config = await loadPreset(`http://magento-sandbox.invalid${BASE_PATH}`);
  });

  it('NFR-17 CONN-2 the preset loads against its vendored spec with three read operations, the write operation, connection test and bearer auth', () => {
    const ids = config.policy.operations.map((o) => o.id).sort();
    expect(ids).toEqual(['catalog.get_product', 'catalog.get_products_by_sku', 'catalog.search_products', 'catalog.update_content']);
    for (const op of config.policy.operations) {
      expect(op.risk).toBe(op.id === 'catalog.update_content' ? 'write' : 'read');
      expect(op.fieldsArg).toBe(op.id === 'catalog.update_content' ? 'changes' : 'fields');
      expect(op.source).toBe('preset:magento-catalog');
    }
    expect(settingsOf(config).auth).toEqual({ scheme: 'bearer' });
    expect(config.connectionTests.get('magento')).toEqual({
      operation: 'catalog.search_products',
      args: { brand: 'acme', fields: ['sku'], page_size: 1 },
    });
    // The imported write endpoints stay disabled: no preset operation enables them (CONN-2, OPS-1).
    expect(config.disabled.length).toBeGreaterThan(0);
  });

  it('NFR-17 OPS-2 OPS-4 catalog.update_content carries a manifest with batch size 100 and the sorted selector', () => {
    const op = config.policy.operations.find((o) => o.id === 'catalog.update_content');
    expect(op?.manifest).toMatchObject({
      idField: 'sku',
      idsArg: 'skus',
      valuesArg: 'changes',
      batchSize: 100,
      maxTargets: 10000,
      scopeArgs: { brand: 'brand' },
      readBefore: { operation: 'catalog.get_products_by_sku', idsArg: 'skus' },
      selector: { operation: 'catalog.search_products', pageSize: 100 },
      rollback: { strategy: 'replay_previous_state' },
    });
    const v = config.validators.get('catalog.update_content');
    expect(v?.({ brand: 'acme', skus: ['ACME-001'], changes: { name: 'x' } }).ok).toBe(true);
    expect(v?.({ brand: 'acme', name_like: '%a%', changes: { meta_title: 'x' } }).ok).toBe(true);
    expect(v?.({ brand: 'acme', skus: ['A,B'], changes: { name: 'x' } }).ok).toBe(false);
    expect(v?.({ brand: 'acme', skus: ['A'], changes: {} }).ok).toBe(false);
    expect(v?.({ brand: 'acme', skus: ['A'], changes: { price: 'x' } }).ok).toBe(false);
    expect(v?.({ skus: ['A'], changes: { name: 'x' } }).ok).toBe(false);
  });

  it('NFR-17 OPS-4 catalog.update_content names its targets by exactly one of skus or name_like', () => {
    const v = config.validators.get('catalog.update_content');
    // Neither: an accidental whole-brand update; a whole brand takes name_like "%" explicitly.
    expect(v?.({ brand: 'acme', changes: { name: 'x' } }).ok).toBe(false);
    expect(v?.({ brand: 'acme', skus: ['A'], name_like: '%', changes: { name: 'x' } }).ok).toBe(false);
    expect(v?.({ brand: 'acme', name_like: '%', changes: { name: 'x' } }).ok).toBe(true);
    expect(v?.({ brand: 'acme', skus: ['A'], changes: { name: 'x' } }).ok).toBe(true);
    // No combinator at the root: Claude clients refuse a tool whose input_schema has a top-level anyOf, oneOf or allOf.
    const schema = config.policy.operations.find((o) => o.id === 'catalog.update_content')?.inputSchema ?? {};
    for (const k of ['anyOf', 'oneOf', 'allOf', 'not']) expect(schema).not.toHaveProperty(k);
  });

  it('NFR-17 every case is recorded, and its arguments are valid input', () => {
    expect(cases.map((c) => c.name).sort()).toEqual([...recordings.keys()].sort());
    for (const c of cases) {
      const validator = config.validators.get(c.operation);
      expect(validator?.(c.args).ok, c.name).toBe(true);
    }
  });

  it('NFR-17 input schemas refuse unknown fields, page sizes over 100 and missing brand', () => {
    const search = config.validators.get('catalog.search_products');
    expect(search?.({ brand: 'acme', fields: ['password'] }).ok).toBe(false);
    expect(search?.({ brand: 'acme', fields: ['sku'], page_size: 101 }).ok).toBe(false);
    expect(search?.({ brand: 'acme', fields: ['sku'], current_page: 0 }).ok).toBe(false);
    expect(search?.({ fields: ['sku'] }).ok).toBe(false);
    expect(config.validators.get('catalog.get_product')?.({ brand: 'acme', fields: ['sku'] }).ok).toBe(false);
  });

  describe.each(cases)('NFR-17 case $name', (c) => {
    it('NFR-17 buildRequest from the preset mapping equals the recorded request', () => {
      const recorded = recordingOf(c).request;
      expect(recorded).toEqual(c.request);
      const req = buildRequest(`http://magento-sandbox.invalid${BASE_PATH}`, bindingOf(config, c.operation).mapping, c.args);
      expect(req.method).toBe(recorded.method);
      expect(req.url.pathname).toBe(`${BASE_PATH}${recorded.path}`);
      expect(Object.fromEntries(req.url.searchParams)).toEqual(recorded.query);
      expect([...req.url.searchParams.keys()]).toHaveLength(Object.keys(recorded.query).length);
      expect(req.body).toBeUndefined();
    });

    it('NFR-17 mapResponse of the recorded response gives the expected items, projected to fields', () => {
      const { response } = recordingOf(c);
      expect(response.status).toBe(200);
      // Every raw item the sandbox returned is of the requested brand (scope holds upstream).
      const raw = (response.body as { items: unknown[] }).items;
      for (const item of raw) expect(rawBrand(item)).toBe(c.args.brand);
      const mapped = mapResponse(bindingOf(config, c.operation).mapping.response, response.body, c.args);
      expect(mapped.total).toBe(c.expect.total);
      expect(mapped.truncated).toBe(false);
      expectMappedItems(c, mapped.items);
    });
  });

  it('NFR-17 get_product with a SKU of another brand finds nothing', () => {
    const c = cases.find((x) => x.name === 'get-product-other-brand');
    expect(c?.args).toMatchObject({ brand: 'acme', sku: 'GLOBEX-001' });
    if (c === undefined) return;
    const mapped = mapResponse(bindingOf(config, c.operation).mapping.response, recordingOf(c).response.body, c.args);
    expect(mapped.items).toEqual([]);
  });

  it('NFR-17 SEC-3 no recording or the vendored spec contains a token', async () => {
    // The read recordings and the Phase 5 write recordings (recordings/write/).
    const paths = [
      ...(await readdir(RECORDINGS)).filter((n) => n.endsWith('.json')).map((n) => join(RECORDINGS, n)),
      ...(await readdir(join(RECORDINGS, 'write'))).map((n) => join(RECORDINGS, 'write', n)),
    ];
    expect(paths.length).toBeGreaterThan(0);
    const files = [
      ...(await Promise.all(paths.map((p) => readFile(p, 'utf8')))),
      await readFile(join(PRESET_DIR, 'spec', 'magento2-catalog.swagger.json'), 'utf8'),
    ];
    for (const text of files) {
      expect(text).not.toContain('eyJ');
      expect(text.toLowerCase()).not.toContain('"authorization"');
    }
  });

  describe('NFR-17 replay through the adapter read path (fake upstream)', () => {
    let upstream: FakeUpstream;
    let replay: LoadedConfiguration;

    beforeAll(async () => {
      upstream = await startFakeUpstream();
      replay = await loadPreset(`${upstream.url}${BASE_PATH}`);
    });
    afterAll(async () => {
      await upstream.close();
    });

    it.each(cases)('NFR-17 $name: the adapter sends the recorded request with the bearer token and maps the recorded response', async (c) => {
      const recording = recordingOf(c);
      upstream.route(recording.request.method, `${BASE_PATH}${recording.request.path}`, () => ({
        status: recording.response.status,
        body: recording.response.body,
      }));
      const before = upstream.requests.length;
      const outcome = await createOpenApiAdapter().read({
        connection: settingsOf(replay),
        mapping: bindingOf(replay, c.operation).mapping,
        args: c.args,
        credential: bearer(FAKE_TOKEN),
      });
      const sent = upstream.requests.slice(before);
      expect(sent).toHaveLength(1);
      expect(sent[0]?.method).toBe(recording.request.method);
      expect(Object.fromEntries(sent[0]?.query ?? [])).toEqual(recording.request.query);
      expect(sent[0]?.headers.authorization).toBe(`Bearer ${FAKE_TOKEN}`);
      expect(outcome.ok).toBe(true);
      if (!outcome.ok) return;
      expect(outcome.total).toBe(c.expect.total);
      expectMappedItems(c, outcome.items);
    });
  });

  it('NFR-17 OPS-6 catalog.update_content binds the bulk route, the detailed status and carries status', () => {
    expect(bindingOf(config, 'catalog.update_content').mapping).toMatchObject({
      method: 'POST',
      path: '/async/bulk/V1/products',
      bulk: {
        body: { wrap: 'product', nest: { path: 'custom_attributes', key: 'attribute_code', value: 'value', keep: ['sku', 'name', 'status'] } },
        batchId: 'bulk_uuid',
        status: {
          method: 'GET',
          path: '/V1/bulk/{batch_id}/detailed-status',
          items: 'operations_list',
          index: 'id',
          state: 'status',
          states: { ok: [1], retriable: [2], failed: [3, 5], open: [4] },
        },
      },
    });
    expect(config.policy.operations.find((o) => o.id === 'catalog.update_content')?.manifest?.write).toEqual({ carryFields: ['status'] });
  });

  it('NFR-17 every write case is recorded', () => {
    expect(writeCases.length).toBeGreaterThan(0);
    expect([...writeRecordings.keys()].sort()).toEqual(writeCases.map((c) => c.name).sort());
  });

  describe.each(writeCases)('NFR-17 write case $name', (c) => {
    it('NFR-17 OPS-6 buildBulkBody from the preset mapping equals the recorded request body', () => {
      expect(buildBulkBody(bulkOf(config).body, c.records)).toEqual(writeRecordingOf(c).request.body);
    });

    it('NFR-17 EXE-5 the recorded polls map to the expected states by index', () => {
      expect(sortedStates(mapBulkStatus(bulkOf(config).status, lastPoll(c).body))).toEqual(c.expect.states);
    });

    it('NFR-17 CS-7 the recorded verify read maps to the expected values', () => {
      const binding = bindingOf(config, c.verify.operation);
      const mapped = mapResponse(binding.mapping.response, writeRecordingOf(c).verify.response.body, c.verify.args);
      expect(verifyValues(c, mapped.items)).toEqual(c.expect.values);
    });
  });

  describe('NFR-17 write replay through the adapter (fake upstream)', () => {
    let upstream: FakeUpstream;
    let replay: LoadedConfiguration;

    beforeAll(async () => {
      upstream = await startFakeUpstream();
      replay = await loadPreset(`${upstream.url}${BASE_PATH}`);
    });
    afterAll(async () => {
      await upstream.close();
    });

    it.each(writeCases)('NFR-17 OPS-6 EXE-5 $name: submitBulk sends the recorded body with the bearer token; bulkStatus walks the recorded polls to the expected states', async (c) => {
      const recording = writeRecordingOf(c);
      const uuid = (recording.response.body as { bulk_uuid: string }).bulk_uuid;
      upstream.route('POST', `${BASE_PATH}${recording.request.path}`, () => ({ status: recording.response.status, body: recording.response.body }));
      let served = 0;
      upstream.route('GET', `${BASE_PATH}/V1/bulk/${uuid}/detailed-status`, () => {
        const poll = recording.polls[Math.min(served, recording.polls.length - 1)];
        served += 1;
        return { status: poll?.status ?? 500, body: poll?.body };
      });
      const adapter = createOpenApiAdapter();
      const common = { connection: settingsOf(replay), mapping: bindingOf(replay, c.operation).mapping, credential: bearer(FAKE_TOKEN) };
      const before = upstream.requests.length;
      const submitted = await adapter.submitBulk({ ...common, records: c.records });
      const sent = upstream.requests.slice(before);
      expect(sent).toHaveLength(1);
      expect(JSON.parse(sent[0]?.body ?? 'null')).toEqual(recording.request.body);
      expect(sent[0]?.headers.authorization).toBe(`Bearer ${FAKE_TOKEN}`);
      expect(submitted.ok).toBe(true);
      if (!submitted.ok) return;
      expect(submitted.batchId).toBe(uuid);

      let states: readonly { index: number; state: BulkItemState }[] = [];
      for (let i = 0; i <= recording.polls.length; i += 1) {
        const status = await adapter.bulkStatus({ ...common, batchId: submitted.batchId });
        expect(status.ok, status.ok ? '' : status.code).toBe(true);
        if (!status.ok) return;
        states = status.items;
        if (!states.some((s) => s.state === 'open')) break;
      }
      expect(states.some((s) => s.state === 'open')).toBe(false);
      expect(sortedStates(states)).toEqual(c.expect.states);
    });
  });

  const liveUrl = process.env.MAGENTO_SANDBOX_URL;
  const liveToken = process.env.MAGENTO_SANDBOX_TOKEN;
  describe.runIf(liveUrl !== undefined && liveUrl !== '' && liveToken !== undefined && liveToken !== '')(
    'NFR-17 live against the Magento sandbox (MAGENTO_SANDBOX_URL, MAGENTO_SANDBOX_TOKEN)',
    () => {
      let live: LoadedConfiguration;
      beforeAll(async () => {
        live = await loadPreset(`${(liveUrl ?? '').replace(/\/+$/, '')}${BASE_PATH}`);
      });

      it.each(writeCases)('NFR-17 OPS-6 CS-7 $name live write: submitBulk, poll bulkStatus, verify read', async (c) => {
        const adapter = createOpenApiAdapter();
        const common = { connection: settingsOf(live), mapping: bindingOf(live, c.operation).mapping, credential: bearer(liveToken ?? '') };
        const submitted = await adapter.submitBulk({ ...common, records: c.records });
        expect(submitted.ok, submitted.ok ? '' : submitted.code).toBe(true);
        if (!submitted.ok) return;
        let states: readonly { index: number; state: BulkItemState }[];
        const deadline = Date.now() + 120_000;
        for (;;) {
          const status = await adapter.bulkStatus({ ...common, batchId: submitted.batchId });
          expect(status.ok, status.ok ? '' : status.code).toBe(true);
          if (!status.ok) return;
          states = status.items;
          if (!states.some((s) => s.state === 'open') && states.length === c.records.length) break;
          if (Date.now() > deadline) throw new Error('bulk batch still open after 120 s');
          await new Promise((r) => setTimeout(r, 1000));
        }
        expect(sortedStates(states)).toEqual(c.expect.states);
        const verify = await adapter.read({
          connection: settingsOf(live),
          mapping: bindingOf(live, c.verify.operation).mapping,
          args: c.verify.args,
          credential: bearer(liveToken ?? ''),
        });
        expect(verify.ok, verify.ok ? '' : `${verify.code} ${verify.message}`).toBe(true);
        if (!verify.ok) return;
        expect(verifyValues(c, verify.items)).toEqual(c.expect.values);
      }, 150_000);

      it.each(cases)('NFR-17 $name live', async (c) => {
        const outcome = await createOpenApiAdapter().read({
          connection: settingsOf(live),
          mapping: bindingOf(live, c.operation).mapping,
          args: c.args,
          credential: bearer(liveToken ?? ''),
        });
        expect(outcome.ok, outcome.ok ? '' : `${outcome.code} ${outcome.message}`).toBe(true);
        if (!outcome.ok) return;
        expect(outcome.total).toBe(c.expect.total);
        expectMappedItems(c, outcome.items);
      });
    },
  );
});
