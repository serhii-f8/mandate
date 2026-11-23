// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Mandate Authors
import type { ConnectionSettings, CredentialSource, UpstreamMapping, WriteAdapter } from '@mandate/connector-sdk';
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
    id: `oac-${seq}`,
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

const MAPPING = {
  method: 'POST',
  path: '/rest/V1/orders/{id}/cancel',
  pathParams: { id: { arg: 'order_id' } },
  query: {},
  headers: {},
  body: { arg: 'payload' },
  response: { maxItems: 1 },
  idempotency: { header: 'Idempotency-Key' },
} satisfies UpstreamMapping;

const ARGS = { order_id: '42', payload: { reason: 'customer request' } };

type CallInput = Parameters<NonNullable<WriteAdapter['callOnce']>>[0];

/** A hook that counts its calls and the requests the fake upstream had seen at that moment. */
function hook(): { beforeSend: () => Promise<void>; seen: number[] } {
  const seen: number[] = [];
  return {
    seen,
    beforeSend: () => {
      seen.push(up.requests.length);
      return Promise.resolve();
    },
  };
}

function call(over: Partial<CallInput> = {}): ReturnType<NonNullable<WriteAdapter['callOnce']>> {
  return createOpenApiAdapter().callOnce({
    connection: settings(),
    target: { kind: 'http', mapping: MAPPING },
    args: ARGS,
    idempotencyKey: 'cs-1:call',
    beforeSend: () => Promise.resolve(),
    ...over,
  });
}

describe('EXE-4 OpenAPI callOnce', () => {
  it('EXE-4 POSTs once with the body and the idempotency header', async () => {
    up.route('POST', '/rest/V1/orders/42/cancel', () => ({ status: 200, body: { ok: true } }));
    const h = hook();
    const r = await call({
      connection: settings({ auth: { scheme: 'bearer' } }),
      credential: cred('bearer', { token: 'unit-token-0123456789' }),
      beforeSend: h.beforeSend,
    });
    expect(r).toEqual({ result: 'accepted', status: 200, durationMs: ANY_MS });
    expect(up.requests).toHaveLength(1);
    const req = up.requests[0];
    expect(req?.method).toBe('POST');
    expect(req?.headers['idempotency-key']).toBe('cs-1:call');
    expect(req?.headers['content-type']).toBe('application/json');
    expect(req?.headers.authorization).toBe('Bearer unit-token-0123456789');
    expect(JSON.parse(req?.body ?? '')).toEqual({ reason: 'customer request' });
    expect(h.seen).toEqual([0]);
  });

  it('EXE-4 without a declared idempotency header no key is sent', async () => {
    up.route('POST', '/rest/V1/orders/42/cancel', () => ({ status: 204 }));
    const mapping: UpstreamMapping = { ...MAPPING };
    delete mapping.idempotency;
    const r = await call({ target: { kind: 'http', mapping } });
    expect(r).toMatchObject({ result: 'accepted', status: 204 });
    expect(up.requests[0]?.headers['idempotency-key']).toBeUndefined();
  });

  it('EXE-4 beforeSend runs before the request and a throw sends nothing', async () => {
    up.route('POST', '/rest/V1/orders/42/cancel', () => ({ status: 200, body: {} }));
    const fenced = new Error('batch fenced');
    await expect(call({ beforeSend: () => Promise.reject(fenced) })).rejects.toBe(fenced);
    expect(up.requests).toEqual([]);
  });

  it.each([
    ['empty', { status: 200, body: '' }],
    ['non-JSON', { status: 201, headers: { 'content-type': 'text/plain' }, body: 'created' }],
    ['malformed JSON', { status: 202, headers: { 'content-type': 'application/json' }, body: '{nope' }],
  ])('EXE-4 a 2xx with an empty or non-JSON body is accepted (%s)', async (_name, response) => {
    up.route('POST', '/rest/V1/orders/42/cancel', () => response);
    const r = await call();
    expect(r).toEqual({ result: 'accepted', status: response.status, durationMs: ANY_MS });
    expect(up.requests).toHaveLength(1);
  });

  it('EXE-4 a 303 is unknown and not followed', async () => {
    up.route('POST', '/rest/V1/orders/42/cancel', () => ({ status: 303, headers: { location: `${up.url}/elsewhere` } }));
    up.route('GET', '/elsewhere', () => ({ status: 200, body: {} }));
    const r = await call();
    expect(r).toEqual({ result: 'unknown', code: 'http_status', status: 303, durationMs: ANY_MS });
    expect(up.requests.map((x) => x.path)).toEqual(['/rest/V1/orders/42/cancel']);
  });

  it.each([
    [422, 'refused', 'rejected'],
    [429, 'refused', 'rejected'],
    [401, 'refused', 'rejected'],
    [500, 'unknown', 'http_status'],
    [503, 'unknown', 'http_status'],
  ] as const)('EXE-4 422 and 429 are refused; 500 and a timeout are unknown, each with one request (%i)', async (status, result, code) => {
    up.route('POST', '/rest/V1/orders/42/cancel', () => ({ status, body: {} }));
    const r = await call();
    expect(r).toEqual({ result, code, status, durationMs: ANY_MS });
    expect(up.requests).toHaveLength(1);
  });

  it('EXE-4 422 and 429 are refused; 500 and a timeout are unknown, each with one request (timeout)', async () => {
    up.route('POST', '/rest/V1/orders/42/cancel', () => ({ status: 200, body: {}, delayMs: 500 }));
    const r = await call({ connection: settings({ timeoutMs: 100 }) });
    expect(r).toEqual({ result: 'unknown', code: 'timeout', durationMs: ANY_MS });
    expect(up.requests).toHaveLength(1);
  });

  it('EXE-4 GET and bulk mappings are not sent', async () => {
    const STATUS = {
      method: 'GET' as const,
      path: '/bulk/{batch_id}',
      items: 'items',
      index: 'id',
      state: 'status',
      states: { ok: [1], retriable: [2], failed: [3], open: [4] },
    };
    const targets: CallInput['target'][] = [
      { kind: 'http', mapping: { ...MAPPING, method: 'GET' } },
      { kind: 'http', mapping: { ...MAPPING, bulk: { body: {}, batchId: 'id', status: STATUS } } },
      { kind: 'http', mapping: { pathParams: {}, query: {}, headers: {}, response: { maxItems: 1 } } },
      { kind: 'mcp', tool: 'cancel_order' },
    ];
    for (const target of targets) {
      const h = hook();
      expect(await call({ target, beforeSend: h.beforeSend })).toEqual({ result: 'not_sent', code: 'mapping', durationMs: 0 });
      expect(h.seen).toEqual([]);
    }
    expect(up.requests).toEqual([]);
  });

  it('EXE-4 an argument the mapping cannot place is not sent', async () => {
    const h = hook();
    const r = await call({ args: { payload: {} }, beforeSend: h.beforeSend });
    expect(r).toEqual({ result: 'not_sent', code: 'mapping', durationMs: 0 });
    expect(h.seen).toEqual([]);
    expect(up.requests).toEqual([]);
  });

  it('EXE-4 a header value node would refuse is not sent and beforeSend is not called', async () => {
    const h = hook();
    const mapping: UpstreamMapping = { ...MAPPING, headers: { 'x-reason': { arg: 'reason' } } };
    const r = await call({ target: { kind: 'http', mapping }, args: { ...ARGS, reason: 'a\r\nb' }, beforeSend: h.beforeSend });
    expect(r).toEqual({ result: 'not_sent', code: 'mapping', durationMs: 0 });
    expect(h.seen).toEqual([]);
    expect(up.requests).toEqual([]);
  });

  it('EXE-4 CONN-3 CONN-5 credential and egress refusals are not sent and beforeSend is not called', async () => {
    const cases: [Partial<CallInput>, string][] = [
      [{ connection: settings({ auth: { scheme: 'bearer' } }) }, 'credential_missing'],
      [{ connection: settings({ auth: { scheme: 'bearer' } }), credential: cred('bearer', { token: 'bad\ntoken' }) }, 'credential_unusable'],
      [{ connection: settings({ allowPrivateNetwork: false }) }, 'egress_denied'],
    ];
    for (const [over, code] of cases) {
      const h = hook();
      expect(await call({ ...over, beforeSend: h.beforeSend })).toEqual({ result: 'not_sent', code, durationMs: ANY_MS });
      expect(h.seen).toEqual([]);
    }
    expect(up.requests).toEqual([]);
  });

  it('EXE-4 CONN-3 a token endpoint failure before the hook is not sent', async () => {
    up.route('POST', '/token', () => ({ status: 503, body: {} }));
    const h = hook();
    const r = await call({
      connection: settings({ auth: { scheme: 'oauth_client_credentials', tokenUrl: `${up.url}/token`, scopes: [] } }),
      credential: cred('oauth_client_credentials', { client_id: 'id', client_secret: 'secret' }),
      beforeSend: h.beforeSend,
    });
    expect(r).toMatchObject({ result: 'not_sent', code: 'http_status' });
    expect(r.status).toBeUndefined();
    expect(h.seen).toEqual([]);
    expect(up.requests.map((x) => x.path)).toEqual(['/token']);
  });

  it('SEC-3 the outcome carries no upstream text', async () => {
    const secret = 'upstream-detail-7f3a: order is locked';
    for (const response of [
      { status: 200, body: { message: secret } },
      { status: 422, body: { message: secret } },
      { status: 500, body: secret },
    ]) {
      up.route('POST', '/rest/V1/orders/42/cancel', () => response);
      const outcome = await call();
      expect(JSON.stringify(outcome)).not.toContain('upstream-detail-7f3a');
      expect(Object.keys(outcome).sort()).toEqual(
        outcome.result === 'accepted' ? ['durationMs', 'result', 'status'] : ['code', 'durationMs', 'result', 'status'],
      );
    }
  });
});

describe('CONN-9 callOnce http_multipart', () => {
  const MP_MAPPING = {
    method: 'POST',
    path: '/upload/{id}',
    pathParams: { id: { arg: 'id' } },
    query: {},
    headers: {},
    body: { arg: 'fields' },
    response: { maxItems: 1 },
    idempotency: { header: 'Idempotency-Key' },
  } satisfies UpstreamMapping;
  // Bytes below 0x80: the fake upstream records the body as UTF-8 text.
  const CONTENT = new Uint8Array([1, 2, 3, 65, 66, 13, 10]);
  const PART = { name: 'attachment', filename: 'a.png', mediaType: 'image/png', content: CONTENT };
  const MP_ARGS = { id: '7', fields: { note: 'hi', n: 3, flag: true } };

  /** Parses the multipart body as an upstream would; Node's parser is the independent reader here. */
  async function parse(body: string, contentType: string): Promise<FormData> {
    // eslint-disable-next-line @typescript-eslint/no-deprecated -- test-side parsing of a captured body
    return new Response(body, { headers: { 'content-type': contentType } }).formData();
  }

  function mpCall(over: Partial<CallInput> & { mapping?: UpstreamMapping; parts?: (typeof PART)[] } = {}): ReturnType<typeof call> {
    const { mapping = MP_MAPPING, parts = [PART], ...rest } = over;
    return call({ target: { kind: 'http_multipart', mapping, parts }, args: MP_ARGS, ...rest });
  }

  it('CONN-9 sends one multipart request with its content type, length, key header and parts', async () => {
    up.route('POST', '/upload/7', () => ({ status: 201, body: { ok: true } }));
    const h = hook();
    const r = await mpCall({ beforeSend: h.beforeSend });
    expect(r).toEqual({ result: 'accepted', status: 201, durationMs: ANY_MS });
    expect(up.requests).toHaveLength(1);
    const req = up.requests[0];
    const contentType = req?.headers['content-type'] ?? '';
    expect(contentType).toMatch(/^multipart\/form-data; boundary=mandate-[0-9a-f]{32}$/);
    expect(req?.headers['content-length']).toBe(String(Buffer.byteLength(req?.body ?? '')));
    expect(req?.headers['idempotency-key']).toBe('cs-1:call');
    expect(req?.headers.accept).toBe('application/json');
    expect(h.seen).toEqual([0]);
    const form = await parse(req?.body ?? '', contentType);
    expect(form.get('note')).toBe('hi');
    expect(form.get('n')).toBe('3');
    expect(form.get('flag')).toBe('true');
    const file = form.get('attachment');
    if (!(file instanceof File)) throw new Error('attachment is not a file');
    expect(file.name).toBe('a.png');
    expect(file.type).toBe('image/png');
    expect([...new Uint8Array(await file.arrayBuffer())]).toEqual([...CONTENT]);
  });

  it('CONN-9 without a body template there are only file parts', async () => {
    up.route('POST', '/upload/7', () => ({ status: 200, body: {} }));
    const noBody: UpstreamMapping = { ...MP_MAPPING };
    delete noBody.body;
    const r = await mpCall({ mapping: noBody });
    expect(r).toMatchObject({ result: 'accepted' });
    const contentType = up.requests[0]?.headers['content-type'] ?? '';
    const form = await parse(up.requests[0]?.body ?? '', contentType);
    expect([...form.keys()]).toEqual(['attachment']);
  });

  it.each([
    ['a nested object', { id: '7', fields: { a: { b: 1 } } }],
    ['an array', { id: '7', fields: [1, 2] }],
    ['a null value', { id: '7', fields: { a: null } }],
    ['a field name with a space', { id: '7', fields: { 'a b': 'x' } }],
  ])('CONN-9 a body template rendering %s is not sent and beforeSend is not called', async (_n, args) => {
    const h = hook();
    expect(await mpCall({ args, beforeSend: h.beforeSend })).toEqual({ result: 'not_sent', code: 'mapping', durationMs: 0 });
    expect(h.seen).toEqual([]);
    expect(up.requests).toEqual([]);
  });

  it('CONN-9 empty parts are not sent', async () => {
    const h = hook();
    expect(await mpCall({ parts: [], beforeSend: h.beforeSend })).toEqual({ result: 'not_sent', code: 'mapping', durationMs: 0 });
    expect(h.seen).toEqual([]);
    expect(up.requests).toEqual([]);
  });

  it('CONN-9 a GET or bulk mapping is not sent', async () => {
    expect(await mpCall({ mapping: { ...MP_MAPPING, method: 'GET' } })).toMatchObject({ result: 'not_sent', code: 'mapping' });
    expect(up.requests).toEqual([]);
  });

  it.each([
    [200, 'accepted'],
    [422, 'refused'],
    [500, 'unknown'],
  ] as const)('CONN-9 status %i is %s with exactly one request', async (status, result) => {
    up.route('POST', '/upload/7', () => ({ status, body: {} }));
    expect((await mpCall()).result).toBe(result);
    expect(up.requests).toHaveLength(1);
  });

  it('CONN-9 a timeout is unknown and the request is not repeated', async () => {
    up.route('POST', '/upload/7', () => ({ status: 200, body: {}, delayMs: 500 }));
    expect(await mpCall({ connection: settings({ timeoutMs: 100 }) })).toEqual({ result: 'unknown', code: 'timeout', durationMs: ANY_MS });
    expect(up.requests).toHaveLength(1);
  });

  it('CONN-9 beforeSend throwing sends nothing', async () => {
    const fenced = new Error('batch fenced');
    await expect(mpCall({ beforeSend: () => Promise.reject(fenced) })).rejects.toBe(fenced);
    expect(up.requests).toEqual([]);
  });
});
