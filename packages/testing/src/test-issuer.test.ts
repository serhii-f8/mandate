import { createRemoteJWKSet, decodeJwt, jwtVerify } from 'jose';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startTestIssuer, type TestIssuer } from './test-issuer.js';

let issuer: TestIssuer;

beforeAll(async () => {
  issuer = await startTestIssuer();
});

afterAll(async () => {
  await issuer.close();
});

describe('test issuer', () => {
  it('signs tokens that verify against its JWKS over HTTP', async () => {
    const token = await issuer.token({ sub: 'alice', groups: ['content'], aud: 'http://127.0.0.1:1/mcp', azp: 'aiops-mcp' });
    const { payload } = await jwtVerify(token, createRemoteJWKSet(new URL(issuer.jwksUrl)), { issuer: issuer.issuer });
    expect(payload).toMatchObject({ sub: 'alice', groups: ['content'], aud: 'http://127.0.0.1:1/mcp', azp: 'aiops-mcp' });
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
