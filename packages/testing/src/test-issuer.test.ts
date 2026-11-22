// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Mandate Authors
import { createRemoteJWKSet, decodeJwt, jwtVerify } from 'jose';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { startTestIssuer, TEST_WEB_CLIENT_ID, TEST_WEB_CLIENT_SECRET, type TestIssuer } from './test-issuer.js';

let issuer: TestIssuer;

beforeAll(async () => {
  issuer = await startTestIssuer();
});

afterAll(async () => {
  await issuer.close();
});

describe('test issuer', () => {
  it('signs tokens that verify against its JWKS over HTTP', async () => {
    const token = await issuer.token({ sub: 'alice', groups: ['content'], aud: 'http://127.0.0.1:1/mcp', azp: 'mandate-mcp' });
    const { payload } = await jwtVerify(token, createRemoteJWKSet(new URL(issuer.jwksUrl)), { issuer: issuer.issuer });
    expect(payload).toMatchObject({ sub: 'alice', groups: ['content'], aud: 'http://127.0.0.1:1/mcp', azp: 'mandate-mcp' });
  });

  it('AUTH-4 the test issuer writes sid and client_id when given', async () => {
    const both = decodeJwt(await issuer.token({ sub: 'service:sa', aud: 'x', sid: 's-1', client_id: 'sa' }));
    expect(both.sid).toBe('s-1');
    expect(both.client_id).toBe('sa');
    const none = decodeJwt(await issuer.token({ sub: 'a', aud: 'x' }));
    expect('sid' in none).toBe(false);
    expect('client_id' in none).toBe(false);
  });

  it('defaults to a five-minute lifetime and honours an override', async () => {
    const now = Math.floor(Date.now() / 1000);
    expect(decodeJwt(await issuer.token({ sub: 'a', aud: 'x' })).exp).toBeGreaterThanOrEqual(now + 299);
    expect(decodeJwt(await issuer.token({ sub: 'a', aud: 'x', expiresIn: -10 })).exp).toBeLessThan(now);
  });

  it('can sign with a key that is not published', async () => {
    const token = await issuer.token({ sub: 'a', aud: 'x' }, { unpublishedKey: true });
    await expect(jwtVerify(token, issuer.localJwks)).rejects.toThrow();
  });
});

describe('test issuer page login endpoints (AUTH-5 fixtures)', () => {
  const verifier = 'v'.repeat(43);
  const authorize = (extra: Record<string, string> = {}) =>
    fetch(
      `${issuer.authorizationUrl}?${new URLSearchParams({
        response_type: 'code',
        client_id: TEST_WEB_CLIENT_ID,
        redirect_uri: 'http://127.0.0.1:1/auth/callback',
        state: 's-1',
        nonce: 'n-1',
        code_challenge: createHash('sha256').update(verifier).digest('base64url'),
        code_challenge_method: 'S256',
        ...extra,
      }).toString()}`,
      { redirect: 'manual' },
    );
  const exchange = (code: string, secret = TEST_WEB_CLIENT_SECRET) =>
    fetch(issuer.tokenUrl, {
      method: 'POST',
      headers: { authorization: `Basic ${Buffer.from(`${TEST_WEB_CLIENT_ID}:${secret}`).toString('base64')}`, 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ grant_type: 'authorization_code', code, redirect_uri: 'http://127.0.0.1:1/auth/callback', code_verifier: verifier }),
    });

  it('approves the configured user and issues a single-use code for an ID token', async () => {
    issuer.setLoginUser({ sub: 'carol-id', username: 'carol', groups: ['admins'], authTime: 1_000 });
    const location = new URL((await authorize()).headers.get('location') ?? '');
    expect(location.searchParams.get('state')).toBe('s-1');
    const code = location.searchParams.get('code') ?? '';
    const response = await exchange(code);
    const { id_token: idToken } = (await response.json()) as { id_token: string };
    const { payload } = await jwtVerify(idToken, issuer.localJwks, { issuer: issuer.issuer, audience: TEST_WEB_CLIENT_ID });
    expect(payload).toMatchObject({ sub: 'carol-id', nonce: 'n-1', auth_time: 1_000, groups: ['admins'], preferred_username: 'carol', azp: TEST_WEB_CLIENT_ID });
    expect((await exchange(code)).status).toBe(400);
  });

  it('uses the current time as auth_time for a fresh request, and refuses a wrong secret', async () => {
    issuer.setLoginUser({ sub: 'carol-id', authTime: 1_000 });
    const code = new URL((await authorize({ prompt: 'login', max_age: '0' })).headers.get('location') ?? '').searchParams.get('code') ?? '';
    expect((await exchange(code, 'wrong')).status).toBe(401);
    const fresh = new URL((await authorize({ prompt: 'login' })).headers.get('location') ?? '').searchParams.get('code') ?? '';
    const { id_token: idToken } = (await (await exchange(fresh)).json()) as { id_token: string };
    expect(decodeJwt(idToken).auth_time).toBeGreaterThan(Math.floor(Date.now() / 1000) - 5);
  });

  it('answers access_denied when no user is configured', async () => {
    issuer.setLoginUser(undefined);
    const location = new URL((await authorize()).headers.get('location') ?? '');
    expect(location.searchParams.get('error')).toBe('access_denied');
  });
});
