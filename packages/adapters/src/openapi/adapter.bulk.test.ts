import type { ConnectionSettings, CredentialSource, UpstreamMapping } from '@aiops/connector-sdk';
import { startFakeUpstream, type FakeUpstream } from '@aiops/testing';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { clearTokenCache } from '../http/oauth.js';
import { createOpenApiAdapter } from './adapter.js';

/** Typed as unknown so the asymmetric matcher is not an `any` in the expected objects. */
const ANY_MS: unknown = expect.any(Number);

let up: FakeUpstream;
let seq = 0;

beforeEach(async () => {
  up = await startFakeUpstream();
  clearTokenCache();
});
afterEach(async () => {
  await up.close();
});

function settings(over: Partial<ConnectionSettings> = {}): ConnectionSettings {
  seq += 1;
  return {
    id: `oab-${seq}`,
    baseUrl: up.url,
    timeoutMs: 2000,
    retry: { maxAttempts: 3, initialBackoffMs: 1 },
    maxConcurrency: 4,
    allowPrivateNetwork: true,
    extraHosts: [],
    ...over,
  };
}

function cred(scheme: CredentialSource['scheme'], material: Record<string, string>): CredentialSource {
  return { ref: 'test-cred', scheme, open: () => Promise.resolve(material) };
}

const NEST = { path: 'custom_attributes', key: 'attribute_code', value: 'value', keep: ['sku', 'name', 'status'] };
const STATUS = {
  method: 'GET' as const,
  path: '/V1/bulk/{batch_id}/detailed-status',
  items: 'operations_list',
  index: 'id',
  state: 'status',
  states: { ok: [1], retriable: [2], failed: [3, 5], open: [4] },
};
const MAPPING = {
  method: 'POST',
  path: '/async/bulk/V1/products',
  pathParams: {},
  query: {},
  headers: {},
  response: { maxItems: 100 },
  bulk: { body: { wrap: 'product', nest: NEST }, batchId: 'bulk_uuid', status: STATUS },
} satisfies UpstreamMapping;

describe('OPS-6 EXE-4 bulk writes through the OpenAPI adapter', () => {
  it('OPS-6 posts the wrapped and nested body with the bearer token and returns the batch ID', async () => {
    up.route('POST', '/async/bulk/V1/products', () => ({ status: 202, body: { bulk_uuid: 'b-1', request_items: [], errors: false } }));
    const r = await createOpenApiAdapter().submitBulk({
      connection: settings({ auth: { scheme: 'bearer' } }),
      mapping: MAPPING,
      records: [{ sku: 'A', status: 2, description: 'D' }],
      credential: cred('bearer', { token: 'unit-token-0123456789' }),
    });
    expect(r).toMatchObject({ ok: true, batchId: 'b-1', status: 202 });
    expect(JSON.parse(up.requests[0]?.body ?? '')).toEqual([
      { product: { sku: 'A', status: 2, custom_attributes: [{ attribute_code: 'description', value: 'D' }] } },
    ]);
    expect(up.requests[0]?.headers.authorization).toBe('Bearer unit-token-0123456789');
    expect(up.requests[0]?.headers['content-type']).toBe('application/json');
  });

  it.each([
    [503, true, 'http_status'],
    [429, true, 'http_status'],
    [500, true, 'http_status'],
    [400, false, 'rejected'],
    [404, false, 'rejected'],
  ] as const)('EXE-4 a submit answered %i is sent once (no client retry) and is retriable=%s with code %s', async (status, retriable, code) => {
    up.route('POST', '/async/bulk/V1/products', () => ({ status, body: { message: 'Invalid product data: secret-ish upstream text' } }));
    const r = await createOpenApiAdapter().submitBulk({ connection: settings(), mapping: MAPPING, records: [{ sku: 'A' }] });
    expect(up.requests).toHaveLength(1);
    expect(r).toEqual({ ok: false, code, status, durationMs: ANY_MS, retriable });
    expect(JSON.stringify(r)).not.toContain('Invalid product data');
  });

  it('EXE-4 a submit timeout is retriable and sent once', async () => {
    up.route('POST', '/async/bulk/V1/products', () => ({ status: 202, body: { bulk_uuid: 'b-1' }, delayMs: 500 }));
    const r = await createOpenApiAdapter().submitBulk({ connection: settings({ timeoutMs: 100 }), mapping: MAPPING, records: [{ sku: 'A' }] });
    expect(r).toEqual({ ok: false, code: 'timeout', durationMs: ANY_MS, retriable: true });
    expect(up.requests).toHaveLength(1);
  });

  it.each([[{}], [{ bulk_uuid: '../x' }], [{ bulk_uuid: { id: 'b-1' } }]])(
    'EXE-4 SEC-5 a 2xx submit without a usable batch ID is invalid_response, not retriable (%j)',
    async (body) => {
      up.route('POST', '/async/bulk/V1/products', () => ({ status: 202, body }));
      const r = await createOpenApiAdapter().submitBulk({ connection: settings(), mapping: MAPPING, records: [{ sku: 'A' }] });
      expect(r).toEqual({ ok: false, code: 'invalid_response', status: 202, durationMs: ANY_MS, retriable: false });
      expect(JSON.stringify(r)).not.toContain('../x');
      expect(up.requests).toHaveLength(1);
    },
  );

  it('CONN-5 a submit to a host outside egress is refused before any request', async () => {
    const r = await createOpenApiAdapter().submitBulk({
      connection: settings({ allowPrivateNetwork: false }),
      mapping: MAPPING,
      records: [{ sku: 'A' }],
    });
    expect(r).toMatchObject({ ok: false, code: 'egress_denied', retriable: false });
    expect(up.requests).toHaveLength(0);
  });

  it('CONN-3 a submit without the required credential is credential_missing and sends nothing', async () => {
    const r = await createOpenApiAdapter().submitBulk({
      connection: settings({ auth: { scheme: 'bearer' } }),
      mapping: MAPPING,
      records: [{ sku: 'A' }],
    });
    expect(r).toEqual({ ok: false, code: 'credential_missing', durationMs: ANY_MS, retriable: false });
    expect(up.requests).toHaveLength(0);
  });

  it('OPS-6 a submit mapping without method and path is refused with code mapping and no request', async () => {
    const rest: UpstreamMapping = { ...MAPPING };
    delete rest.method;
    const r = await createOpenApiAdapter().submitBulk({ connection: settings(), mapping: rest, records: [{ sku: 'A' }] });
    expect(r).toEqual({ ok: false, code: 'mapping', durationMs: 0, retriable: false });
    expect(up.requests).toHaveLength(0);
  });

  it('OPS-6 bulkStatus maps states by index and retries a 503 (status GET only)', async () => {
    let n = 0;
    up.route('GET', '/V1/bulk/b-1/detailed-status', () =>
      ++n === 1
        ? { status: 503 }
        : {
            status: 200,
            body: { operations_list: [{ id: 1, status: 3, result_message: 'URL key for specified store already exists.' }, { id: 0, status: 1 }] },
          },
    );
    const r = await createOpenApiAdapter().bulkStatus({ connection: settings(), mapping: MAPPING, batchId: 'b-1' });
    expect(r).toMatchObject({ ok: true, items: [{ index: 1, state: 'failed' }, { index: 0, state: 'ok' }] });
    expect(up.requests).toHaveLength(2);
    expect(JSON.stringify(r)).not.toContain('URL key'); // SEC-5
  });

  it('OPS-6 bulkStatus: 404 is http_status not retriable', async () => {
    const r = await createOpenApiAdapter().bulkStatus({ connection: settings(), mapping: MAPPING, batchId: 'b-1' });
    expect(r).toEqual({ ok: false, code: 'http_status', status: 404, durationMs: ANY_MS, retriable: false });
  });

  it('OPS-6 bulkStatus: a 503 that persists is http_status and retriable', async () => {
    up.route('GET', '/V1/bulk/b-1/detailed-status', () => ({ status: 503 }));
    const r = await createOpenApiAdapter().bulkStatus({ connection: settings(), mapping: MAPPING, batchId: 'b-1' });
    expect(r).toEqual({ ok: false, code: 'http_status', status: 503, durationMs: ANY_MS, retriable: true });
    expect(up.requests).toHaveLength(3);
  });

  it('OPS-6 bulkStatus: a non-array items path is invalid_response', async () => {
    up.route('GET', '/V1/bulk/b-1/detailed-status', () => ({ status: 200, body: { operations_list: { id: 0 } } }));
    const r = await createOpenApiAdapter().bulkStatus({ connection: settings(), mapping: MAPPING, batchId: 'b-1' });
    expect(r).toEqual({ ok: false, code: 'invalid_response', status: 200, durationMs: ANY_MS, retriable: false });
  });

  it('OPS-6 SEC-5 bulkStatus: an unsafe batch ID is mapping with no request', async () => {
    const r = await createOpenApiAdapter().bulkStatus({ connection: settings(), mapping: MAPPING, batchId: '../admin' });
    expect(r).toEqual({ ok: false, code: 'mapping', durationMs: 0, retriable: false });
    expect(up.requests).toHaveLength(0);
  });

  it('SEC-3 a token echoed in a status body never appears in the outcome', async () => {
    const token = 'unit-token-echo-0123456789';
    up.route('GET', '/V1/bulk/b-1/detailed-status', () => ({
      status: 200,
      body: { operations_list: [{ id: 0, status: 1, result_message: `token ${token}` }] },
    }));
    const r = await createOpenApiAdapter().bulkStatus({
      connection: settings({ auth: { scheme: 'bearer' } }),
      mapping: MAPPING,
      batchId: 'b-1',
      credential: cred('bearer', { token }),
    });
    expect(r).toMatchObject({ ok: true, items: [{ index: 0, state: 'ok' }] });
    expect(up.requests[0]?.headers.authorization).toBe(`Bearer ${token}`);
    expect(JSON.stringify(r)).not.toContain(token);
  });

  it('OPS-6 a mapping without bulk is refused with code mapping and no request', async () => {
    const plain: UpstreamMapping = { ...MAPPING };
    delete plain.bulk;
    const adapter = createOpenApiAdapter();
    expect(await adapter.submitBulk({ connection: settings(), mapping: plain, records: [{ sku: 'A' }] })).toEqual({
      ok: false,
      code: 'mapping',
      durationMs: 0,
      retriable: false,
    });
    expect(await adapter.bulkStatus({ connection: settings(), mapping: plain, batchId: 'b-1' })).toEqual({
      ok: false,
      code: 'mapping',
      durationMs: 0,
      retriable: false,
    });
    expect(up.requests).toHaveLength(0);
  });
});
