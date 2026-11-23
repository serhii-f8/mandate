// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Mandate Authors
import { afterEach, describe, expect, it } from 'vitest';
import type { HttpRequestSpec } from '../openapi/request.js';
import type { Transport } from './client.js';
import { clearTokenCache, clientCredentialsToken, oauthToken, type OAuthTokenParams } from './oauth.js';

afterEach(() => {
  clearTokenCache();
});

describe('CONN-3 token cache', () => {
  it('CONN-3 a rejecting transport rejects the caller without an unhandled rejection', async () => {
    const p = { tokenUrl: 'http://idp.test/token', clientId: 'c', clientSecret: 's', scopes: [], timeoutMs: 100 };
    await expect(clientCredentialsToken('oauth-reject', p, { now: Date.now }, () => Promise.reject(new Error('boom')))).rejects.toThrow('boom');
    // Let any stray promise settle inside this test so an unhandled rejection is attributed here.
    await new Promise((resolve) => setTimeout(resolve, 10));
  });
});

describe('CONN-3 password grant', () => {
  const base = { tokenUrl: 'http://idp.test/token', clientId: 'cid', clientSecret: 'csec', scopes: ['a', 'b'], timeoutMs: 100 };
  const grant = (username: string, password: string) => ({ kind: 'password', username, password }) as const;

  function recording(status: 'ok' | number = 'ok'): { transport: Transport; seen: HttpRequestSpec[] } {
    const seen: HttpRequestSpec[] = [];
    const transport: Transport = (spec) => {
      seen.push(spec);
      return Promise.resolve(
        status === 'ok'
          ? { kind: 'response', status: 200, headers: {}, json: { access_token: 'tok', expires_in: 60 } }
          : { kind: 'status', status, headers: {} },
      );
    };
    return { transport, seen };
  }

  it('CONN-3 basic client auth sends the password grant and a Basic header', async () => {
    const { transport, seen } = recording();
    const p: OAuthTokenParams = { ...base, grant: grant('alice', 'pw'), clientAuth: 'basic' };
    const r = await oauthToken('pw-basic', p, { now: () => 0 }, transport);
    expect(r).toMatchObject({ ok: true, accessToken: 'tok' });
    const spec = seen[0];
    expect(spec?.body).toBe('grant_type=password&username=alice&password=pw&scope=a+b');
    expect(spec?.headers.authorization).toBe(`Basic ${Buffer.from('cid:csec').toString('base64')}`);
  });

  it('CONN-3 body client auth puts the client in the form and sends no authorization header', async () => {
    const { transport, seen } = recording();
    const p: OAuthTokenParams = { ...base, grant: grant('alice', 'pw'), clientAuth: 'body' };
    await oauthToken('pw-body', p, { now: () => 0 }, transport);
    const form = new URLSearchParams(String(seen[0]?.body ?? ''));
    expect(form.get('grant_type')).toBe('password');
    expect(form.get('client_id')).toBe('cid');
    expect(form.get('client_secret')).toBe('csec');
    expect(Object.keys(seen[0]?.headers ?? {}).map((k) => k.toLowerCase())).not.toContain('authorization');
  });

  it('CONN-3 form-encodes a user name and password with reserved and non-ASCII characters', async () => {
    const { transport, seen } = recording();
    const p: OAuthTokenParams = { ...base, scopes: [], grant: grant('a&b=c', 'p +\u00fc'), clientAuth: 'basic' };
    await oauthToken('pw-enc', p, { now: () => 0 }, transport);
    expect(seen[0]?.body).toBe('grant_type=password&username=a%26b%3Dc&password=p+%2B%C3%BC');
  });

  it('CONN-3 a 400 from the token endpoint is credential_unusable', async () => {
    const { transport } = recording(400);
    const p: OAuthTokenParams = { ...base, grant: grant('alice', 'wrong'), clientAuth: 'basic' };
    expect(await oauthToken('pw-400', p, { now: () => 0 }, transport)).toEqual({
      ok: false,
      code: 'credential_unusable',
      status: 400,
      message: 'token endpoint returned status 400',
    });
  });

  it('CONN-3 changing only the password fetches a new token', async () => {
    const { transport, seen } = recording();
    const p: OAuthTokenParams = { ...base, grant: grant('alice', 'one'), clientAuth: 'basic' };
    await oauthToken('pw-fp', p, { now: () => 0 }, transport);
    await oauthToken('pw-fp', p, { now: () => 0 }, transport);
    expect(seen).toHaveLength(1);
    await oauthToken('pw-fp', { ...p, grant: grant('alice', 'two') }, { now: () => 0 }, transport);
    expect(seen).toHaveLength(2);
  });
});
