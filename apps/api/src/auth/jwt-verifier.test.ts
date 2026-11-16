import { OAuthError } from '@modelcontextprotocol/server';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startTestIssuer, type TestIssuer } from '@aiops/testing';
import { createJwtVerifier, rejectionReason } from './jwt-verifier.js';

const RESOURCE = 'https://aiops.example.test/mcp';
let issuer: TestIssuer;
let verify: (token: string) => ReturnType<ReturnType<typeof createJwtVerifier>['verifyAccessToken']>;

beforeAll(async () => {
  issuer = await startTestIssuer();
  const verifier = createJwtVerifier({ issuer: issuer.issuer, audience: RESOURCE, jwks: issuer.localJwks });
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
    const token = await issuer.token({ sub: 'alice-id', groups: ['content'], aud: RESOURCE, azp: 'aiops-mcp' });
    const info = await verify(token);
    expect(info.clientId).toBe('aiops-mcp');
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
