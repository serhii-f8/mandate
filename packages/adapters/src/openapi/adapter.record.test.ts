// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Mandate Authors
import type { ConnectionSettings, CredentialSource, UpstreamMapping } from '@mandate/connector-sdk';
import { startFakeUpstream, type FakeUpstream } from '@mandate/testing';
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
    id: `oar-${seq}`,
    baseUrl: up.url,
    timeoutMs: 2000,
    retry: { maxAttempts: 3, initialBackoffMs: 1 },
    maxConcurrency: 4,
    allowPrivateNetwork: true,
    extraHosts: [],
    ...over,
  };
}

const cred = (token: string): CredentialSource => ({ ref: 'test-cred', scheme: 'bearer', open: () => Promise.resolve({ token }) });

const MAPPING = {
  method: 'PATCH',
  path: '/items/{id}',
  pathParams: { id: { record: 'id' } },
  query: {},
  headers: {},
  response: { maxItems: 1 },
} satisfies UpstreamMapping;

describe('OPS-6 writeRecord', () => {
  it('OPS-6 sends PATCH /items/7 with the record minus path fields as JSON, credential injected, never retried', async () => {
    up.route('PATCH', '/items/7', () => ({ status: 200, body: { id: 7, title: 'x' } }));
    const token = 'unit-token-record-0123456789';
    const r = await createOpenApiAdapter().writeRecord({
      connection: settings({ auth: { scheme: 'bearer' } }),
      mapping: MAPPING,
      record: { id: 7, title: 'x' },
      args: {},
      credential: cred(token),
    });
    expect(r).toEqual({ ok: true, status: 200, durationMs: ANY_MS });
    expect(up.requests).toHaveLength(1);
    expect(up.requests[0]?.method).toBe('PATCH');
    expect(up.requests[0]?.path).toBe('/items/7');
    expect(up.requests[0]?.body).toBe('{"title":"x"}');
    expect(up.requests[0]?.headers['content-type']).toBe('application/json');
    expect(up.requests[0]?.headers.authorization).toBe(`Bearer ${token}`);
  });

  it('OPS-6 an explicit body template is used instead', async () => {
    up.route('PUT', '/repos/acme/items/7', () => ({ status: 204 }));
    const r = await createOpenApiAdapter().writeRecord({
      connection: settings(),
      mapping: {
        ...MAPPING,
        method: 'PUT',
        path: '/repos/{owner}/items/{id}',
        pathParams: { owner: { arg: 'owner' }, id: { record: 'id' } },
        body: { record: 'labels' },
      },
      record: { id: 7, labels: ['a', 'b'], title: 'ignored' },
      args: { owner: 'acme' },
    });
    expect(r).toEqual({ ok: true, status: 204, durationMs: ANY_MS });
    expect(up.requests[0]?.body).toBe('["a","b"]');
  });

  it.each([
    [200, 'not json', { ok: true, status: 200 }],
    [201, '', { ok: true, status: 201 }],
    [400, { message: 'bad title' }, { ok: false, code: 'rejected', status: 400, retriable: false }],
    [404, { message: 'missing' }, { ok: false, code: 'rejected', status: 404, retriable: false }],
    [429, { message: 'slow down' }, { ok: false, code: 'http_status', status: 429, retriable: true }],
    [503, { message: 'down' }, { ok: false, code: 'http_status', status: 503, retriable: true }],
  ] as const)(
    'OPS-6 classifies 2xx and an unreadable 2xx as ok, 4xx as rejected, 429/503/timeout as retriable (%i)',
    async (status, body, expected) => {
      up.route('PATCH', '/items/7', () => ({ status, body }));
      const r = await createOpenApiAdapter().writeRecord({ connection: settings(), mapping: MAPPING, record: { id: 7, title: 'x' }, args: {} });
      expect(r).toEqual({ ...expected, durationMs: ANY_MS });
      expect(up.requests).toHaveLength(1);
      expect(JSON.stringify(r)).not.toMatch(/bad title|missing|slow down|down"/);
    },
  );

  it('OPS-6 classifies 2xx and an unreadable 2xx as ok, 4xx as rejected, 429/503/timeout as retriable (timeout)', async () => {
    up.route('PATCH', '/items/7', () => ({ status: 200, body: {}, delayMs: 500 }));
    const r = await createOpenApiAdapter().writeRecord({
      connection: settings({ timeoutMs: 100 }),
      mapping: MAPPING,
      record: { id: 7, title: 'x' },
      args: {},
    });
    expect(r).toEqual({ ok: false, code: 'timeout', durationMs: ANY_MS, retriable: true });
    expect(up.requests).toHaveLength(1);
  });

  it('CONN-5 a private address is refused without allow_private_network', async () => {
    const r = await createOpenApiAdapter().writeRecord({
      connection: settings({ allowPrivateNetwork: false }),
      mapping: MAPPING,
      record: { id: 7, title: 'x' },
      args: {},
    });
    expect(r).toMatchObject({ ok: false, code: 'egress_denied', retriable: false });
    expect(up.requests).toHaveLength(0);
  });

  it('OPS-6 SEC-5 a mapping problem sends nothing: no path value, a dot segment, a GET, a bulk mapping, an unsendable header, a body template that renders nothing', async () => {
    const adapter = createOpenApiAdapter();
    const send = (mapping: UpstreamMapping, record: Record<string, unknown>) =>
      adapter.writeRecord({ connection: settings(), mapping, record, args: {} });
    const refused = { ok: false, code: 'mapping', durationMs: 0, retriable: false };
    expect(await send(MAPPING, { title: 'x' })).toEqual(refused);
    expect(await send(MAPPING, { id: '..', title: 'x' })).toEqual(refused);
    expect(await send({ ...MAPPING, method: 'GET' }, { id: 7 })).toEqual(refused);
    const noMethod: UpstreamMapping = { ...MAPPING };
    delete noMethod.method;
    expect(await send(noMethod, { id: 7 })).toEqual(refused);
    const bulk = { body: {}, batchId: 'id', status: { method: 'GET' as const, path: '/b/{batch_id}', items: 'i', index: 'i', state: 's', states: { ok: [], failed: [], retriable: [], open: [] } } };
    expect(await send({ ...MAPPING, bulk }, { id: 7 })).toEqual(refused);
    expect(await send({ ...MAPPING, headers: { 'x-note': { record: 'note' } } }, { id: 7, note: 'a\r\nb' })).toEqual(refused);
    // A body template that renders nothing would send an empty PUT/PATCH, which an upstream may read as "clear".
    expect(await send({ ...MAPPING, body: { record: 'labels' } }, { id: 7 })).toEqual(refused);
    expect(await send({ ...MAPPING, body: { record: 'labels' } }, { id: 7, labels: null })).toEqual(refused);
    expect(await send({ ...MAPPING, body: { arg: 'payload' } }, { id: 7 })).toEqual(refused);
    expect(up.requests).toHaveLength(0);
  });
});
