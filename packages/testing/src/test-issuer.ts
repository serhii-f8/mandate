/**
 * A stand-in OAuth authorization server for tests: an RS256 key pair whose JWKS
 * is served over HTTP on 127.0.0.1, a signer for access tokens with any claims, and
 * authorization + token endpoints for the trusted-page client (AUTH-5) that approve a
 * configured user without a form and issue ID tokens. The real Keycloak path is tested
 * separately (`keycloak.ts`).
 */
import { createHash, randomUUID } from 'node:crypto';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { createLocalJWKSet, exportJWK, generateKeyPair, SignJWT, type JWTVerifyGetKey } from 'jose';

export interface TestTokenClaims {
  readonly sub?: string;
  readonly groups?: unknown;
  readonly aud?: string | string[];
  readonly azp?: string;
  /** Session id; user tokens carry one, client-credentials tokens do not. */
  readonly sid?: string;
  /** Present on client-credentials tokens. */
  readonly client_id?: string;
  /** Seconds from now; negative for an expired token. Default 300. */
  readonly expiresIn?: number;
  /** Overrides the issuer claim. */
  readonly iss?: string;
}

/** The confidential page client the test issuer knows (matches the api e2e environment). */
export const TEST_WEB_CLIENT_ID = 'aiops-web';
export const TEST_WEB_CLIENT_SECRET = 'test-only-web-client-secret';

/** The user the authorization endpoint approves without a form. */
export interface TestLoginUser {
  readonly sub: string;
  readonly username?: string;
  readonly groups?: unknown;
  /** `auth_time` in seconds since the epoch; default: the time of the authorization request. A fresh request (`prompt=login` or `max_age=0`) always uses the current time. */
  readonly authTime?: number;
}

/** Changes to the next ID tokens, for negative tests. */
export interface IdTokenTamper {
  readonly nonce?: string;
  readonly aud?: string;
  readonly iss?: string;
  readonly omitAuthTime?: boolean;
  readonly unpublishedKey?: boolean;
}

export interface RecordedTokenRequest {
  readonly authorization: string | undefined;
  readonly body: URLSearchParams;
}

export interface TestIssuer {
  readonly issuer: string;
  readonly jwksUrl: string;
  /** `${issuer}/protocol/openid-connect/auth` and `/token`, as Keycloak lays them out. */
  readonly authorizationUrl: string;
  readonly tokenUrl: string;
  /** The same key set, without HTTP. */
  readonly localJwks: JWTVerifyGetKey;
  token(claims: TestTokenClaims, options?: { unpublishedKey?: boolean }): Promise<string>;
  /** The user the next authorizations approve; `undefined` answers `error=access_denied`. */
  setLoginUser(user: TestLoginUser | undefined): void;
  tamperIdToken(tamper: IdTokenTamper | undefined): void;
  /** The query of every authorization request, in order. */
  readonly authorizations: URLSearchParams[];
  readonly tokenRequests: RecordedTokenRequest[];
  close(): Promise<void>;
}

interface IssuedCode {
  readonly clientId: string;
  readonly redirectUri: string;
  readonly challenge: string;
  readonly nonce: string | null;
  readonly user: TestLoginUser;
  readonly authTime: number;
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      resolve(Buffer.concat(chunks).toString('utf8'));
    });
    req.on('error', reject);
  });
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(body));
}

function basicCredentials(header: string | undefined): { id: string; secret: string } | undefined {
  if (header?.startsWith('Basic ') !== true) return undefined;
  const decoded = Buffer.from(header.slice(6), 'base64').toString('utf8');
  const i = decoded.indexOf(':');
  if (i < 0) return undefined;
  const dec = (v: string) => decodeURIComponent(v.replace(/\+/g, ' '));
  return { id: dec(decoded.slice(0, i)), secret: dec(decoded.slice(i + 1)) };
}

export async function startTestIssuer(): Promise<TestIssuer> {
  const kid = randomUUID();
  const published = await generateKeyPair('RS256');
  const unpublished = await generateKeyPair('RS256');
  const jwk = { ...(await exportJWK(published.publicKey)), kid, alg: 'RS256', use: 'sig' };
  const jwks = { keys: [jwk] };

  let loginUser: TestLoginUser | undefined;
  let tamper: IdTokenTamper | undefined;
  const codes = new Map<string, IssuedCode>();
  const authorizations: URLSearchParams[] = [];
  const tokenRequests: RecordedTokenRequest[] = [];
  // Assigned once the server listens; the handlers run only after that.
  let issuer = '';

  const authorize = (url: URL, res: ServerResponse): void => {
    const q = url.searchParams;
    authorizations.push(new URLSearchParams(q));
    const redirectUri = q.get('redirect_uri');
    const challenge = q.get('code_challenge');
    if (q.get('response_type') !== 'code' || q.get('client_id') !== TEST_WEB_CLIENT_ID || redirectUri === null || challenge === null || q.get('code_challenge_method') !== 'S256') {
      sendJson(res, 400, { error: 'invalid_request' });
      return;
    }
    const target = new URL(redirectUri);
    const state = q.get('state');
    if (state !== null) target.searchParams.set('state', state);
    if (loginUser === undefined) {
      target.searchParams.set('error', 'access_denied');
    } else {
      const now = Math.floor(Date.now() / 1000);
      const fresh = q.get('prompt') === 'login' || q.get('max_age') === '0';
      const code = randomUUID();
      codes.set(code, { clientId: TEST_WEB_CLIENT_ID, redirectUri, challenge, nonce: q.get('nonce'), user: loginUser, authTime: fresh ? now : (loginUser.authTime ?? now) });
      target.searchParams.set('code', code);
    }
    res.writeHead(302, { location: target.toString() }).end();
  };

  const exchange = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    const body = new URLSearchParams(await readBody(req));
    tokenRequests.push({ authorization: req.headers.authorization, body });
    const client = basicCredentials(req.headers.authorization);
    if (client?.id !== TEST_WEB_CLIENT_ID || client.secret !== TEST_WEB_CLIENT_SECRET) {
      sendJson(res, 401, { error: 'unauthorized_client' });
      return;
    }
    const code = body.get('code') ?? '';
    const issued = codes.get(code);
    codes.delete(code);
    const verifier = body.get('code_verifier') ?? '';
    if (issued === undefined) {
      sendJson(res, 400, { error: 'invalid_grant' });
      return;
    }
    if (
      body.get('grant_type') !== 'authorization_code' ||
      issued.redirectUri !== body.get('redirect_uri') ||
      createHash('sha256').update(verifier).digest('base64url') !== issued.challenge
    ) {
      sendJson(res, 400, { error: 'invalid_grant' });
      return;
    }
    const now = Math.floor(Date.now() / 1000);
    const claims: Record<string, unknown> = { azp: issued.clientId, typ: 'ID' };
    const nonce = tamper?.nonce ?? issued.nonce;
    if (nonce !== null) claims.nonce = nonce;
    if (tamper?.omitAuthTime !== true) claims.auth_time = issued.authTime;
    if (issued.user.groups !== undefined) claims.groups = issued.user.groups;
    if (issued.user.username !== undefined) claims.preferred_username = issued.user.username;
    const idToken = await new SignJWT(claims)
      .setProtectedHeader({ alg: 'RS256', kid, typ: 'JWT' })
      .setIssuer(tamper?.iss ?? issuer)
      .setAudience(tamper?.aud ?? issued.clientId)
      .setSubject(issued.user.sub)
      .setIssuedAt(now)
      .setExpirationTime(now + 300)
      .setJti(randomUUID())
      .sign(tamper?.unpublishedKey === true ? unpublished.privateKey : published.privateKey);
    sendJson(res, 200, { access_token: 'test-only-unused-access-token', token_type: 'Bearer', expires_in: 300, id_token: idToken });
  };

  const server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1');
    if (url.pathname === '/jwks') {
      sendJson(res, 200, jwks);
      return;
    }
    if (req.method === 'GET' && url.pathname === '/realms/test/protocol/openid-connect/auth') {
      authorize(url, res);
      return;
    }
    if (req.method === 'POST' && url.pathname === '/realms/test/protocol/openid-connect/token') {
      exchange(req, res).catch(() => {
        sendJson(res, 500, { error: 'server_error' });
      });
      return;
    }
    res.writeHead(404).end();
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  const base = `http://127.0.0.1:${String(port)}`;
  issuer = `${base}/realms/test`;

  return {
    issuer,
    jwksUrl: `${base}/jwks`,
    authorizationUrl: `${issuer}/protocol/openid-connect/auth`,
    tokenUrl: `${issuer}/protocol/openid-connect/token`,
    localJwks: createLocalJWKSet(jwks),
    setLoginUser(user) {
      loginUser = user;
    },
    tamperIdToken(next) {
      tamper = next;
    },
    authorizations,
    tokenRequests,
    async token(claims, options = {}) {
      const payload: Record<string, unknown> = {};
      if (claims.groups !== undefined) payload.groups = claims.groups;
      if (claims.azp !== undefined) payload.azp = claims.azp;
      if (claims.sid !== undefined) payload.sid = claims.sid;
      if (claims.client_id !== undefined) payload.client_id = claims.client_id;
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
