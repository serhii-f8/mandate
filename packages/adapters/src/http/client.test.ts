// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Mandate Authors
import type { ConnectionSettings, CredentialSource, RequestAttempt, RequestAttemptEnd, RequestInstrumentation } from '@mandate/connector-sdk';
import { startFakeUpstream, type FakeUpstream } from '@mandate/testing';
import { createHmac } from 'node:crypto';
import { createServer, type Server } from 'node:net';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { HttpRequestSpec } from '../openapi/request.js';
import { createConnectionClient } from './client.js';
import { createGuardedLookup } from './egress.js';
import { clearTokenCache, lastTokenScopes } from './oauth.js';
import { semaphoreFor } from './semaphore.js';

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
    id: `conn-${seq}`,
    baseUrl: up.url,
    timeoutMs: 2000,
    retry: { maxAttempts: 3, initialBackoffMs: 100 },
    maxConcurrency: 4,
    allowPrivateNetwork: true,
    extraHosts: [],
    ...over,
  };
}

/** RFC 3986 encoding as RFC 5849 section 3.6 asks, written independently of the signer. */
function rfc3986(value: string): string {
  return encodeURIComponent(value).replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
}

/**
 * An OAuth 1.0a HMAC-SHA256 verifier as an upstream would run it (RFC 5849 sections 3.4.1, 3.4.2):
 * the oauth parameters come from the Authorization header, the query from the received URL.
 */
function verifyOauth1(
  method: string,
  baseUri: string,
  query: URLSearchParams,
  header: string,
  secrets: { consumer_secret: string; token_secret: string },
): boolean {
  if (!header.startsWith('OAuth ')) return false;
  const oauth = new Map<string, string>();
  for (const m of header.slice(6).matchAll(/([a-z_]+)="([^"]*)"/g)) oauth.set(m[1] ?? '', decodeURIComponent(m[2] ?? ''));
  const signature = oauth.get('oauth_signature');
  if (signature === undefined || oauth.get('oauth_signature_method') !== 'HMAC-SHA256') return false;
  const pairs: [string, string][] = [...query.entries(), ...[...oauth].filter(([k]) => k !== 'oauth_signature')].map(([k, v]) => [rfc3986(k), rfc3986(v)]);
  pairs.sort(([ak, av], [bk, bv]) => (ak === bk ? (av < bv ? -1 : av > bv ? 1 : 0) : ak < bk ? -1 : 1));
  const normalized = pairs.map(([k, v]) => `${k}=${v}`).join('&');
  const base = [method.toUpperCase(), rfc3986(baseUri), rfc3986(normalized)].join('&');
  const key = `${rfc3986(secrets.consumer_secret)}&${rfc3986(secrets.token_secret)}`;
  return createHmac('sha256', key).update(base).digest('base64') === signature;
}

function get(path = '/items', base = up.url): HttpRequestSpec {
  return { method: 'GET', url: new URL(base + path), headers: { accept: 'application/json' } };
}

function cred(scheme: CredentialSource['scheme'], material: Record<string, string>): CredentialSource {
  return { ref: 'test-cred', scheme, open: () => Promise.resolve(material) };
}

const noSleep = { sleep: () => Promise.resolve() };

describe('CONN-3 credential injection', () => {
  beforeEach(() => {
    up.route('GET', '/items', () => ({ status: 200, body: { ok: 1 } }));
  });

  it('CONN-3 bearer sends Authorization: Bearer', async () => {
    const c = createConnectionClient(settings({ auth: { scheme: 'bearer' } }));
    const r = await c.send(get(), { credential: cred('bearer', { token: 'tok-1' }), retryable: false });
    expect(r).toMatchObject({ ok: true, status: 200, json: { ok: 1 } });
    expect(up.requests[0]?.headers.authorization).toBe('Bearer tok-1');
  });

  it('CONN-3 api_key sends the configured header and no Authorization', async () => {
    const c = createConnectionClient(settings({ auth: { scheme: 'api_key', header: 'X-Api-Key' } }));
    const r = await c.send(get(), { credential: cred('api_key', { key: 'key-1' }), retryable: false });
    expect(r.ok).toBe(true);
    expect(up.requests[0]?.headers['x-api-key']).toBe('key-1');
    expect(up.requests[0]?.headers.authorization).toBeUndefined();
  });

  it('CONN-3 basic sends Authorization: Basic base64(user:pass)', async () => {
    const c = createConnectionClient(settings({ auth: { scheme: 'basic' } }));
    const r = await c.send(get(), { credential: cred('basic', { username: 'user', password: 'p:w' }), retryable: false });
    expect(r.ok).toBe(true);
    expect(up.requests[0]?.headers.authorization).toBe(`Basic ${Buffer.from('user:p:w').toString('base64')}`);
  });

  it('CONN-3 oauth1 signs the exact URL sent and a retry gets a fresh nonce and the same signed URL', async () => {
    let calls = 0;
    up.route('GET', '/items', () => {
      calls += 1;
      return calls === 1 ? { status: 503, body: {} } : { status: 200, body: { ok: 1 } };
    });
    const c = createConnectionClient(settings({ auth: { scheme: 'oauth1', signatureMethod: 'HMAC-SHA256' } }), noSleep);
    const material = { consumer_key: 'ck-1', consumer_secret: 'sentinel-cs', token: 'tk-1', token_secret: 'sentinel-ts' };
    const r = await c.send(get('/items?q=a b&z=1'), { credential: cred('oauth1', material), retryable: true });
    expect(r.ok).toBe(true);
    const headers = up.requests.map((q) => q.headers.authorization ?? '');
    expect(headers).toHaveLength(2);
    expect(up.requests.every((q) => q.path === '/items')).toBe(true);
    const nonce = (h: string): string | undefined => /oauth_nonce="([^"]+)"/.exec(h)?.[1];
    expect(nonce(headers[0] ?? '')).toBeDefined();
    expect(nonce(headers[0] ?? '')).not.toBe(nonce(headers[1] ?? ''));
    expect(headers.join('\n')).not.toContain('sentinel');
    // The fake upstream's side: recompute the signature over what it received (both attempts).
    for (const request of up.requests) {
      const header = request.headers.authorization ?? '';
      const host = request.headers.host ?? '';
      expect(verifyOauth1(request.method, `http://${host}${request.path}`, request.query, header, material)).toBe(true);
      // The same header over another query does not verify, so the check is not vacuous.
      expect(verifyOauth1(request.method, `http://${host}${request.path}`, new URLSearchParams('q=a&z=1'), header, material)).toBe(false);
    }
  });

  it('CONN-9 oauth1 signs a multipart request over method, URL and query only (RFC 5849 3.4.1.3: no body parameters)', async () => {
    up.route('POST', '/upload', () => ({ status: 200, body: { ok: 1 } }));
    const c = createConnectionClient(settings({ auth: { scheme: 'oauth1', signatureMethod: 'HMAC-SHA256' } }), noSleep);
    const material = { consumer_key: 'ck-1', consumer_secret: 'sentinel-cs', token: 'tk-1', token_secret: 'sentinel-ts' };
    // A part that looks like form parameters must not enter the signature base string.
    const body = Buffer.from('--B\r\nContent-Disposition: form-data; name="x"\r\n\r\nq=1&oauth_nonce=forged\r\n--B--\r\n');
    const r = await c.send(
      {
        method: 'POST',
        url: new URL(`${up.url}/upload?q=a b`),
        headers: { accept: 'application/json', 'content-type': 'multipart/form-data; boundary=B' },
        body: new Uint8Array(body),
      },
      { credential: cred('oauth1', material), retryable: false },
    );
    expect(r.ok).toBe(true);
    const request = up.requests[0];
    expect(request?.headers['content-length']).toBe(String(body.length));
    expect(verifyOauth1('POST', `http://${request?.headers.host ?? ''}/upload`, request?.query ?? new URLSearchParams(), request?.headers.authorization ?? '', material)).toBe(true);
  });

  it('CONN-3 no auth configured sends no credential', async () => {
    const c = createConnectionClient(settings());
    const r = await c.send(get(), { retryable: false });
    expect(r.ok).toBe(true);
    expect(up.requests[0]?.headers.authorization).toBeUndefined();
  });

  it('CONN-3 auth configured but no credential is credential_missing and nothing is sent', async () => {
    const c = createConnectionClient(settings({ auth: { scheme: 'bearer' } }));
    const r = await c.send(get(), { retryable: false });
    expect(r).toMatchObject({ ok: false, code: 'credential_missing' });
    expect(up.requests).toHaveLength(0);
  });

  it('CONN-3 open() failing is credential_unusable and the error text is not echoed', async () => {
    const c = createConnectionClient(settings({ auth: { scheme: 'bearer' } }));
    const broken: CredentialSource = { ref: 'x', scheme: 'bearer', open: () => Promise.reject(new Error('decrypt failed for s3cr3t')) };
    const r = await c.send(get(), { credential: broken, retryable: false });
    expect(r).toMatchObject({ ok: false, code: 'credential_unusable' });
    if (!r.ok) expect(r.message).not.toContain('s3cr3t');
    expect(up.requests).toHaveLength(0);
  });

  it('CONN-3 material of the wrong shape or scheme is credential_unusable', async () => {
    const c = createConnectionClient(settings({ auth: { scheme: 'basic' } }));
    expect(await c.send(get(), { credential: cred('basic', { username: 'u' }), retryable: false })).toMatchObject({ ok: false, code: 'credential_unusable' });
    expect(await c.send(get(), { credential: cred('bearer', { token: 't' }), retryable: false })).toMatchObject({ ok: false, code: 'credential_unusable' });
    expect(up.requests).toHaveLength(0);
  });

  describe('CONN-3 oauth_client_credentials', () => {
    let issued = 0;
    beforeEach(() => {
      issued = 0;
      up.route('POST', '/token', () => {
        issued += 1;
        return { status: 200, body: { access_token: `issued-${issued}`, token_type: 'Bearer', expires_in: 3600, scope: 'catalog.read orders.read' } };
      });
    });
    const oauth = (): ConnectionSettings => settings({ auth: { scheme: 'oauth_client_credentials', tokenUrl: `${up.url}/token`, scopes: ['catalog.read', 'orders.read'] } });
    const client = cred('oauth_client_credentials', { client_id: 'id:1', client_secret: 's&cret' });

    it('CONN-3 fetches a token once for two requests and sends it as Bearer', async () => {
      const c = createConnectionClient(oauth());
      expect((await c.send(get(), { credential: client, retryable: false })).ok).toBe(true);
      expect((await c.send(get(), { credential: client, retryable: false })).ok).toBe(true);
      const tokenCalls = up.requests.filter((r) => r.path === '/token');
      expect(tokenCalls).toHaveLength(1);
      const items = up.requests.filter((r) => r.path === '/items');
      expect(items.map((r) => r.headers.authorization)).toEqual(['Bearer issued-1', 'Bearer issued-1']);
    });

    it('CONN-3 token request is client_secret_basic with grant_type and scope (RFC 6749 2.3.1)', async () => {
      const s = oauth();
      const c = createConnectionClient(s);
      await c.send(get(), { credential: client, retryable: false });
      const t = up.requests.find((r) => r.path === '/token');
      expect(t?.headers['content-type']).toBe('application/x-www-form-urlencoded');
      expect(t?.headers.authorization).toBe(`Basic ${Buffer.from('id%3A1:s%26cret').toString('base64')}`);
      const form = new URLSearchParams(t?.body);
      expect(form.get('grant_type')).toBe('client_credentials');
      expect(form.get('scope')).toBe('catalog.read orders.read');
      expect(form.has('client_secret')).toBe(false);
      expect(lastTokenScopes(s.id)).toEqual(['catalog.read', 'orders.read']);
    });

    it('CONN-3 refetches the token once after an upstream 401', async () => {
      let n = 0;
      up.route('GET', '/items', () => {
        n += 1;
        return n === 1 ? { status: 401, body: { error: 'expired' } } : { status: 200, body: { ok: 1 } };
      });
      const c = createConnectionClient(oauth());
      const r = await c.send(get(), { credential: client, retryable: false });
      expect(r.ok).toBe(true);
      expect(up.requests.filter((x) => x.path === '/token')).toHaveLength(2);
      expect(up.requests.filter((x) => x.path === '/items').map((x) => x.headers.authorization)).toEqual(['Bearer issued-1', 'Bearer issued-2']);
    });

    it('CONN-3 a 401 that persists after the refresh is http_status 401', async () => {
      up.route('GET', '/items', () => ({ status: 401, body: {} }));
      const c = createConnectionClient(oauth());
      const r = await c.send(get(), { credential: client, retryable: true });
      expect(r).toMatchObject({ ok: false, code: 'http_status', status: 401 });
      expect(up.requests.filter((x) => x.path === '/token')).toHaveLength(2);
      expect(up.requests.filter((x) => x.path === '/items')).toHaveLength(2);
    });

    it('CONN-3 the cached token is renewed 30 s before expires_in', async () => {
      up.route('POST', '/token', () => {
        issued += 1;
        return { status: 200, body: { access_token: `issued-${issued}`, expires_in: 60 } };
      });
      let clock = 1_000_000;
      const c = createConnectionClient(oauth(), { now: () => clock });
      await c.send(get(), { credential: client, retryable: false });
      clock += 29_000;
      await c.send(get(), { credential: client, retryable: false });
      expect(issued).toBe(1);
      clock += 2_000; // 31 s after issue: inside the 30 s margin of a 60 s token
      await c.send(get(), { credential: client, retryable: false });
      expect(issued).toBe(2);
    });

    it('CONN-3 a token endpoint refusal is credential_unusable with its status', async () => {
      up.route('POST', '/token', () => ({ status: 401, body: { error: 'invalid_client' } }));
      const c = createConnectionClient(oauth());
      const r = await c.send(get(), { credential: client, retryable: false });
      expect(r).toMatchObject({ ok: false, code: 'credential_unusable', status: 401 });
      expect(up.requests.filter((x) => x.path === '/items')).toHaveLength(0);
    });

    it('CONN-3 a token response without access_token is invalid_response', async () => {
      up.route('POST', '/token', () => ({ status: 200, body: { token_type: 'Bearer' } }));
      const c = createConnectionClient(oauth());
      const r = await c.send(get(), { credential: client, retryable: false });
      expect(r).toMatchObject({ ok: false, code: 'invalid_response' });
    });

    it('CONN-5 a token URL on a refused address is egress_denied before connecting', async () => {
      const s = settings({ allowPrivateNetwork: false, auth: { scheme: 'oauth_client_credentials', tokenUrl: `${up.url}/token`, scopes: [] } });
      const c = createConnectionClient(s);
      const r = await c.send(get(), { credential: client, retryable: false });
      expect(r).toMatchObject({ ok: false, code: 'egress_denied' });
      expect(up.requests).toHaveLength(0);
    });
  });
});

describe('CONN-6 timeout, retry and concurrency', () => {
  it('CONN-6 503 twice then 200 succeeds after 3 attempts with exponential, jittered backoff', async () => {
    let n = 0;
    up.route('GET', '/items', () => {
      n += 1;
      return n < 3 ? { status: 503, body: {} } : { status: 200, body: { done: true } };
    });
    const sleeps: number[] = [];
    const c = createConnectionClient(settings(), {
      sleep: (ms) => {
        sleeps.push(ms);
        return Promise.resolve();
      },
      random: () => 0.5,
    });
    const r = await c.send(get(), { retryable: true });
    expect(r).toMatchObject({ ok: true, json: { done: true } });
    expect(up.requests).toHaveLength(3);
    expect(sleeps).toEqual([50, 100]);
  });

  it.each([
    ['2', 2000],
    ['60', 10_000],
  ])('CONN-6 Retry-After: %s sleeps %i ms', async (header, expected) => {
    let n = 0;
    up.route('GET', '/items', () => {
      n += 1;
      return n === 1 ? { status: 429, headers: { 'retry-after': header }, body: {} } : { status: 200, body: {} };
    });
    const sleeps: number[] = [];
    // The sleep advances the injected clock, so the Retry-After hold is over when the retry is paced.
    let t = 1_000_000;
    const c = createConnectionClient(settings({ timeoutMs: 20_000 }), {
      now: () => t,
      sleep: (ms) => {
        sleeps.push(ms);
        t += ms;
        return Promise.resolve();
      },
    });
    expect((await c.send(get(), { retryable: true })).ok).toBe(true);
    expect(sleeps).toEqual([expected]);
  });

  it('CONN-6 Retry-After as an HTTP date is measured with the injected clock', async () => {
    const clock = Date.parse('Wed, 01 Jan 2031 00:00:00 GMT');
    up.route('GET', '/items', () => ({ status: 503, headers: { 'retry-after': new Date(clock + 5000).toUTCString() }, body: {} }));
    const sleeps: number[] = [];
    const c = createConnectionClient(settings({ retry: { maxAttempts: 2, initialBackoffMs: 100 } }), {
      now: () => clock,
      sleep: (ms) => {
        sleeps.push(ms);
        return Promise.resolve();
      },
    });
    await c.send(get(), { retryable: true });
    expect(sleeps).toEqual([5000]);
  });

  it('CONN-6 503 on every attempt is http_status 503 after max_attempts', async () => {
    up.route('GET', '/items', () => ({ status: 503, body: {} }));
    const c = createConnectionClient(settings(), noSleep);
    const r = await c.send(get(), { retryable: true });
    expect(r).toMatchObject({ ok: false, code: 'http_status', status: 503 });
    expect(up.requests).toHaveLength(3);
  });

  it('CONN-6 retryable: false makes one attempt', async () => {
    up.route('GET', '/items', () => ({ status: 503, body: {} }));
    const c = createConnectionClient(settings(), noSleep);
    const r = await c.send(get(), { retryable: false });
    expect(r).toMatchObject({ ok: false, code: 'http_status', status: 503 });
    expect(up.requests).toHaveLength(1);
  });

  it('CONN-6 a non-retryable status (400) is not retried', async () => {
    up.route('GET', '/items', () => ({ status: 400, body: {} }));
    const c = createConnectionClient(settings(), noSleep);
    expect(await c.send(get(), { retryable: true })).toMatchObject({ ok: false, code: 'http_status', status: 400 });
    expect(up.requests).toHaveLength(1);
  });

  it('CONN-6 a slow upstream is a timeout after timeout_ms', async () => {
    up.route('GET', '/items', () => ({ status: 200, body: {}, delayMs: 500 }));
    const c = createConnectionClient(settings({ timeoutMs: 100 }));
    const t0 = Date.now();
    const r = await c.send(get(), { retryable: false });
    expect(r).toMatchObject({ ok: false, code: 'timeout' });
    expect(Date.now() - t0).toBeLessThan(400);
  });

  it('CONN-6 timeouts are retried for reads', async () => {
    up.route('GET', '/items', () => ({ status: 200, body: {}, delayMs: 300 }));
    const c = createConnectionClient(settings({ timeoutMs: 50, retry: { maxAttempts: 2, initialBackoffMs: 1 } }), noSleep);
    expect(await c.send(get(), { retryable: true })).toMatchObject({ ok: false, code: 'timeout' });
    expect(up.requests).toHaveLength(2);
  });

  it('CONN-6 a refused connection is network and is retried', async () => {
    const closed = await startFakeUpstream();
    const url = closed.url;
    await closed.close();
    const c = createConnectionClient(settings({ baseUrl: url, retry: { maxAttempts: 2, initialBackoffMs: 1 } }), noSleep);
    const r = await c.send(get('/items', url), { retryable: true });
    expect(r).toMatchObject({ ok: false, code: 'network' });
  });

  it('CONN-6 max_concurrency 1: the upstream never sees two requests in flight', async () => {
    up.route('GET', '/items', () => ({ status: 200, body: {}, delayMs: 80 }));
    const c = createConnectionClient(settings({ maxConcurrency: 1 }));
    const rs = await Promise.all([c.send(get(), { retryable: false }), c.send(get(), { retryable: false })]);
    expect(rs.every((r) => r.ok)).toBe(true);
    expect(up.requests).toHaveLength(2);
    expect(up.maxInFlight).toBe(1);
  });

  it('CONN-6 waiting for a slot counts against timeout_ms and ends as busy', async () => {
    up.route('GET', '/items', () => ({ status: 200, body: {} }));
    const s = settings({ maxConcurrency: 1, timeoutMs: 60 });
    const held = await semaphoreFor(s.id, 1).acquire(1000);
    const c = createConnectionClient(s);
    const r = await c.send(get(), { retryable: false });
    held?.();
    expect(r).toMatchObject({ ok: false, code: 'busy' });
    expect(up.requests).toHaveLength(0);
  });
});

describe('CONN-6 pacing', () => {
  const recorder = (): { sleeps: number[]; sleep: (ms: number) => Promise<void> } => {
    const sleeps: number[] = [];
    return {
      sleeps,
      sleep: (ms) => {
        sleeps.push(ms);
        return Promise.resolve();
      },
    };
  };

  it('CONN-6 the second request of a paced connection waits for the interval', async () => {
    up.route('GET', '/items', () => ({ status: 200, body: {} }));
    const { sleeps, sleep } = recorder();
    const c = createConnectionClient(settings({ minIntervalMs: 200 }), { now: () => 1_000_000, sleep });
    expect((await c.send(get(), { retryable: false })).ok).toBe(true);
    expect(sleeps).toEqual([]);
    expect((await c.send(get(), { retryable: false })).ok).toBe(true);
    expect(sleeps).toEqual([200]);
  });

  it('CONN-6 a slot further away than timeout_ms ends as busy and sends nothing', async () => {
    up.route('GET', '/items', () => ({ status: 200, body: {} }));
    const { sleeps, sleep } = recorder();
    const c = createConnectionClient(settings({ minIntervalMs: 1000, timeoutMs: 100 }), { now: () => 1_000_000, sleep });
    expect((await c.send(get(), { retryable: false })).ok).toBe(true);
    const r = await c.send(get(), { retryable: false });
    expect(r).toMatchObject({ ok: false, code: 'busy' });
    expect(sleeps).toEqual([]);
    expect(up.requests).toHaveLength(1);
  });

  it('CONN-6 a retry attempt is paced like a first attempt', async () => {
    let n = 0;
    up.route('GET', '/items', () => {
      n += 1;
      return n === 1 ? { status: 503, body: {} } : { status: 200, body: {} };
    });
    const { sleeps, sleep } = recorder();
    const c = createConnectionClient(settings({ minIntervalMs: 200 }), { now: () => 1_000_000, sleep, random: () => 0 });
    expect((await c.send(get(), { retryable: true })).ok).toBe(true);
    // The backoff (0 with this jitter), then the pacing wait before the second attempt.
    expect(sleeps).toEqual([0, 200]);
  });

  it('CONN-6 an honoured Retry-After holds a concurrent call on the same connection', async () => {
    let n = 0;
    up.route('GET', '/items', () => {
      n += 1;
      return n === 1 ? { status: 429, headers: { 'retry-after': '2' }, body: {} } : { status: 200, body: {} };
    });
    let t = 1_000_000;
    const sleeps: number[] = [];
    const pending: (() => void)[] = [];
    const sleep = (ms: number): Promise<void> => {
      sleeps.push(ms);
      return new Promise((resolve) => pending.push(resolve));
    };
    const s = settings({ retry: { maxAttempts: 2, initialBackoffMs: 100 } });
    const a = createConnectionClient(s, { now: () => t, sleep }).send(get(), { retryable: true });
    await vi.waitFor(() => {
      expect(sleeps).toEqual([2000]);
    });
    // The pacer is shared by every client of the connection id, as in the process.
    const b = createConnectionClient(s, { now: () => t, sleep }).send(get(), { retryable: false });
    await vi.waitFor(() => {
      expect(sleeps).toEqual([2000, 2000]);
    });
    t += 2000;
    for (const release of pending) release();
    expect((await a).ok).toBe(true);
    expect((await b).ok).toBe(true);
    expect(sleeps).toEqual([2000, 2000]);
  });
});

describe('CONN-6 response handling', () => {
  it('CONN-6 a non-JSON response is invalid_response', async () => {
    up.route('GET', '/items', () => ({ status: 200, headers: { 'content-type': 'text/html' }, body: '<html></html>' }));
    const r = await createConnectionClient(settings()).send(get(), { retryable: false });
    expect(r).toMatchObject({ ok: false, code: 'invalid_response' });
  });

  it('CONN-6 a +json content type is accepted', async () => {
    up.route('GET', '/items', () => ({ status: 200, headers: { 'content-type': 'application/problem+json; charset=utf-8' }, body: '{"a":1}' }));
    expect(await createConnectionClient(settings()).send(get(), { retryable: false })).toMatchObject({ ok: true, json: { a: 1 } });
  });

  it('CONN-6 malformed JSON is invalid_response', async () => {
    up.route('GET', '/items', () => ({ status: 200, headers: { 'content-type': 'application/json' }, body: '{"a":' }));
    expect(await createConnectionClient(settings()).send(get(), { retryable: false })).toMatchObject({ ok: false, code: 'invalid_response' });
  });

  it('CONN-6 a body over 5 MB is invalid_response', async () => {
    const big = `"${'x'.repeat(5 * 1024 * 1024 + 10)}"`;
    up.route('GET', '/items', () => ({ status: 200, headers: { 'content-type': 'application/json' }, body: big }));
    expect(await createConnectionClient(settings()).send(get(), { retryable: false })).toMatchObject({ ok: false, code: 'invalid_response' });
  });

  it('CONN-6 a POST carries its JSON body', async () => {
    up.route('POST', '/items', (req) => ({ status: 200, body: { got: req.body, type: req.headers['content-type'] } }));
    const spec: HttpRequestSpec = { method: 'POST', url: new URL(`${up.url}/items`), headers: { 'content-type': 'application/json' }, body: '{"q":1}' };
    expect(await createConnectionClient(settings()).send(spec, { retryable: false })).toMatchObject({ ok: true, json: { got: '{"q":1}', type: 'application/json' } });
  });
});

describe('SEC-3 upstream echoes the credential', () => {
  it('SEC-3 an error result never contains the token', async () => {
    up.route('GET', '/items', (req) => ({ status: 500, headers: { 'x-echo': req.headers.authorization ?? '' }, body: { echo: req.headers.authorization } }));
    const c = createConnectionClient(settings({ auth: { scheme: 'bearer' } }), noSleep);
    const r = await c.send(get(), { credential: cred('bearer', { token: 'very-secret-token' }), retryable: true });
    expect(r).toMatchObject({ ok: false, code: 'http_status', status: 500 });
    expect(JSON.stringify(r)).not.toContain('very-secret-token');
  });

  it('SEC-3 a success body echoing the secret is scrubbed', async () => {
    up.route('GET', '/items', (req) => ({ status: 200, body: { echo: req.headers.authorization, b64: Buffer.from('user:pw-secret').toString('base64') } }));
    const c = createConnectionClient(settings({ auth: { scheme: 'basic' } }));
    const r = await c.send(get(), { credential: cred('basic', { username: 'user', password: 'pw-secret' }), retryable: false });
    expect(r.ok).toBe(true);
    expect(JSON.stringify(r)).not.toContain('pw-secret');
    expect(JSON.stringify(r)).not.toContain(Buffer.from('user:pw-secret').toString('base64'));
  });

  it('SEC-3 a basic username is not treated as a secret and stays readable in the body', async () => {
    up.route('GET', '/items', () => ({ status: 200, body: { owner: 'admin', note: 'pw-secret' } }));
    const c = createConnectionClient(settings({ auth: { scheme: 'basic' } }));
    const r = await c.send(get(), { credential: cred('basic', { username: 'admin', password: 'pw-secret' }), retryable: false });
    expect(r.ok).toBe(true);
    expect(JSON.stringify(r)).toContain('"owner":"admin"');
    expect(JSON.stringify(r)).not.toContain('pw-secret');
  });

  it('SEC-3 a fetched OAuth token echoed by the upstream is scrubbed', async () => {
    up.route('POST', '/token', () => ({ status: 200, body: { access_token: 'oauth-issued-secret', expires_in: 3600 } }));
    up.route('GET', '/items', (req) => ({ status: 200, body: { echo: req.headers.authorization } }));
    const c = createConnectionClient(settings({ auth: { scheme: 'oauth_client_credentials', tokenUrl: `${up.url}/token`, scopes: [] } }));
    const r = await c.send(get(), { credential: cred('oauth_client_credentials', { client_id: 'cid', client_secret: 'csecret' }), retryable: false });
    expect(r.ok).toBe(true);
    expect(JSON.stringify(r)).not.toContain('oauth-issued-secret');
  });
});

describe('CONN-5 no redirects and guarded egress', () => {
  it('CONN-5 a 302 is http_status and the Location target is never requested', async () => {
    up.route('GET', '/items', () => ({ status: 302, headers: { location: `${up.url}/elsewhere` } }));
    up.route('GET', '/elsewhere', () => ({ status: 200, body: {} }));
    const r = await createConnectionClient(settings()).send(get(), { retryable: true });
    expect(r).toMatchObject({ ok: false, code: 'http_status', status: 302 });
    expect(up.requests.map((x) => x.path)).toEqual(['/items']);
  });

  it('CONN-5 a loopback upstream without allow_private_network is egress_denied before connecting', async () => {
    up.route('GET', '/items', () => ({ status: 200, body: {} }));
    const r = await createConnectionClient(settings({ allowPrivateNetwork: false })).send(get(), { retryable: true });
    expect(r).toMatchObject({ ok: false, code: 'egress_denied' });
    expect(up.requests).toHaveLength(0);
  });

  it('CONN-5 a request to a host outside the connection is egress_denied', async () => {
    const c = createConnectionClient(settings({ baseUrl: 'http://upstream.test' }));
    const r = await c.send(get('/items'), { retryable: false });
    expect(r).toMatchObject({ ok: false, code: 'egress_denied' });
    expect(up.requests).toHaveLength(0);
  });

  it('CONN-5 host names are resolved through the guarded lookup', async () => {
    up.route('GET', '/items', () => ({ status: 200, body: { via: 'lookup' } }));
    const s = settings({ baseUrl: `http://upstream.test:${up.port}` });
    const lookup = createGuardedLookup(s, () => Promise.resolve([{ address: '127.0.0.1', family: 4 }]));
    const r = await createConnectionClient(s, { lookup }).send(get('/items', `http://upstream.test:${up.port}`), { retryable: false });
    expect(r).toMatchObject({ ok: true, json: { via: 'lookup' } });
    expect(up.requests[0]?.headers.host).toBe(`upstream.test:${up.port}`);
  });

  it('CONN-5 a host name that resolves to a refused address is egress_denied', async () => {
    const s = settings({ baseUrl: `http://upstream.test:${up.port}`, allowPrivateNetwork: false });
    const lookup = createGuardedLookup(s, () => Promise.resolve([{ address: '127.0.0.1', family: 4 }]));
    const r = await createConnectionClient(s, { lookup }).send(get('/items', `http://upstream.test:${up.port}`), { retryable: true });
    expect(r).toMatchObject({ ok: false, code: 'egress_denied' });
    expect(up.requests).toHaveLength(0);
  });
});

describe('CONN-3 unusable header values give typed results', () => {
  beforeEach(() => {
    up.route('GET', '/items', () => ({ status: 200, body: {} }));
  });

  it('CONN-3 a bearer token with a control character is credential_unusable and nothing is sent', async () => {
    const c = createConnectionClient(settings({ auth: { scheme: 'bearer' } }));
    const r = await c.send(get(), { credential: cred('bearer', { token: 'tok\n' }), retryable: false });
    expect(r).toMatchObject({ ok: false, code: 'credential_unusable' });
    expect(up.requests).toHaveLength(0);
  });

  it('CONN-3 an api key with a control character is credential_unusable', async () => {
    const c = createConnectionClient(settings({ auth: { scheme: 'api_key', header: 'x-api-key' } }));
    expect(await c.send(get(), { credential: cred('api_key', { key: 'k\u0001' }), retryable: false })).toMatchObject({ ok: false, code: 'credential_unusable' });
    expect(up.requests).toHaveLength(0);
  });

  it('CONN-3 basic is checked on the computed header value, which is Base64 and therefore sendable', async () => {
    const c = createConnectionClient(settings({ auth: { scheme: 'basic' } }));
    const r = await c.send(get(), { credential: cred('basic', { username: 'u', password: 'p\n' }), retryable: false });
    expect(r.ok).toBe(true);
  });

  it('CONN-3 an OAuth access_token with a control character is credential_unusable', async () => {
    up.route('POST', '/token', () => ({ status: 200, body: { access_token: 'a\nb', expires_in: 3600 } }));
    const c = createConnectionClient(settings({ auth: { scheme: 'oauth_client_credentials', tokenUrl: `${up.url}/token`, scopes: [] } }));
    const r = await c.send(get(), { credential: cred('oauth_client_credentials', { client_id: 'c', client_secret: 's' }), retryable: false });
    expect(r).toMatchObject({ ok: false, code: 'credential_unusable' });
    expect(up.requests.filter((x) => x.path === '/items')).toHaveLength(0);
  });

  it('CONN-6 a request header that node refuses synchronously is a typed network result', async () => {
    const spec: HttpRequestSpec = { method: 'GET', url: new URL(`${up.url}/items`), headers: { 'x-bad': 'a\nb' } };
    const r = await createConnectionClient(settings()).send(spec, { retryable: false });
    expect(r).toMatchObject({ ok: false, code: 'network' });
    expect(up.requests).toHaveLength(0);
  });
});

describe('CONN-3 token endpoint failures', () => {
  const oauthAt = (tokenUrl: string): ConnectionSettings => settings({ auth: { scheme: 'oauth_client_credentials', tokenUrl, scopes: [] } });
  const client = cred('oauth_client_credentials', { client_id: 'c', client_secret: 's' });

  it('CONN-3 a token endpoint 5xx is http_status', async () => {
    up.route('POST', '/token', () => ({ status: 503, body: {} }));
    const r = await createConnectionClient(oauthAt(`${up.url}/token`)).send(get(), { credential: client, retryable: false });
    expect(r).toMatchObject({ ok: false, code: 'http_status', status: 503 });
  });

  it('CONN-3 a token endpoint 4xx stays credential_unusable', async () => {
    up.route('POST', '/token', () => ({ status: 400, body: {} }));
    const r = await createConnectionClient(oauthAt(`${up.url}/token`)).send(get(), { credential: client, retryable: false });
    expect(r).toMatchObject({ ok: false, code: 'credential_unusable', status: 400 });
  });

  it('CONN-3 an unreachable token endpoint is network', async () => {
    const closed = await startFakeUpstream();
    const url = closed.url;
    await closed.close();
    const r = await createConnectionClient(oauthAt(`${url}/token`)).send(get(), { credential: client, retryable: false });
    expect(r).toMatchObject({ ok: false, code: 'network' });
  });

  it('CONN-3 concurrent 401s on the same token refresh it only once', async () => {
    let issued = 0;
    up.route('POST', '/token', () => {
      issued += 1;
      return { status: 200, body: { access_token: `issued-${issued}`, expires_in: 3600 } };
    });
    let n = 0;
    up.route('GET', '/items', (req) => {
      n += 1;
      if (req.headers.authorization === 'Bearer issued-1') return { status: 401, body: {}, delayMs: n === 1 ? 0 : 150 };
      return { status: 200, body: {} };
    });
    const c = createConnectionClient(oauthAt(`${up.url}/token`));
    const rs = await Promise.all([c.send(get(), { credential: client, retryable: false }), c.send(get(), { credential: client, retryable: false })]);
    expect(rs.every((r) => r.ok)).toBe(true);
    expect(issued).toBe(2);
  });
});

describe('SEC-3 token endpoint Basic value', () => {
  it('SEC-3 the form-encoded Basic value sent to the token endpoint is scrubbed', async () => {
    const sent = Buffer.from('id%3A1:s%26cret').toString('base64');
    up.route('POST', '/token', () => ({ status: 200, body: { access_token: 'tok', expires_in: 3600 } }));
    up.route('GET', '/items', () => ({ status: 200, body: { leak: sent } }));
    const c = createConnectionClient(settings({ auth: { scheme: 'oauth_client_credentials', tokenUrl: `${up.url}/token`, scopes: [] } }));
    const r = await c.send(get(), { credential: cred('oauth_client_credentials', { client_id: 'id:1', client_secret: 's&cret' }), retryable: false });
    expect(r.ok).toBe(true);
    expect(JSON.stringify(r)).not.toContain(sent);
  });
});

describe('CONN-6 truncated responses', () => {
  let raw: Server | undefined;
  afterEach(() => {
    raw?.close();
  });

  it('CONN-6 a response cut off before its declared length is network', async () => {
    const server = createServer((sock) => {
      sock.once('data', () => {
        sock.end('HTTP/1.1 200 OK\r\ncontent-type: application/json\r\ncontent-length: 100\r\n\r\n{"a":');
      });
    });
    raw = server;
    await new Promise<void>((resolve) => {
      server.listen(0, '127.0.0.1', () => {
        resolve();
      });
    });
    const addr = server.address();
    const port = typeof addr === 'object' && addr !== null ? addr.port : 0;
    const base = `http://127.0.0.1:${port}`;
    const r = await createConnectionClient(settings({ baseUrl: base })).send(get('/items', base), { retryable: false });
    expect(r).toMatchObject({ ok: false, code: 'network' });
  });
});

describe('NFR-11 request instrumentation', () => {
  const TRACEPARENT = '00-0af7651916cd43dd8448eb211c80319c-b7ad6b7169203331-01';

  /** A hook that records every call and returns `headers` as the span's extra headers. */
  function recorder(headers: Record<string, string> = {}): { hook: RequestInstrumentation; starts: RequestAttempt[]; ends: RequestAttemptEnd[] } {
    const starts: RequestAttempt[] = [];
    const ends: RequestAttemptEnd[] = [];
    const hook: RequestInstrumentation = {
      start(attempt) {
        starts.push(attempt);
        return {
          headers,
          end(result) {
            ends.push(result);
          },
        };
      },
    };
    return { hook, starts, ends };
  }

  it('NFR-11 start is called once per attempt with connection, method and host, and end with the status', async () => {
    let n = 0;
    up.route('GET', '/items', () => {
      n += 1;
      return n === 1 ? { status: 503, body: {} } : { status: 200, body: { ok: 1 } };
    });
    const { hook, starts, ends } = recorder();
    const c = createConnectionClient(settings({ id: 'c1' }), { ...noSleep, instrumentation: hook });
    expect(await c.send(get(), { retryable: true })).toMatchObject({ ok: true, status: 200 });
    expect(starts).toEqual([
      { connection: 'c1', method: 'GET', host: '127.0.0.1' },
      { connection: 'c1', method: 'GET', host: '127.0.0.1' },
    ]);
    expect(ends).toEqual([{ status: 503 }, { status: 200 }]);
  });

  it('NFR-11 end gets the error code when no response arrived', async () => {
    up.route('GET', '/items', () => ({ status: 200, body: {}, delayMs: 500 }));
    const { hook, ends } = recorder();
    const c = createConnectionClient(settings({ timeoutMs: 100 }), { instrumentation: hook });
    expect(await c.send(get(), { retryable: false })).toMatchObject({ ok: false, code: 'timeout' });
    expect(ends).toEqual([{ errorCode: 'timeout' }]);
  });

  it('NFR-11 no slot means no span: a busy attempt neither starts nor ends', async () => {
    up.route('GET', '/items', () => ({ status: 200, body: {} }));
    const s = settings({ maxConcurrency: 1, timeoutMs: 60 });
    const held = await semaphoreFor(s.id, 1).acquire(1000);
    const { hook, starts, ends } = recorder();
    const r = await createConnectionClient(s, { instrumentation: hook }).send(get(), { retryable: false });
    held?.();
    expect(r).toMatchObject({ ok: false, code: 'busy' });
    expect(starts).toHaveLength(0);
    expect(ends).toHaveLength(0);
  });

  it('NFR-11 the hook headers reach the upstream', async () => {
    up.route('GET', '/items', () => ({ status: 200, body: {} }));
    const { hook } = recorder({ traceparent: TRACEPARENT });
    const c = createConnectionClient(settings(), { instrumentation: hook });
    expect((await c.send(get(), { retryable: false })).ok).toBe(true);
    expect(up.requests[0]?.headers.traceparent).toBe(TRACEPARENT);
  });

  const hostile = {
    authorization: 'Bearer hook',
    Authorization: 'Bearer hook2',
    'x-api-key': 'hook-key',
    host: 'evil.example',
    cookie: 'session=hook',
    'content-length': '999',
    traceparent: TRACEPARENT,
  };

  it('SEC-3 hook headers never replace the auth or a forbidden header', async () => {
    up.route('GET', '/items', () => ({ status: 200, body: {} }));
    const bearer = createConnectionClient(settings({ auth: { scheme: 'bearer' } }), { instrumentation: recorder(hostile).hook });
    expect((await bearer.send(get(), { credential: cred('bearer', { token: 'tok-1' }), retryable: false })).ok).toBe(true);
    const apiKey = createConnectionClient(settings({ auth: { scheme: 'api_key', header: 'X-Api-Key' } }), { instrumentation: recorder(hostile).hook });
    expect((await apiKey.send(get(), { credential: cred('api_key', { key: 'key-1' }), retryable: false })).ok).toBe(true);

    const [viaBearer, viaKey] = up.requests;
    expect(viaBearer?.headers.authorization).toBe('Bearer tok-1');
    expect(viaKey?.headers['x-api-key']).toBe('key-1');
    expect(viaKey?.headers.authorization).toBeUndefined();
    for (const h of [viaBearer?.headers, viaKey?.headers]) {
      expect(h?.host).not.toBe('evil.example');
      expect(h?.cookie).toBeUndefined();
      expect(h?.['content-length']).toBeUndefined();
      // The allowed header still arrives: only the reserved names were dropped.
      expect(h?.traceparent).toBe(TRACEPARENT);
    }
  });

  it('SEC-3 NFR-11 only traceparent and tracestate are taken from the hook, in any case', async () => {
    up.route('GET', '/items', () => ({ status: 200, body: {} }));
    const c = createConnectionClient(settings(), {
      instrumentation: recorder({ TraceParent: TRACEPARENT, TRACESTATE: 'vendor=x', baggage: 'user=jane', 'x-custom': 'v', 'x-forwarded-for': '10.0.0.1' }).hook,
    });
    expect(await c.send(get(), { retryable: false })).toMatchObject({ ok: true, status: 200 });
    const h = up.requests[0]?.headers;
    expect(h?.traceparent).toBe(TRACEPARENT);
    expect(h?.tracestate).toBe('vendor=x');
    expect(h?.baggage).toBeUndefined();
    expect(h?.['x-custom']).toBeUndefined();
    expect(h?.['x-forwarded-for']).toBeUndefined();
  });

  it('NFR-11 an allowed hook header with an invalid value is dropped', async () => {
    up.route('GET', '/items', () => ({ status: 200, body: {} }));
    for (const tracestate of ['a\r\nset-cookie: x=1', ' v', 'v ', 'a\tb', '']) {
      const c = createConnectionClient(settings(), { instrumentation: recorder({ tracestate, traceparent: TRACEPARENT }).hook });
      expect(await c.send(get(), { retryable: false })).toMatchObject({ ok: true, status: 200 });
    }
    expect(up.requests).toHaveLength(5);
    for (const req of up.requests) {
      expect(req.headers.tracestate).toBeUndefined();
      expect(req.headers['set-cookie']).toBeUndefined();
      expect(req.headers.traceparent).toBe(TRACEPARENT);
    }
  });

  it('SEC-3 a hook header never replaces a header the request already carries', async () => {
    up.route('GET', '/items', () => ({ status: 200, body: {} }));
    const c = createConnectionClient(settings(), { instrumentation: recorder({ Accept: 'text/html' }).hook });
    expect((await c.send(get(), { retryable: false })).ok).toBe(true);
    expect(up.requests[0]?.headers.accept).toBe('application/json');
  });

  it('NFR-11 a hook header value with CR/LF is dropped and the request succeeds', async () => {
    up.route('GET', '/items', () => ({ status: 200, body: {} }));
    const c = createConnectionClient(settings(), {
      instrumentation: recorder({ 'x-injected': 'a\r\nset-cookie: x=1', 'bad name': 'v', 'x-\u00e9': 'v', traceparent: TRACEPARENT }).hook,
    });
    expect(await c.send(get(), { retryable: false })).toMatchObject({ ok: true, status: 200 });
    const h = up.requests[0]?.headers;
    expect(h?.['x-injected']).toBeUndefined();
    expect(h?.['set-cookie']).toBeUndefined();
    expect(h?.traceparent).toBe(TRACEPARENT);
  });

  it('NFR-11 a tracestate with an internal space in a member value is forwarded', async () => {
    up.route('GET', '/items', () => ({ status: 200, body: {} }));
    const tracestate = 'vendor=a b,other=c';
    const c = createConnectionClient(settings(), {
      instrumentation: recorder({ tracestate, 'x-lead': ' v', 'x-trail': 'v ', 'x-tab': 'a\tb' }).hook,
    });
    expect(await c.send(get(), { retryable: false })).toMatchObject({ ok: true, status: 200 });
    const h = up.requests[0]?.headers;
    expect(h?.tracestate).toBe(tracestate);
    expect(h?.['x-lead']).toBeUndefined();
    expect(h?.['x-trail']).toBeUndefined();
    expect(h?.['x-tab']).toBeUndefined();
  });

  it('NFR-11 hook headers that are not a plain object are ignored', async () => {
    up.route('GET', '/items', () => ({ status: 200, body: {} }));
    for (const headers of ['ab', ['v0', 'v1'], null, new Map([['traceparent', TRACEPARENT]])]) {
      const ends: RequestAttemptEnd[] = [];
      const hook: RequestInstrumentation = {
        // The hook's declared type is bypassed on purpose: a hostile or buggy hook may return anything.
        start: () => ({ headers: headers as unknown as Record<string, string>, end: (r) => ends.push(r) }),
      };
      const r = await createConnectionClient(settings(), { instrumentation: hook }).send(get(), { retryable: false });
      expect(r).toMatchObject({ ok: true, status: 200 });
      expect(ends).toEqual([{ status: 200 }]);
    }
    expect(up.requests).toHaveLength(4);
    for (const req of up.requests) {
      expect(Object.keys(req.headers).filter((n) => /^\d+$/.test(n))).toEqual([]);
      expect(req.headers.traceparent).toBeUndefined();
    }
  });

  it('NFR-11 a throwing hook never fails the request', async () => {
    up.route('GET', '/items', () => ({ status: 200, body: { ok: 1 } }));
    const throwingStart: RequestInstrumentation = {
      start() {
        throw new Error('hook broke');
      },
    };
    const throwingEnd: RequestInstrumentation = {
      start: () => ({
        headers: { traceparent: TRACEPARENT },
        end() {
          throw new Error('end broke');
        },
      }),
    };
    const badHeaderEnds: RequestAttemptEnd[] = [];
    const badHeaders: RequestInstrumentation = {
      start: () => ({
        get headers(): Record<string, string> {
          throw new Error('headers broke');
        },
        end: (result) => {
          badHeaderEnds.push(result);
        },
      }),
    };
    for (const instrumentation of [throwingStart, throwingEnd, badHeaders]) {
      const c = createConnectionClient(settings({ auth: { scheme: 'bearer' } }), { instrumentation });
      const r = await c.send(get(), { credential: cred('bearer', { token: 'tok-1' }), retryable: false });
      expect(r).toMatchObject({ ok: true, status: 200, json: { ok: 1 } });
    }
    expect(up.requests).toHaveLength(3);
    for (const req of up.requests) {
      expect(req.headers.authorization).toBe('Bearer tok-1');
      expect(req.headers.accept).toBe('application/json');
    }
    expect(up.requests[0]?.headers.traceparent).toBeUndefined();
    // A span whose headers cannot be read is still ended, so it never leaks.
    expect(badHeaderEnds).toEqual([{ status: 200 }]);
  });
});

describe('EXE-4 a pre-send hook for calls sent at most once', () => {
  const post = (): HttpRequestSpec => ({
    method: 'POST',
    url: new URL(`${up.url}/calls`),
    headers: { accept: 'application/json', 'content-type': 'application/json' },
    body: '{"a":1}',
  });

  it('EXE-4 beforeSend runs once after the credential and before the transport; no retry', async () => {
    up.route('POST', '/calls', () => ({ status: 503, body: {} }));
    const log: string[] = [];
    const credential: CredentialSource = {
      ref: 'test-cred',
      scheme: 'bearer',
      open: () => {
        log.push('credential');
        return Promise.resolve({ token: 'tok-1' });
      },
    };
    const c = createConnectionClient(settings({ auth: { scheme: 'bearer' } }), noSleep);
    const r = await c.send(post(), {
      credential,
      retryable: true,
      beforeSend: () => {
        log.push(`hook:${up.requests.length}`);
        return Promise.resolve();
      },
    });
    expect(r).toMatchObject({ ok: false, code: 'http_status', status: 503 });
    expect(log).toEqual(['credential', 'hook:0']);
    expect(up.requests).toHaveLength(1);
    expect(up.requests[0]?.headers.authorization).toBe('Bearer tok-1');
  });

  it('EXE-4 a throwing beforeSend is rethrown, nothing is sent and the slot is released', async () => {
    up.route('POST', '/calls', () => ({ status: 200, body: {} }));
    const s = settings({ maxConcurrency: 1 });
    const c = createConnectionClient(s);
    const fenced = new Error('fenced');
    await expect(c.send(post(), { retryable: false, beforeSend: () => Promise.reject(fenced) })).rejects.toBe(fenced);
    expect(up.requests).toHaveLength(0);
    // With one slot, a second send only succeeds if the first released it.
    expect(await c.send(post(), { retryable: false })).toMatchObject({ ok: true, status: 200 });
  });

  it('EXE-4 CONN-5 a host outside the allow-list is egress_denied and beforeSend is not called', async () => {
    let called = 0;
    const c = createConnectionClient(settings({ allowPrivateNetwork: false }));
    const r = await c.send(post(), {
      retryable: false,
      beforeSend: () => {
        called += 1;
        return Promise.resolve();
      },
    });
    expect(r).toMatchObject({ ok: false, code: 'egress_denied' });
    expect(called).toBe(0);
    expect(up.requests).toHaveLength(0);
  });

  it('EXE-4 CONN-3 a missing credential is credential_missing and beforeSend is not called', async () => {
    let called = 0;
    const c = createConnectionClient(settings({ auth: { scheme: 'bearer' } }));
    const r = await c.send(post(), {
      retryable: false,
      beforeSend: () => {
        called += 1;
        return Promise.resolve();
      },
    });
    expect(r).toMatchObject({ ok: false, code: 'credential_missing' });
    expect(called).toBe(0);
    expect(up.requests).toHaveLength(0);
  });

  it('EXE-4 CONN-3 with beforeSend an OAuth 401 is returned as http_status 401 without a second request', async () => {
    up.route('POST', '/token', () => ({ status: 200, body: { access_token: 'issued-1', token_type: 'Bearer', expires_in: 3600 } }));
    up.route('POST', '/calls', () => ({ status: 401, body: {} }));
    const c = createConnectionClient(settings({ auth: { scheme: 'oauth_client_credentials', tokenUrl: `${up.url}/token`, scopes: [] } }));
    const r = await c.send(post(), {
      credential: cred('oauth_client_credentials', { client_id: 'id', client_secret: 'secret' }),
      retryable: false,
      beforeSend: () => Promise.resolve(),
    });
    expect(r).toMatchObject({ ok: false, code: 'http_status', status: 401 });
    expect(up.requests.filter((x) => x.path === '/calls')).toHaveLength(1);
    expect(up.requests.filter((x) => x.path === '/token')).toHaveLength(1);
  });

  it.each([
    ['a non-JSON body', { status: 200, headers: { 'content-type': 'text/html' }, body: '<html>ok</html>' }],
    ['an empty JSON body', { status: 201, headers: { 'content-type': 'application/json' }, body: '' }],
    ['a malformed JSON body', { status: 200, headers: { 'content-type': 'application/json' }, body: '{oops' }],
  ])('EXE-4 SEC-3 with discardBody a 2xx with %s is a response with no JSON', async (_name, response) => {
    up.route('POST', '/calls', () => response);
    const r = await createConnectionClient(settings()).send(post(), { retryable: false, discardBody: true });
    expect(r).toEqual({ ok: true, status: response.status, json: null, durationMs: expect.any(Number) as unknown });
  });
});
