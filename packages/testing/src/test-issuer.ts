/**
 * A stand-in OAuth authorization server for tests: an RS256 key pair whose JWKS
 * is served over HTTP on 127.0.0.1, and a signer for access tokens with any
 * claims. The real Keycloak path is tested separately (`keycloak.ts`).
 */
import { randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { createLocalJWKSet, exportJWK, generateKeyPair, SignJWT, type JWTVerifyGetKey } from 'jose';

export interface TestTokenClaims {
  readonly sub?: string;
  readonly groups?: unknown;
  readonly aud?: string | string[];
  readonly azp?: string;
  /** Seconds from now; negative for an expired token. Default 300. */
  readonly expiresIn?: number;
  /** Overrides the issuer claim. */
  readonly iss?: string;
}

export interface TestIssuer {
  readonly issuer: string;
  readonly jwksUrl: string;
  /** The same key set, without HTTP. */
  readonly localJwks: JWTVerifyGetKey;
  token(claims: TestTokenClaims, options?: { unpublishedKey?: boolean }): Promise<string>;
  close(): Promise<void>;
}

export async function startTestIssuer(): Promise<TestIssuer> {
  const kid = randomUUID();
  const published = await generateKeyPair('RS256');
  const unpublished = await generateKeyPair('RS256');
  const jwk = { ...(await exportJWK(published.publicKey)), kid, alg: 'RS256', use: 'sig' };
  const jwks = { keys: [jwk] };

  const server = createServer((req, res) => {
    if (req.url === '/jwks') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(jwks));
      return;
    }
    res.writeHead(404).end();
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  const base = `http://127.0.0.1:${String(port)}`;
  const issuer = `${base}/realms/test`;

  return {
    issuer,
    jwksUrl: `${base}/jwks`,
    localJwks: createLocalJWKSet(jwks),
    async token(claims, options = {}) {
      const payload: Record<string, unknown> = {};
      if (claims.groups !== undefined) payload.groups = claims.groups;
      if (claims.azp !== undefined) payload.azp = claims.azp;
      const now = Math.floor(Date.now() / 1000);
      let jwt = new SignJWT(payload)
        .setProtectedHeader({ alg: 'RS256', kid, typ: 'JWT' })
        .setIssuer(claims.iss ?? issuer)
        .setIssuedAt(now)
        .setExpirationTime(now + (claims.expiresIn ?? 300))
        .setJti(randomUUID());
      if (claims.sub !== undefined) jwt = jwt.setSubject(claims.sub);
      if (claims.aud !== undefined) jwt = jwt.setAudience(claims.aud);
      return jwt.sign(options.unpublishedKey === true ? unpublished.privateKey : published.privateKey);
    },
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.close((error) => {
          if (error) reject(error);
          else resolve();
        });
      }),
  };
}
