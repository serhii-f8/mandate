import type { ConnectionSettings, CredentialSource, RequestAttempt, RequestAttemptEnd, RequestInstrumentation } from '@aiops/connector-sdk';
import { startFakeUpstream, type FakeUpstream } from '@aiops/testing';
import { createServer, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { prepareAuth, type PreparedAuth } from './auth.js';
import { createTransport } from './client.js';
import { createGuardedLookup } from './egress.js';
import { createGuardedFetch, GuardedFetchError, type GuardedFailureCode } from './guarded-fetch.js';
import { clearTokenCache } from './oauth.js';
import { REDACTED } from './scrub.js';

let up: FakeUpstream;
let seq = 0;
const ownServers: Server[] = [];

beforeEach(async () => {
  up = await startFakeUpstream();
  clearTokenCache();
});
afterEach(async () => {
  await up.close();
  for (const s of ownServers.splice(0)) {
    s.closeAllConnections();
    await new Promise<void>((resolve) => {
      s.close(() => {
        resolve();
      });
    });
  }
});

function settings(over: Partial<ConnectionSettings> = {}): ConnectionSettings {
  seq += 1;
  return {
    id: `gf-conn-${seq}`,
    kind: 'mcp',
    baseUrl: up.url,
    timeoutMs: 2000,
    retry: { maxAttempts: 1, initialBackoffMs: 100 },
    maxConcurrency: 4,
    allowPrivateNetwork: true,
    extraHosts: [],
    ...over,
  };
}

function cred(scheme: CredentialSource['scheme'], material: Record<string, string>): CredentialSource {
  return { ref: 'test-cred', scheme, open: () => Promise.resolve(material) };
}

async function prepared(s: ConnectionSettings, c?: CredentialSource): Promise<PreparedAuth> {
  const r = await prepareAuth(s, c, { now: Date.now, transport: createTransport(s, createGuardedLookup(s)) });
  if (!r.ok) throw new Error(`prepareAuth failed: ${r.code} ${r.message}`);
  return r.auth;
}

const rpc = (): RequestInit => ({
  method: 'POST',
  headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
  body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
});

async function guardedError(p: Promise<unknown>): Promise<GuardedFetchError> {
  try {
    await p;
  } catch (err) {
    if (err instanceof GuardedFetchError) return err;
    throw new Error(`expected GuardedFetchError, got ${String(err)}`, { cause: err });
  }
  throw new Error('expected a rejection');
}

/** A small server of our own for bodies `startFakeUpstream` cannot make (ruling F11). */
async function ownServer(handler: (res: ServerResponse) => void): Promise<string> {
  const server = createServer((req, res) => {
    req.resume();
    req.on('end', () => {
      handler(res);
    });
  });
  ownServers.push(server);
  await new Promise<void>((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      resolve();
    });
  });
  const { port } = server.address() as AddressInfo; // listen() on a TCP port yields AddressInfo
  return `http://127.0.0.1:${port}`;
}

describe('CONN-5 CONN-6 SEC-3 guarded fetch', () => {
  it('CONN-3 sends the credential header last; a header in init cannot replace it', async () => {
    up.route('POST', '/mcp', () => ({ status: 200, body: { jsonrpc: '2.0', id: 1, result: {} } }));
    const bearer = settings({ auth: { scheme: 'bearer' } });
    const gf = createGuardedFetch(bearer, await prepared(bearer, cred('bearer', { token: 'tok-1' })), {});
    const headers = new Headers({ Authorization: 'Bearer forged', 'x-custom': '1', 'content-type': 'application/json' });
    const res = await gf.fetch(`${up.url}/mcp`, { method: 'POST', headers, body: '{}' });
    expect(res.status).toBe(200);
    expect(up.requests[0]?.headers.authorization).toBe('Bearer tok-1');
    expect(up.requests[0]?.headers['x-custom']).toBe('1');

    const apiKey = settings({ auth: { scheme: 'api_key', header: 'X-Api-Key' } });
    const gf2 = createGuardedFetch(apiKey, await prepared(apiKey, cred('api_key', { key: 'key-1' })), {});
    await gf2.fetch(new URL(`${up.url}/mcp`), { method: 'POST', headers: [['X-API-KEY', 'forged']], body: '{}' });
    expect(up.requests[1]?.headers['x-api-key']).toBe('key-1');
  });

  it('CONN-5 refuses a private address without allow_private_network, before any request', async () => {
    const s = settings({ allowPrivateNetwork: false });
    const gf = createGuardedFetch(s, await prepared(s), {});
    const err = await guardedError(gf.fetch(`${up.url}/mcp`, rpc()));
    expect(err.code).toBe('egress_denied');
    expect(up.requests.length).toBe(0);
    expect(gf.lastFailure()).toMatchObject({ code: 'egress_denied' });
  });

  it('CONN-5 refuses a host that is not the connection host', async () => {
    const s = settings();
    const gf = createGuardedFetch(s, await prepared(s), {});
    expect((await guardedError(gf.fetch('http://localhost.example/mcp', rpc()))).code).toBe('egress_denied');
    expect((await guardedError(gf.fetch('file:///etc/passwd', rpc()))).code).toBe('egress_denied');
    expect(up.requests.length).toBe(0);
  });

  it('CONN-5 refuses a redirect and never contacts its target', async () => {
    up.route('POST', '/mcp', () => ({ status: 302, headers: { location: 'http://169.254.169.254/' } }));
    up.route('POST', '/a', () => ({ status: 307, headers: { location: `${up.url}/elsewhere` } }));
    up.route('POST', '/elsewhere', () => ({ status: 200, body: {} }));
    const s = settings();
    const gf = createGuardedFetch(s, await prepared(s), {});
    expect((await guardedError(gf.fetch(`${up.url}/mcp`, rpc()))).code).toBe('egress_denied');
    expect((await guardedError(gf.fetch(`${up.url}/a`, rpc()))).code).toBe('egress_denied');
    expect(up.requests.map((r) => r.path)).toEqual(['/mcp', '/a']);
    expect(gf.lastFailure()).toMatchObject({ code: 'egress_denied' });
  });

  it('CONN-6 times out a response that never ends', async () => {
    const url = await ownServer((res) => {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.write('event: message\ndata: {"jsonrpc":"2.0","method":"notifications/progress"}\n\n');
      // Never ends.
    });
    const s = settings({ baseUrl: url, timeoutMs: 200 });
    const gf = createGuardedFetch(s, await prepared(s), {});
    const res = await gf.fetch(`${url}/mcp`, rpc());
    expect(res.status).toBe(200);
    const err = await guardedError(res.text());
    expect(err.code).toBe('timeout');
    expect(gf.lastFailure()).toMatchObject({ code: 'timeout' });
  });

  it('CONN-6 times out a response whose headers never arrive', async () => {
    up.route('POST', '/mcp', () => ({ status: 200, body: {}, delayMs: 30_000 }));
    const s = settings({ timeoutMs: 200 });
    const gf = createGuardedFetch(s, await prepared(s), {});
    expect((await guardedError(gf.fetch(`${up.url}/mcp`, rpc()))).code).toBe('timeout');
  });

  it('CONN-6 refuses a body over 5 MB', async () => {
    const big = `"${'a'.repeat(5 * 1024 * 1024)}"`;
    up.route('POST', '/mcp', () => ({ status: 200, headers: { 'content-type': 'application/json', 'content-length': String(big.length) }, body: big }));
    const s = settings();
    const gf = createGuardedFetch(s, await prepared(s), {});
    expect((await guardedError(gf.fetch(`${up.url}/mcp`, rpc()))).code).toBe('invalid_response');

    const chunk = 'a'.repeat(64 * 1024);
    const url = await ownServer((res) => {
      res.writeHead(200, { 'content-type': 'application/json' }); // chunked, no content-length
      let sent = 0;
      const pump = (): void => {
        while (sent < 6 * 1024 * 1024) {
          sent += chunk.length;
          if (!res.write(chunk)) {
            res.once('drain', pump);
            return;
          }
        }
        res.end();
      };
      res.on('error', () => undefined);
      pump();
    });
    const s2 = settings({ baseUrl: url });
    const gf2 = createGuardedFetch(s2, await prepared(s2), {});
    const res = await gf2.fetch(`${url}/mcp`, rpc());
    expect(res.headers.get('content-length')).toBeNull();
    expect((await guardedError(res.arrayBuffer())).code).toBe('invalid_response');
    expect(gf2.lastFailure()).toMatchObject({ code: 'invalid_response' });
  });

  it('CONN-1 accepts text/event-stream and application/json, refuses text/html', async () => {
    const sse = 'event: message\ndata: {"jsonrpc":"2.0","id":1,"result":{}}\n\n';
    up.route('POST', '/sse', () => ({ status: 200, headers: { 'content-type': 'text/event-stream; charset=utf-8' }, body: sse }));
    up.route('POST', '/json', () => ({ status: 200, body: { jsonrpc: '2.0', id: 1, result: {} } }));
    up.route('POST', '/problem', () => ({ status: 200, headers: { 'content-type': 'application/vnd.test+json' }, body: '{}' }));
    up.route('POST', '/accepted', () => ({ status: 202 }));
    up.route('POST', '/html', () => ({ status: 200, headers: { 'content-type': 'text/html' }, body: '<p>hi</p>' }));
    const s = settings();
    const gf = createGuardedFetch(s, await prepared(s), {});
    const a = await gf.fetch(`${up.url}/sse`, rpc());
    expect(a.headers.get('content-type')).toBe('text/event-stream; charset=utf-8');
    expect(await a.text()).toBe(sse);
    expect(await (await gf.fetch(`${up.url}/json`, rpc())).json()).toEqual({ jsonrpc: '2.0', id: 1, result: {} });
    expect(await (await gf.fetch(`${up.url}/problem`, rpc())).text()).toBe('{}');
    const accepted = await gf.fetch(`${up.url}/accepted`, rpc());
    expect(accepted.status).toBe(202);
    expect(await accepted.text()).toBe('');
    expect(gf.lastFailure()).toBeUndefined();
    expect((await guardedError(gf.fetch(`${up.url}/html`, rpc()))).code).toBe('invalid_response');
  });

  it('CONN-1 answers GET with 405 without a request', async () => {
    const s = settings();
    const gf = createGuardedFetch(s, await prepared(s), {});
    const res = await gf.fetch(`${up.url}/mcp`, { method: 'GET', headers: { accept: 'text/event-stream' } });
    expect(res.status).toBe(405);
    const bare = await gf.fetch(`${up.url}/mcp`);
    expect(bare.status).toBe(405);
    expect(up.requests.length).toBe(0);
    expect(gf.lastFailure()).toBeUndefined();
  });

  it('SEC-3 passes a JSON error body up to 64 KiB and drops a larger or non-JSON one; records http_status', async () => {
    const error = { jsonrpc: '2.0', id: 1, error: { code: -32601, message: 'Method not found' } };
    up.route('POST', '/small', () => ({ status: 400, body: error }));
    up.route('POST', '/large', () => ({ status: 500, body: { pad: 'x'.repeat(64 * 1024) } }));
    up.route('POST', '/text', () => ({ status: 404, headers: { 'content-type': 'text/plain' }, body: 'nope' }));
    const s = settings();
    const gf = createGuardedFetch(s, await prepared(s), {});
    const small = await gf.fetch(`${up.url}/small`, rpc());
    expect(small.status).toBe(400);
    expect(await small.json()).toEqual(error);
    expect(gf.lastFailure()).toEqual({ code: 'http_status', status: 400, message: 'upstream returned status 400' });
    const large = await gf.fetch(`${up.url}/large`, rpc());
    expect(large.status).toBe(500);
    expect(await large.text()).toBe('');
    expect(gf.lastFailure()).toMatchObject({ code: 'http_status', status: 500 });
    const text = await gf.fetch(`${up.url}/text`, rpc());
    expect(text.status).toBe(404);
    expect(await text.text()).toBe('');
    // The most recent failure is reported (ruling F8).
    expect(gf.lastFailure()).toMatchObject({ code: 'http_status', status: 404 });
  });

  it('SEC-3 scrubs the secret from every failure message', async () => {
    // The token doubles as a host name, so the egress message would otherwise carry it.
    const secret = 'leaky-secret-host';
    const s = settings({ auth: { scheme: 'bearer' } });
    const gf = createGuardedFetch(s, await prepared(s, cred('bearer', { token: secret })), {});
    const err = await guardedError(gf.fetch(`http://${secret}/mcp`, rpc()));
    expect(err.code).toBe('egress_denied');
    expect(err.message).toContain(REDACTED);
    expect(err.message).not.toContain(secret);
    expect(gf.lastFailure()?.message).not.toContain(secret);
    expect(gf.scrubber.text(`x ${secret} y`)).toBe(`x ${REDACTED} y`);

    // A 401 whose refresh fails keeps the token endpoint's message scrubbed too.
    up.route('POST', '/token', () => ({ status: 200, body: { access_token: 'oauth-secret-1', token_type: 'Bearer', expires_in: 3600 } }));
    up.route('POST', '/mcp', () => ({ status: 401, body: { error: 'oauth-secret-1 rejected' } }));
    const o = settings({ auth: { scheme: 'oauth_client_credentials', tokenUrl: `${up.url}/token`, scopes: [] } });
    const auth = await prepared(o, cred('oauth_client_credentials', { client_id: 'cid', client_secret: 'csecret' }));
    up.route('POST', '/token', () => ({ status: 400, body: { error: 'invalid_client' } }));
    const gf2 = createGuardedFetch(o, auth, {});
    const res = await gf2.fetch(`${up.url}/mcp`, rpc());
    expect(res.status).toBe(401);
    expect(await res.text()).not.toContain('oauth-secret-1');
    const failure = gf2.lastFailure();
    expect(failure).toMatchObject({ code: 'http_status', status: 401 });
    expect(JSON.stringify(failure)).not.toMatch(/oauth-secret-1|csecret/);
  });

  it('NFR-11 starts one span per exchange with method and host only and adds traceparent', async () => {
    up.route('POST', '/mcp', () => ({ status: 200, body: { ok: true } }));
    up.route('DELETE', '/mcp', () => ({ status: 503, body: { e: 1 } }));
    const started: RequestAttempt[] = [];
    const ended: RequestAttemptEnd[] = [];
    const traceparent = '00-0af7651916cd43dd8448eb211c80319c-b7ad6b7169203331-01';
    const instrumentation: RequestInstrumentation = {
      start(attempt) {
        started.push(attempt);
        return { headers: { traceparent, authorization: 'Bearer from-hook', 'x-other': '1' }, end: (r) => ended.push(r) };
      },
    };
    const s = settings();
    const gf = createGuardedFetch(s, await prepared(s), { instrumentation });
    const res = await gf.fetch(`${up.url}/mcp?x=1`, rpc());
    expect(await res.json()).toEqual({ ok: true });
    await gf.fetch(`${up.url}/mcp`, { method: 'DELETE' });
    await gf.fetch(`${up.url}/mcp`, { method: 'GET' });
    expect(started).toEqual([
      { connection: s.id, method: 'POST', host: '127.0.0.1' },
      { connection: s.id, method: 'DELETE', host: '127.0.0.1' },
    ]);
    expect(ended).toEqual([{ status: 200 }, { status: 503 }]);
    expect(up.requests[0]?.headers.traceparent).toBe(traceparent);
    expect(up.requests[0]?.headers.authorization).toBeUndefined();
    expect(up.requests[0]?.headers['x-other']).toBeUndefined();
  });

  it('CONN-3 refreshes an OAuth token once after a 401 and resends', async () => {
    let issued = 0;
    up.route('POST', '/token', () => {
      issued += 1;
      return { status: 200, body: { access_token: `issued-${issued}`, token_type: 'Bearer', expires_in: 3600 } };
    });
    up.route('POST', '/mcp', (r) => (r.headers.authorization === 'Bearer issued-2' ? { status: 200, body: { ok: true } } : { status: 401, body: {} }));
    const o = settings({ auth: { scheme: 'oauth_client_credentials', tokenUrl: `${up.url}/token`, scopes: [] } });
    const gf = createGuardedFetch(o, await prepared(o, cred('oauth_client_credentials', { client_id: 'cid', client_secret: 'cs' })), {});
    const res = await gf.fetch(`${up.url}/mcp`, rpc());
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
    const calls = up.requests.filter((r) => r.path === '/mcp');
    expect(calls.map((r) => r.headers.authorization)).toEqual(['Bearer issued-1', 'Bearer issued-2']);
    expect(calls[1]?.body).toBe(calls[0]?.body);
    expect(gf.lastFailure()).toBeUndefined();

    // Only once per fetch: a second 401 after the refresh is passed up.
    up.route('POST', '/mcp', () => ({ status: 401, body: {} }));
    const again = await gf.fetch(`${up.url}/mcp`, rpc());
    expect(again.status).toBe(401);
    expect(up.requests.filter((r) => r.path === '/token')).toHaveLength(2);
    expect(gf.lastFailure()).toMatchObject({ code: 'http_status', status: 401 });

    // refreshOn401: false passes the first 401 up without a token request.
    clearTokenCache();
    const o2 = settings({ auth: { scheme: 'oauth_client_credentials', tokenUrl: `${up.url}/token`, scopes: [] } });
    const gf2 = createGuardedFetch(o2, await prepared(o2, cred('oauth_client_credentials', { client_id: 'cid', client_secret: 'cs' })), { refreshOn401: false });
    const tokensBefore = up.requests.filter((r) => r.path === '/token').length;
    expect((await gf2.fetch(`${up.url}/mcp`, rpc())).status).toBe(401);
    expect(up.requests.filter((r) => r.path === '/token')).toHaveLength(tokensBefore);
  });

  it('CONN-6 init.signal aborts the exchange', async () => {
    up.route('POST', '/mcp', () => ({ status: 200, body: {}, delayMs: 30_000 }));
    const s = settings();
    const gf = createGuardedFetch(s, await prepared(s), {});
    const controller = new AbortController();
    const pending = gf.fetch(`${up.url}/mcp`, { ...rpc(), signal: controller.signal });
    await expect.poll(() => up.requests.length).toBe(1);
    controller.abort();
    await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
    const pre = new AbortController();
    pre.abort();
    await expect(gf.fetch(`${up.url}/mcp`, { ...rpc(), signal: pre.signal })).rejects.toMatchObject({ name: 'AbortError' });
    expect(up.requests.length).toBe(1);
    expect(gf.lastFailure()).toBeUndefined();
  });

  it('CONN-6 sends nothing when the signal aborts during a token refresh', async () => {
    up.route('POST', '/mcp', () => ({ status: 401, body: {} }));
    const s = settings({ auth: { scheme: 'bearer' } });
    const inner = await prepared(s, cred('bearer', { token: 'tok-1' }));
    const controller = new AbortController();
    const auth: PreparedAuth = {
      header: () => inner.header(),
      get scrubber() {
        return inner.scrubber;
      },
      refreshAfter401: () => {
        controller.abort();
        return Promise.resolve({ ok: true });
      },
    };
    const gf = createGuardedFetch(s, auth, {});
    await expect(gf.fetch(`${up.url}/mcp`, { ...rpc(), signal: controller.signal })).rejects.toMatchObject({ name: 'AbortError' });
    expect(up.requests.filter((r) => r.path === '/mcp')).toHaveLength(1);
  });

  it('NFR-11 an aborted exchange ends its span as network; hook headers come only from a plain object', async () => {
    up.route('POST', '/mcp', () => ({ status: 200, body: {}, delayMs: 30_000 }));
    up.route('POST', '/ok', () => ({ status: 200, body: {} }));
    const ended: RequestAttemptEnd[] = [];
    class SpanHeaders {
      traceparent = '00-0af7651916cd43dd8448eb211c80319c-b7ad6b7169203331-01';
    }
    const instrumentation: RequestInstrumentation = {
      // A class instance is not a plain object: its keys must be ignored like any odd hook value.
      start: () => ({ headers: new SpanHeaders() as unknown as Record<string, string>, end: (r) => ended.push(r) }),
    };
    const s = settings();
    const gf = createGuardedFetch(s, await prepared(s), { instrumentation });
    await gf.fetch(`${up.url}/ok`, rpc());
    expect(up.requests[0]?.headers.traceparent).toBeUndefined();
    const controller = new AbortController();
    const pending = gf.fetch(`${up.url}/mcp`, { ...rpc(), signal: controller.signal });
    await expect.poll(() => up.requests.length).toBe(2);
    controller.abort();
    await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
    expect(ended).toEqual([{ status: 200 }, { errorCode: 'network' }]);
  });

  it('CONN-6 GuardedFetchError carries a fixed code', () => {
    const codes: GuardedFailureCode[] = ['timeout', 'network', 'egress_denied', 'invalid_response', 'http_status'];
    for (const code of codes) expect(new GuardedFetchError(code, 'm').code).toBe(code);
  });
});

describe('EXE-4 guarded fetch for a call sent once', () => {
  it('EXE-4 after noResend() a 401 is passed up without a token refresh or a second request', async () => {
    let issued = 0;
    up.route('POST', '/token', () => {
      issued += 1;
      return { status: 200, body: { access_token: `issued-${issued}`, token_type: 'Bearer', expires_in: 3600 } };
    });
    up.route('POST', '/mcp', () => ({ status: 401, body: {} }));
    const o = settings({ auth: { scheme: 'oauth_client_credentials', tokenUrl: `${up.url}/token`, scopes: [] } });
    const gf = createGuardedFetch(o, await prepared(o, cred('oauth_client_credentials', { client_id: 'cid', client_secret: 'cs' })), {});
    gf.noResend();
    expect((await gf.fetch(`${up.url}/mcp`, rpc())).status).toBe(401);
    expect(up.requests.filter((r) => r.path === '/mcp')).toHaveLength(1);
    expect(issued).toBe(1);
    expect(gf.lastFailure()).toMatchObject({ code: 'http_status', status: 401 });
  });

  it('EXE-4 a refused redirect carries its status: the request reached the upstream', async () => {
    up.route('POST', '/mcp', () => ({ status: 303, headers: { location: `${up.url}/elsewhere` } }));
    const s = settings();
    const gf = createGuardedFetch(s, await prepared(s), {});
    const err = await guardedError(gf.fetch(`${up.url}/mcp`, rpc()));
    expect({ code: err.code, status: err.status }).toEqual({ code: 'egress_denied', status: 303 });
    expect(gf.lastFailure()).toMatchObject({ code: 'egress_denied', status: 303 });

    // A refusal before any request carries no status.
    const early = await guardedError(gf.fetch('file:///etc/passwd', rpc()));
    expect(early.status).toBeUndefined();
  });
});
