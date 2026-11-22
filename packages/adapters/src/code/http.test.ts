// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Mandate Authors
import type { CodeHttpRequest, ConnectionSettings, CredentialSource } from '@mandate/connector-sdk';
import { startFakeUpstream, type FakeUpstream } from '@mandate/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createConnectionClient } from '../http/client.js';
import { clearTokenCache } from '../http/oauth.js';
import { createCodeHttpClient } from './http.js';

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
    id: `code-http-${seq}`,
    baseUrl: `${up.url}/api`,
    timeoutMs: 2000,
    retry: { maxAttempts: 3, initialBackoffMs: 1 },
    maxConcurrency: 4,
    allowPrivateNetwork: true,
    extraHosts: [],
    ...over,
  };
}

const TOKEN = 'code-http-token-0123456789';
const bearer: CredentialSource = { ref: 'code-cred', scheme: 'bearer', open: () => Promise.resolve({ token: TOKEN }) };

function httpFor(connection: ConnectionSettings, over: { credential?: CredentialSource; signal?: AbortSignal; maxRequests?: number; onSend?: () => void } = {}) {
  return createCodeHttpClient({
    client: createConnectionClient(connection),
    connection,
    signal: over.signal ?? new AbortController().signal,
    maxRequests: over.maxRequests ?? 1000,
    ...(over.credential === undefined ? {} : { credential: over.credential }),
    ...(over.onSend === undefined ? {} : { onSend: over.onSend }),
  });
}

describe('OPS-5 CONN-5 SEC-2 code http client', () => {
  it('OPS-5 sends relative to the base URL with query arrays, JSON body and the credential; the code never sees it', async () => {
    up.route('POST', '/api/items/a%2Fb', () => ({ status: 201, body: { id: 'x', echoed: TOKEN } }));
    let sends = 0;
    const http = httpFor(settings({ auth: { scheme: 'bearer' } }), { credential: bearer, onSend: () => (sends += 1) });
    const r = await http.send({ method: 'POST', path: '/items/a%2Fb', query: { tag: ['a', 'b'], n: 2, on: true }, body: { title: 't' } });
    // The client scrubs the credential from what the code receives (SEC-3).
    expect(r).toEqual({ ok: true, status: 201, json: { id: 'x', echoed: '[REDACTED]' } });
    expect(sends).toBe(1);
    const req = up.requests[0];
    expect(req?.path).toBe('/api/items/a%2Fb');
    expect(req?.query.getAll('tag')).toEqual(['a', 'b']);
    expect(req?.query.get('n')).toBe('2');
    expect(req?.query.get('on')).toBe('true');
    expect(req?.body).toBe('{"title":"t"}');
    expect(req?.headers['content-type']).toBe('application/json');
    expect(req?.headers.authorization).toBe(`Bearer ${TOKEN}`);
    // The code's view of the client carries nothing of the credential.
    expect(JSON.stringify(Object.entries(http))).not.toContain(TOKEN);
  });

  it('OPS-5 refuses unsafe paths without sending', async () => {
    const http = httpFor(settings());
    const paths = [
      '../x',
      '/a/../b',
      '/a/%2e%2e/b',
      '//evil.example/x',
      '/x?y=1',
      '/x#f',
      'http://evil.example/x',
      '/a\\b',
      `/${'a'.repeat(2048)}`,
      '/%E0%A4%A',
      '/a/./b',
      '/a b',
    ];
    expect(paths[8]?.length).toBe(2049);
    for (const path of paths) {
      expect(await http.send({ method: 'GET', path }), path).toEqual({ ok: false, code: 'mapping' });
    }
    expect(up.requests.length).toBe(0);
  });

  it('OPS-5 refuses bad methods, query values, header names and values and unserialisable bodies without sending', async () => {
    const http = httpFor(settings());
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    const bad: unknown[] = [
      { method: 'TRACE', path: '/x' },
      { method: 'GET', path: '/x', query: { a: { nested: 1 } } },
      { method: 'GET', path: '/x', query: { a: [1, [2]] } },
      { method: 'GET', path: '/x', query: { a: null } },
      { method: 'GET', path: '/x', headers: { 'bad name': 'v' } },
      { method: 'GET', path: '/x', headers: { 'x-a': 'line\r\nbreak' } },
      { method: 'GET', path: '/x', headers: { 'x-a': 1 } },
      { method: 'POST', path: '/x', body: cyclic },
      { method: 'POST', path: '/x', body: 10n },
      null,
      'GET /x',
    ];
    for (const request of bad) {
      expect(await http.send(request as CodeHttpRequest)).toEqual({ ok: false, code: 'mapping' });
    }
    expect(up.requests.length).toBe(0);
  });

  it('SEC-2 an authorization or cookie header from code is dropped and the api_key header is overwritten', async () => {
    up.route('GET', '/api/x', () => ({ status: 200, body: {} }));
    const connection = settings({ auth: { scheme: 'api_key', header: 'X-Api-Key' } });
    const credential: CredentialSource = { ref: 'k', scheme: 'api_key', open: () => Promise.resolve({ key: 'real-key-0123456789' }) };
    const r = await httpFor(connection, { credential }).send({
      method: 'GET',
      path: '/x',
      headers: { Authorization: 'Bearer stolen', Cookie: 's=1', 'X-API-KEY': 'forged', Host: 'evil.example', 'X-Trace': 'kept' },
    });
    expect(r.ok).toBe(true);
    const headers = up.requests[0]?.headers ?? {};
    expect(headers.authorization).toBeUndefined();
    expect(headers.cookie).toBeUndefined();
    expect(headers['x-api-key']).toBe('real-key-0123456789');
    expect(headers.host).not.toBe('evil.example');
    expect(headers['x-trace']).toBe('kept');
  });

  it('CONN-6 GET is retried on 503 and PATCH is not', async () => {
    let gets = 0;
    up.route('GET', '/api/r', () => {
      gets += 1;
      return gets === 1 ? { status: 503 } : { status: 200, body: { ok: 1 } };
    });
    up.route('PATCH', '/api/r', () => ({ status: 503 }));
    const http = httpFor(settings());
    expect(await http.send({ method: 'GET', path: '/r' })).toEqual({ ok: true, status: 200, json: { ok: 1 } });
    expect(await http.send({ method: 'PATCH', path: '/r', body: {} })).toEqual({ ok: false, code: 'http_status', status: 503 });
    expect(up.requests.filter((r) => r.method === 'GET')).toHaveLength(2);
    expect(up.requests.filter((r) => r.method === 'PATCH')).toHaveLength(1);
  });

  it('OPS-5 the 1001st send answers busy without a request', async () => {
    up.route('GET', '/api/x', () => ({ status: 200, body: {} }));
    const http = httpFor(settings(), { maxRequests: 1000 });
    // Refused requests count too: the limit bounds the calls a code operation makes.
    for (let i = 0; i < 1000; i += 1) expect(await http.send({ method: 'GET', path: '../x' })).toEqual({ ok: false, code: 'mapping' });
    expect(await http.send({ method: 'GET', path: '/x' })).toEqual({ ok: false, code: 'busy' });
    expect(up.requests.length).toBe(0);
  });

  it('OPS-5 an aborted signal answers timeout without a request', async () => {
    up.route('GET', '/api/x', () => ({ status: 200, body: {} }));
    const controller = new AbortController();
    const http = httpFor(settings(), { signal: controller.signal });
    controller.abort();
    expect(await http.send({ method: 'GET', path: '/x' })).toEqual({ ok: false, code: 'timeout' });
    expect(await http.send({ method: 'POST', path: '/x', body: {} })).toEqual({ ok: false, code: 'timeout' });
    expect(up.requests.length).toBe(0);
  });

  it('OPS-5 a write queued for a connection slot when the signal aborts is never sent and answers timeout', async () => {
    up.route('PUT', '/api/slow', () => ({ status: 200, body: {}, delayMs: 1000 }));
    up.route('PUT', '/api/queued', () => ({ status: 200, body: {} }));
    const controller = new AbortController();
    const http = httpFor(settings({ maxConcurrency: 1, timeoutMs: 5000 }), { signal: controller.signal });
    const slow = http.send({ method: 'PUT', path: '/slow', body: {} });
    // The slow write holds the only slot once the upstream has it.
    await vi.waitFor(() => {
      expect(up.requests).toHaveLength(1);
    });
    // Entered before the abort: it passes the entry check and waits for the slot.
    const queued = http.send({ method: 'PUT', path: '/queued', body: {} });
    controller.abort();
    expect(await slow).toEqual({ ok: true, status: 200, json: {} });
    expect(await queued).toEqual({ ok: false, code: 'timeout' });
    expect(up.requests.map((r) => r.path)).toEqual(['/api/slow']);
  });

  it('SEC-3 a non-2xx answer carries the status only, never the body', async () => {
    up.route('PUT', '/api/x', () => ({ status: 422, body: { error: 'secret upstream detail' } }));
    const r = await httpFor(settings()).send({ method: 'PUT', path: '/x', body: {} });
    expect(r).toEqual({ ok: false, code: 'http_status', status: 422 });
    expect(JSON.stringify(r)).not.toContain('secret upstream detail');
  });
});
