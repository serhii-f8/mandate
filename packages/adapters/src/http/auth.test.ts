import type { ConnectionSettings, CredentialSource } from '@aiops/connector-sdk';
import { startFakeUpstream, type FakeUpstream } from '@aiops/testing';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { prepareAuth, type PreparedAuth } from './auth.js';
import { createTransport } from './client.js';
import { createGuardedLookup } from './egress.js';
import { clearTokenCache } from './oauth.js';
import { REDACTED } from './scrub.js';

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
    id: `auth-conn-${seq}`,
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

function deps(s: ConnectionSettings): Parameters<typeof prepareAuth>[2] {
  return { now: Date.now, transport: createTransport(s, createGuardedLookup(s)) };
}

async function prepared(s: ConnectionSettings, c: CredentialSource | undefined): Promise<PreparedAuth> {
  const r = await prepareAuth(s, c, deps(s));
  if (!r.ok) throw new Error(`prepareAuth failed: ${r.code} ${r.message}`);
  return r.auth;
}

describe('CONN-3 SEC-3 prepared credential injection', () => {
  it('CONN-3 SEC-3 bearer gives Authorization: Bearer and scrubs the token', async () => {
    const s = settings({ auth: { scheme: 'bearer' } });
    const auth = await prepared(s, cred('bearer', { token: 'tok-1' }));
    expect(auth.header()).toEqual(['authorization', 'Bearer tok-1']);
    expect(auth.scrubber.text('tok-1')).toBe(REDACTED);
  });

  it('CONN-3 SEC-3 api_key gives the configured header in lower case and scrubs the key', async () => {
    const s = settings({ auth: { scheme: 'api_key', header: 'X-Api-Key' } });
    const auth = await prepared(s, cred('api_key', { key: 'key-1' }));
    expect(auth.header()).toEqual(['x-api-key', 'key-1']);
    expect(auth.scrubber.text('key-1')).toBe(REDACTED);
  });

  it('CONN-3 SEC-3 basic gives Authorization: Basic and scrubs password and encoded pair, not the user name', async () => {
    const s = settings({ auth: { scheme: 'basic' } });
    const auth = await prepared(s, cred('basic', { username: 'admin', password: 'p:w' }));
    const encoded = Buffer.from('admin:p:w').toString('base64');
    expect(auth.header()).toEqual(['authorization', `Basic ${encoded}`]);
    expect(auth.scrubber.text('p:w')).toBe(REDACTED);
    expect(auth.scrubber.text(encoded)).toBe(REDACTED);
    expect(auth.scrubber.text('admin')).toBe('admin');
  });

  it('CONN-3 SEC-3 oauth_client_credentials fetches a token and scrubs it and the client secret', async () => {
    up.route('POST', '/token', () => ({ status: 200, body: { access_token: 'issued-1', expires_in: 3600 } }));
    const s = settings({ auth: { scheme: 'oauth_client_credentials', tokenUrl: `${up.url}/token`, scopes: [] } });
    const auth = await prepared(s, cred('oauth_client_credentials', { client_id: 'cid', client_secret: 'csecret' }));
    expect(auth.header()).toEqual(['authorization', 'Bearer issued-1']);
    expect(auth.scrubber.text('issued-1')).toBe(REDACTED);
    expect(auth.scrubber.text('csecret')).toBe(REDACTED);
    expect(up.requests.filter((r) => r.path === '/token')).toHaveLength(1);
  });

  it('CONN-3 no auth configured gives no header and an empty scrubber', async () => {
    const auth = await prepared(settings(), undefined);
    expect(auth.header()).toBeUndefined();
    expect(auth.scrubber.text('anything')).toBe('anything');
    expect(await auth.refreshAfter401()).toBeUndefined();
  });

  it('CONN-3 auth configured without a credential is credential_missing', async () => {
    const s = settings({ auth: { scheme: 'bearer' } });
    expect(await prepareAuth(s, undefined, deps(s))).toEqual({ ok: false, code: 'credential_missing', message: `connection ${s.id} has no credential` });
  });

  it('CONN-3 a credential of another scheme is credential_unusable', async () => {
    const s = settings({ auth: { scheme: 'bearer' } });
    expect(await prepareAuth(s, cred('basic', { username: 'u', password: 'p' }), deps(s))).toEqual({
      ok: false,
      code: 'credential_unusable',
      message: `credential scheme does not match connection ${s.id}`,
    });
  });

  it('CONN-3 a credential that cannot be opened is credential_unusable', async () => {
    const s = settings({ auth: { scheme: 'bearer' } });
    const broken: CredentialSource = { ref: 'broken-cred', scheme: 'bearer', open: () => Promise.reject(new Error('vault down')) };
    expect(await prepareAuth(s, broken, deps(s))).toEqual({ ok: false, code: 'credential_unusable', message: 'credential broken-cred could not be opened' });
  });

  it('CONN-3 SEC-3 a token with a control character is credential_unusable and not echoed', async () => {
    const s = settings({ auth: { scheme: 'bearer' } });
    const r = await prepareAuth(s, cred('bearer', { token: 'tok\n' }), deps(s));
    expect(r).toEqual({ ok: false, code: 'credential_unusable', message: 'credential test-cred contains characters not allowed in a header' });
  });

  it('CONN-3 refreshAfter401 fetches a new token once, then has nothing to refresh', async () => {
    let issued = 0;
    up.route('POST', '/token', () => {
      issued += 1;
      return { status: 200, body: { access_token: `issued-${issued}`, expires_in: 3600 } };
    });
    const s = settings({ auth: { scheme: 'oauth_client_credentials', tokenUrl: `${up.url}/token`, scopes: [] } });
    const auth = await prepared(s, cred('oauth_client_credentials', { client_id: 'cid', client_secret: 'csecret' }));
    expect(auth.header()).toEqual(['authorization', 'Bearer issued-1']);
    expect(await auth.refreshAfter401()).toEqual({ ok: true });
    expect(auth.header()).toEqual(['authorization', 'Bearer issued-2']);
    expect(auth.scrubber.text('issued-2')).toBe(REDACTED);
    expect(await auth.refreshAfter401()).toBeUndefined();
    expect(up.requests.filter((r) => r.path === '/token')).toHaveLength(2);
  });

  it('CONN-3 refreshAfter401 answers undefined for non-OAuth schemes', async () => {
    const s = settings({ auth: { scheme: 'bearer' } });
    const auth = await prepared(s, cred('bearer', { token: 'tok-1' }));
    expect(await auth.refreshAfter401()).toBeUndefined();
    expect(auth.header()).toEqual(['authorization', 'Bearer tok-1']);
  });
});
