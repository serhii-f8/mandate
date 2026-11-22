// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Mandate Authors
import { createHash } from 'node:crypto';
import { createLocalJWKSet, exportJWK, generateKeyPair, SignJWT, type CryptoKey } from 'jose';
import { beforeAll, describe, expect, it } from 'vitest';
import { createOidcClient, type OidcClient } from './oidc-client.js';

const ISSUER = 'https://idp.example.test/realms/mandate';
const CLIENT_ID = 'mandate-web';
const SECRET = 'unit-only-secret:with/special';
const REDIRECT = 'https://mandate.example.test/auth/callback';

let privateKey: CryptoKey;
let otherKey: CryptoKey;
let jwks: ReturnType<typeof createLocalJWKSet>;

beforeAll(async () => {
  const pair = await generateKeyPair('RS256');
  privateKey = pair.privateKey;
  otherKey = (await generateKeyPair('RS256')).privateKey;
  jwks = createLocalJWKSet({ keys: [{ ...(await exportJWK(pair.publicKey)), kid: 'k1', alg: 'RS256' }] });
});

interface Claims {
  iss?: string;
  aud?: string;
  azp?: string;
  nonce?: string;
  auth_time?: number | null;
  groups?: unknown;
  sub?: string;
  preferred_username?: string;
  key?: CryptoKey;
}

async function idToken(claims: Claims = {}): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  const payload: Record<string, unknown> = {
    nonce: claims.nonce ?? 'nonce-1',
    azp: claims.azp ?? CLIENT_ID,
    groups: claims.groups ?? ['admins'],
    preferred_username: claims.preferred_username ?? 'carol',
  };
  if (claims.auth_time !== null) payload.auth_time = claims.auth_time ?? now - 10;
  return new SignJWT(payload)
    .setProtectedHeader({ alg: 'RS256', kid: 'k1' })
    .setIssuer(claims.iss ?? ISSUER)
    .setAudience(claims.aud ?? CLIENT_ID)
    .setSubject(claims.sub ?? 'carol-id')
    .setIssuedAt(now)
    .setExpirationTime(now + 60)
    .sign(claims.key ?? privateKey);
}

interface Recorded {
  url: string;
  headers: Headers;
  body: URLSearchParams;
}

function clientWith(respond: (r: Recorded) => Promise<Response> | Response, sent: Recorded[] = []): OidcClient {
  return createOidcClient({
    authorizationUrl: new URL(`${ISSUER}/protocol/openid-connect/auth`),
    tokenUrl: new URL('http://keycloak:8080/realms/mandate/protocol/openid-connect/token'),
    issuer: ISSUER,
    clientId: CLIENT_ID,
    clientSecret: SECRET,
    redirectUri: REDIRECT,
    jwks,
    fetch: async (input, init) => {
      const body = typeof init?.body === 'string' ? init.body : '';
      const recorded = { url: input instanceof URL ? input.href : typeof input === 'string' ? input : input.url, headers: new Headers(init?.headers), body: new URLSearchParams(body) };
      sent.push(recorded);
      return respond(recorded);
    },
  });
}

const json = (status: number, body: unknown): Response => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

describe('AUTH-5 OIDC client for trusted pages', () => {
  it('AUTH-5 builds an authorization request with S256 PKCE, state, nonce and scope openid', () => {
    const request = clientWith(() => json(500, {})).authorizationRequest({ fresh: false });
    const q = request.url.searchParams;
    expect(`${request.url.origin}${request.url.pathname}`).toBe(`${ISSUER}/protocol/openid-connect/auth`);
    expect(q.get('response_type')).toBe('code');
    expect(q.get('client_id')).toBe(CLIENT_ID);
    expect(q.get('redirect_uri')).toBe(REDIRECT);
    expect(q.get('scope')).toBe('openid');
    expect(q.get('code_challenge_method')).toBe('S256');
    expect(q.get('code_challenge')).toBe(createHash('sha256').update(request.codeVerifier).digest('base64url'));
    expect(q.get('state')).toBe(request.state);
    expect(q.get('nonce')).toBe(request.nonce);
    expect(q.has('prompt')).toBe(false);
    expect(q.has('max_age')).toBe(false);
    // 256-bit random values, base64url.
    for (const value of [request.state, request.nonce, request.codeVerifier]) expect(value).toMatch(/^[A-Za-z0-9_-]{43}$/);
  });

  it('AUTH-5 SEC-8 a fresh request forces the login form (prompt=login, max_age=0)', () => {
    const q = clientWith(() => json(500, {})).authorizationRequest({ fresh: true }).url.searchParams;
    expect(q.get('prompt')).toBe('login');
    expect(q.get('max_age')).toBe('0');
  });

  it('AUTH-5 exchanges the code with client_secret_basic and the verifier, and returns the verified identity', async () => {
    const sent: Recorded[] = [];
    const token = await idToken();
    const result = await clientWith(() => json(200, { id_token: token, access_token: 'unused' }), sent).exchange({ code: 'c-1', codeVerifier: 'v-1', nonce: 'nonce-1' });
    expect(result).toEqual({
      ok: true,
      identity: { subject: 'carol-id', username: 'carol', clientId: CLIENT_ID, groups: ['admins'], authTime: expect.any(Date) as unknown },
    });
    expect(sent).toHaveLength(1);
    const [request] = sent;
    expect(request?.url).toBe('http://keycloak:8080/realms/mandate/protocol/openid-connect/token');
    const basic = Buffer.from(`${encodeURIComponent(CLIENT_ID)}:${encodeURIComponent(SECRET)}`).toString('base64');
    expect(request?.headers.get('authorization')).toBe(`Basic ${basic}`);
    expect(Object.fromEntries(request?.body ?? [])).toEqual({ grant_type: 'authorization_code', code: 'c-1', redirect_uri: REDIRECT, code_verifier: 'v-1' });
  });

  it('AUTH-5 a refused or unreachable token endpoint is code_exchange_failed', async () => {
    expect(await clientWith(() => json(400, { error: 'invalid_grant' })).exchange({ code: 'c', codeVerifier: 'v', nonce: 'nonce-1' })).toEqual({ ok: false, reason: 'code_exchange_failed' });
    expect(await clientWith(() => json(200, { access_token: 'x' })).exchange({ code: 'c', codeVerifier: 'v', nonce: 'nonce-1' })).toEqual({ ok: false, reason: 'code_exchange_failed' });
    expect(
      await clientWith(() => {
        throw new Error('connect ECONNREFUSED');
      }).exchange({ code: 'c', codeVerifier: 'v', nonce: 'nonce-1' }),
    ).toEqual({ ok: false, reason: 'code_exchange_failed' });
  });

  it.each<[string, Claims]>([
    ['wrong nonce', { nonce: 'other' }],
    ['wrong audience', { aud: 'mandate-mcp' }],
    ['wrong issuer', { iss: 'https://evil.example.test/realms/mandate' }],
    ['another authorized party', { azp: 'mandate-mcp' }],
    ['no auth_time', { auth_time: null }],
    ['unpublished signing key', {}],
  ])('AUTH-5 an ID token with %s is id_token_invalid', async (name, claims) => {
    const token = await idToken(name === 'unpublished signing key' ? { key: otherKey } : claims);
    expect(await clientWith(() => json(200, { id_token: token })).exchange({ code: 'c', codeVerifier: 'v', nonce: 'nonce-1' })).toEqual({ ok: false, reason: 'id_token_invalid' });
  });

  it.each(['service:mandate-sa-ci', 'service:'])('AUTH-4 AUTH-5 an ID token whose sub starts with service: is refused (%s)', async (sub) => {
    const token = await idToken({ sub });
    expect(await clientWith(() => json(200, { id_token: token })).exchange({ code: 'c', codeVerifier: 'v', nonce: 'nonce-1' })).toEqual({ ok: false, reason: 'id_token_invalid' });
  });

  it('AUTH-5 groups that are not a list of strings become no groups', async () => {
    const token = await idToken({ groups: 'admins' });
    const result = await clientWith(() => json(200, { id_token: token })).exchange({ code: 'c', codeVerifier: 'v', nonce: 'nonce-1' });
    expect(result.ok && result.identity.groups).toEqual([]);
  });
});
