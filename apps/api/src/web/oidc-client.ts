import { createHash, randomBytes } from 'node:crypto';
import { SERVICE_SUBJECT_PREFIX } from '@aiops/core';
import { jwtVerify, type JWTVerifyGetKey } from 'jose';
import { z } from 'zod';

/** The identity a verified ID token establishes; nothing else from the IdP is kept (AUTH-7). */
export interface OidcIdentity {
  readonly subject: string;
  readonly username?: string;
  /** `azp`: the client the user logged in to. */
  readonly clientId: string;
  readonly groups: string[];
  readonly authTime: Date;
}

/** Fixed, value-free failure reasons recorded in `auth.login` audit rows. */
export type ExchangeFailure = 'code_exchange_failed' | 'id_token_invalid';
export type ExchangeResult = { readonly ok: true; readonly identity: OidcIdentity } | { readonly ok: false; readonly reason: ExchangeFailure };

export interface AuthorizationRequest {
  readonly url: URL;
  readonly state: string;
  readonly codeVerifier: string;
  readonly nonce: string;
}

export interface OidcClient {
  authorizationRequest(options: { readonly fresh: boolean }): AuthorizationRequest;
  exchange(input: { readonly code: string; readonly codeVerifier: string; readonly nonce: string }): Promise<ExchangeResult>;
}

export interface OidcClientOptions {
  /** Browser-facing authorization endpoint. */
  readonly authorizationUrl: URL;
  /** Token endpoint the api calls (may be an internal URL; the ID token still names the public issuer). */
  readonly tokenUrl: URL;
  readonly issuer: string;
  readonly clientId: string;
  readonly clientSecret: string;
  readonly redirectUri: string;
  readonly jwks: JWTVerifyGetKey;
  readonly fetch?: typeof fetch;
  readonly timeoutMs?: number;
}

const ALGORITHMS = ['RS256', 'PS256', 'ES256'];
const tokenResponse = z.object({ id_token: z.string().min(1) });

/** 256 bits of randomness, base64url (RFC 7636 §4.1 verifier length 43). */
export const randomToken = (): string => randomBytes(32).toString('base64url');

/** RFC 6749 §2.3.1: both parts form-urlencoded before Basic encoding. */
function basicAuth(id: string, secret: string): string {
  const enc = (v: string) => encodeURIComponent(v).replace(/%20/g, '+');
  return `Basic ${Buffer.from(`${enc(id)}:${enc(secret)}`).toString('base64')}`;
}

/**
 * Authorization code flow with PKCE S256 for the confidential `aiops-web` client (AUTH-5,
 * ADR 0019). The ID token is verified against the issuer's JWKS: issuer, audience = this
 * client, `azp` (when present) = this client, nonce, expiry and `auth_time`.
 */
export function createOidcClient(options: OidcClientOptions): OidcClient {
  const doFetch = options.fetch ?? fetch;
  return {
    authorizationRequest({ fresh }) {
      const state = randomToken();
      const nonce = randomToken();
      const codeVerifier = randomToken();
      const url = new URL(options.authorizationUrl);
      url.searchParams.set('response_type', 'code');
      url.searchParams.set('client_id', options.clientId);
      url.searchParams.set('redirect_uri', options.redirectUri);
      url.searchParams.set('scope', 'openid');
      url.searchParams.set('state', state);
      url.searchParams.set('nonce', nonce);
      url.searchParams.set('code_challenge', createHash('sha256').update(codeVerifier).digest('base64url'));
      url.searchParams.set('code_challenge_method', 'S256');
      if (fresh) {
        // SEC-8: the IdP must show the login form again and report a new auth_time.
        url.searchParams.set('prompt', 'login');
        url.searchParams.set('max_age', '0');
      }
      return { url, state, codeVerifier, nonce };
    },

    async exchange({ code, codeVerifier, nonce }) {
      let idToken: string;
      try {
        const response = await doFetch(options.tokenUrl, {
          method: 'POST',
          headers: {
            authorization: basicAuth(options.clientId, options.clientSecret),
            'content-type': 'application/x-www-form-urlencoded',
            accept: 'application/json',
          },
          body: new URLSearchParams({ grant_type: 'authorization_code', code, redirect_uri: options.redirectUri, code_verifier: codeVerifier }).toString(),
          signal: AbortSignal.timeout(options.timeoutMs ?? 10_000),
        });
        if (!response.ok) return { ok: false, reason: 'code_exchange_failed' };
        const parsed = tokenResponse.safeParse(await response.json());
        if (!parsed.success) return { ok: false, reason: 'code_exchange_failed' };
        idToken = parsed.data.id_token;
      } catch {
        return { ok: false, reason: 'code_exchange_failed' };
      }

      try {
        const { payload } = await jwtVerify(idToken, options.jwks, {
          issuer: options.issuer,
          audience: options.clientId,
          algorithms: ALGORITHMS,
          requiredClaims: ['sub', 'exp', 'iat', 'auth_time', 'nonce'],
          clockTolerance: 0,
        });
        const { sub, azp, groups, preferred_username: username } = payload;
        const authTime = payload.auth_time;
        if (typeof sub !== 'string' || sub === '' || payload.nonce !== nonce || typeof authTime !== 'number') {
          return { ok: false, reason: 'id_token_invalid' };
        }
        // The `service:` namespace belongs to service accounts (AUTH-4); a page session never takes it.
        if (sub.startsWith(SERVICE_SUBJECT_PREFIX)) return { ok: false, reason: 'id_token_invalid' };
        if (azp !== undefined && azp !== options.clientId) return { ok: false, reason: 'id_token_invalid' };
        const identity: OidcIdentity = {
          subject: sub,
          clientId: options.clientId,
          groups: Array.isArray(groups) && groups.every((g) => typeof g === 'string') ? groups : [],
          authTime: new Date(authTime * 1000),
          ...(typeof username === 'string' && username !== '' ? { username } : {}),
        };
        return { ok: true, identity };
      } catch {
        return { ok: false, reason: 'id_token_invalid' };
      }
    },
  };
}
