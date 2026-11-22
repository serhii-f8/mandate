// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Mandate Authors
import { OAuthError } from '@modelcontextprotocol/server';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { exportJWK, generateKeyPair, SignJWT, createLocalJWKSet } from 'jose';
import { startTestIssuer, type TestIssuer } from '@mandate/testing';
import { callerFromAuthInfo } from './caller-from-auth.js';
import { createJwtVerifier, rejectionReason } from './jwt-verifier.js';

const RESOURCE = 'https://mandate.example.test/mcp';
let issuer: TestIssuer;
let verify: (token: string) => ReturnType<ReturnType<typeof createJwtVerifier>['verifyAccessToken']>;

beforeAll(async () => {
  issuer = await startTestIssuer();
  const verifier = createJwtVerifier({ issuer: issuer.issuer, audience: RESOURCE, jwks: issuer.localJwks, isServiceAccount: (id) => id === 'mandate-sa-ci' });
  verify = (token) => verifier.verifyAccessToken(token);
});

afterAll(async () => {
  await issuer.close();
});

async function reason(token: string): Promise<string> {
  const error = await verify(token).then(
    () => undefined,
    (e: unknown) => e,
  );
  expect(error).toBeInstanceOf(OAuthError);
  return rejectionReason(error);
}

function b64url(value: unknown): string {
  return Buffer.from(JSON.stringify(value)).toString('base64url');
}

describe('AUTH-1 access token validation', () => {
  it('accepts a token for this resource and reports the resource, client and expiry', async () => {
    const token = await issuer.token({ sub: 'alice-id', groups: ['content'], aud: RESOURCE, azp: 'mandate-mcp' });
    const info = await verify(token);
    expect(info.clientId).toBe('mandate-mcp');
    expect(info.resource?.href).toBe(RESOURCE);
    expect(typeof info.expiresAt).toBe('number');
    expect(info.extra).toEqual({ sub: 'alice-id', groups: ['content'] });
    expect(info.token).toBe('');
  });

  it('accepts an audience array that contains this resource', async () => {
    await expect(verify(await issuer.token({ sub: 'a', aud: ['account', RESOURCE] }))).resolves.toBeDefined();
  });

  it('rejects an expired token', async () => {
    expect(await reason(await issuer.token({ sub: 'a', aud: RESOURCE, expiresIn: -5 }))).toBe('expired');
  });

  it('rejects another issuer', async () => {
    expect(await reason(await issuer.token({ sub: 'a', aud: RESOURCE, iss: 'https://evil.example.test/realms/x' }))).toBe('invalid_issuer');
  });

  it('rejects a token for another audience of the same realm', async () => {
    expect(await reason(await issuer.token({ sub: 'a', aud: 'account' }))).toBe('invalid_audience');
  });

  it('rejects a tampered payload', async () => {
    const [header, , signature] = (await issuer.token({ sub: 'a', aud: RESOURCE, groups: ['support'] })).split('.');
    const forged = `${header ?? ''}.${b64url({ sub: 'a', aud: RESOURCE, iss: issuer.issuer, groups: ['admin'], exp: Math.floor(Date.now() / 1000) + 300 })}.${signature ?? ''}`;
    expect(await reason(forged)).toBe('invalid_signature');
  });

  it('rejects a key that is not in the JWKS', async () => {
    expect(await reason(await issuer.token({ sub: 'a', aud: RESOURCE }, { unpublishedKey: true }))).toBe('invalid_signature');
  });

  it('rejects a token without sub', async () => {
    expect(await reason(await issuer.token({ aud: RESOURCE }))).toBe('malformed');
  });

  it('rejects an unsigned token (alg none)', async () => {
    const unsigned = `${b64url({ alg: 'none', typ: 'JWT' })}.${b64url({ sub: 'a', aud: RESOURCE, iss: issuer.issuer, exp: Math.floor(Date.now() / 1000) + 300 })}.`;
    expect(await reason(unsigned)).toMatch(/malformed|invalid_signature/);
  });

  it('rejects garbage', async () => {
    expect(await reason('not-a-jwt')).toBe('malformed');
  });
});

describe('AUTH-4 AUTH-1 service token classification', () => {
  it('AUTH-4 a configured client with matching client_id and no sid is a service caller', async () => {
    const info = await verify(await issuer.token({ sub: 'kc-sa-user-id', aud: RESOURCE, azp: 'mandate-sa-ci', client_id: 'mandate-sa-ci', groups: ['content'] }));
    expect(info.extra).toEqual({ sub: 'kc-sa-user-id', groups: [], service: 'mandate-sa-ci' });
    expect(callerFromAuthInfo(info)).toEqual({ subject: 'service:mandate-sa-ci', clientId: 'mandate-sa-ci', groups: [] });
  });

  it.each([
    ['a configured azp without client_id', { azp: 'mandate-sa-ci' }],
    ['client_id other than azp', { azp: 'mandate-sa-ci', client_id: 'other' }],
    ['a configured azp with sid (a user token of the service client)', { azp: 'mandate-sa-ci', client_id: 'mandate-sa-ci', sid: 's-1' }],
  ])('AUTH-4 %s is rejected as service_account_mismatch', async (_name, claims) => {
    expect(await reason(await issuer.token({ sub: 'u-1', aud: RESOURCE, groups: ['content'], ...claims }))).toBe('service_account_mismatch');
  });

  it.each(['service:mandate-sa-ci', 'service:'])('AUTH-4 a user token whose sub starts with service: is rejected as reserved_subject (%s)', async (sub) => {
    expect(await reason(await issuer.token({ sub, aud: RESOURCE, azp: 'mandate-mcp', sid: 's-1' }))).toBe('reserved_subject');
  });

  it('AUTH-4 a bad signature still answers invalid_signature before the classification', async () => {
    expect(await reason(await issuer.token({ sub: 'service:x', aud: RESOURCE, azp: 'mandate-sa-ci' }, { unpublishedKey: true }))).toBe('invalid_signature');
  });

  it('AUTH-4 POL-1 a client-credentials token of an unconfigured client has no groups', async () => {
    const info = await verify(await issuer.token({ sub: 'kc-x-user-id', aud: RESOURCE, azp: 'x', client_id: 'x', groups: ['content'] }));
    expect(info.extra).toEqual({ sub: 'kc-x-user-id', groups: [] });
    expect(callerFromAuthInfo(info)).toEqual({ subject: 'kc-x-user-id', clientId: 'x', groups: [] });
  });

  it('AUTH-4 a user token named service-account-x stays a user', async () => {
    // The test issuer has no preferred_username claim, so this token is signed with a local key.
    const { privateKey, publicKey } = await generateKeyPair('RS256');
    const jwk = { ...(await exportJWK(publicKey)), kid: 'k-local', alg: 'RS256' };
    const verifier = createJwtVerifier({ issuer: issuer.issuer, audience: RESOURCE, jwks: createLocalJWKSet({ keys: [jwk] }), isServiceAccount: (id) => id === 'mandate-sa-ci' });
    const token = await new SignJWT({ preferred_username: 'service-account-mandate-sa-ci', azp: 'mandate-mcp', sid: 's-1', groups: ['content'] })
      .setProtectedHeader({ alg: 'RS256', kid: 'k-local' })
      .setIssuer(issuer.issuer)
      .setAudience(RESOURCE)
      .setSubject('alice-id')
      .setExpirationTime('5m')
      .sign(privateKey);
    const info = await verifier.verifyAccessToken(token);
    expect(info.extra).toEqual({ sub: 'alice-id', groups: ['content'] });
    expect(callerFromAuthInfo(info)).toEqual({ subject: 'alice-id', clientId: 'mandate-mcp', groups: ['content'] });
  });
});
