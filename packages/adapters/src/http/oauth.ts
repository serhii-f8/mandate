// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Mandate Authors
import { createHash } from 'node:crypto';
import type { ReadErrorCode } from '@mandate/connector-sdk';
import { z } from 'zod';
import type { Transport } from './client.js';

/** A cached token is renewed this long before its `expires_in` runs out (spec §4.5). */
export const TOKEN_REFRESH_MARGIN_MS = 30_000;

const TokenResponse = z.object({
  access_token: z.string().min(1).max(16_384),
  expires_in: z.union([z.number().nonnegative(), z.string().regex(/^\d{1,10}$/).transform(Number)]).optional(),
  scope: z.string().max(16_384).optional(),
});

export interface ClientCredentialsParams {
  tokenUrl: string;
  clientId: string;
  clientSecret: string;
  scopes: readonly string[];
  timeoutMs: number;
}

export type TokenFetchResult =
  | { ok: true; accessToken: string; expiresInS?: number; scopes?: readonly string[] }
  | { ok: false; code: ReadErrorCode; status?: number; message: string };

/** Visible ASCII only: anything else cannot go into an HTTP header value safely (Node throws). */
export const HEADER_SAFE = /^[\x21-\x7e]+$/;

/** application/x-www-form-urlencoded encoding of one value (RFC 6749 appendix B). */
export function formEncode(value: string): string {
  return new URLSearchParams([['v', value]]).toString().slice(2);
}

/** The client_secret_basic header value (RFC 6749 §2.3.1): Base64 of the form-encoded id and secret. */
export function clientSecretBasicValue(clientId: string, clientSecret: string): string {
  return Buffer.from(`${formEncode(clientId)}:${formEncode(clientSecret)}`).toString('base64');
}

/** The grant a token request makes: client credentials (RFC 6749 §4.4) or resource owner password (§4.3). */
export type TokenGrant = { kind: 'client_credentials' } | { kind: 'password'; username: string; password: string };

export interface OAuthTokenParams extends ClientCredentialsParams {
  grant: TokenGrant;
  /** `basic`: client_secret_basic (§2.3.1). `body`: client_id and client_secret as form fields (§2.3.1, not recommended). */
  clientAuth: 'basic' | 'body';
}

/** Client credentials grant with client_secret_basic; kept for callers that need nothing else. */
export function fetchClientCredentialsToken(p: ClientCredentialsParams, transport: Transport): Promise<TokenFetchResult> {
  return fetchOAuthToken({ ...p, grant: { kind: 'client_credentials' }, clientAuth: 'basic' }, transport);
}

export async function fetchOAuthToken(p: OAuthTokenParams, transport: Transport): Promise<TokenFetchResult> {
  let url: URL;
  try {
    url = new URL(p.tokenUrl);
  } catch {
    return { ok: false, code: 'credential_unusable', message: 'token URL is not a valid URL' };
  }
  const form = new URLSearchParams({ grant_type: p.grant.kind });
  if (p.grant.kind === 'password') {
    form.set('username', p.grant.username);
    form.set('password', p.grant.password);
  }
  if (p.scopes.length > 0) form.set('scope', p.scopes.join(' '));
  const headers: Record<string, string> = { accept: 'application/json', 'content-type': 'application/x-www-form-urlencoded' };
  if (p.clientAuth === 'basic') {
    headers.authorization = `Basic ${clientSecretBasicValue(p.clientId, p.clientSecret)}`;
  } else {
    form.set('client_id', p.clientId);
    form.set('client_secret', p.clientSecret);
  }
  const r = await transport({ method: 'POST', url, headers, body: form.toString() }, p.timeoutMs);
  if (r.kind === 'error') return { ok: false, code: r.code, message: `token request failed: ${r.message}` };
  if (r.kind === 'status') {
    // 4xx: the client or its scopes are refused. 5xx (and odd statuses): the endpoint itself failed.
    const code: ReadErrorCode = r.status >= 400 && r.status < 500 ? 'credential_unusable' : 'http_status';
    return { ok: false, code, status: r.status, message: `token endpoint returned status ${r.status}` };
  }
  const parsed = TokenResponse.safeParse(r.json);
  if (!parsed.success) return { ok: false, code: 'invalid_response', message: 'token response has no usable access_token' };
  if (!HEADER_SAFE.test(parsed.data.access_token)) {
    return { ok: false, code: 'credential_unusable', message: 'token response access_token contains characters not allowed in a header' };
  }
  const out: TokenFetchResult = { ok: true, accessToken: parsed.data.access_token };
  if (parsed.data.expires_in !== undefined) out.expiresInS = parsed.data.expires_in;
  if (parsed.data.scope !== undefined) out.scopes = parsed.data.scope.split(' ').filter((s) => s !== '');
  return out;
}

interface CachedToken {
  /** Hash of token URL, client, scopes, grant and client authentication: a rotated credential never reuses an old token. */
  fingerprint: string;
  token: string;
  /** undefined: no `expires_in` was given; the token is kept until an upstream 401 replaces it. */
  renewAt: number | undefined;
}

// Per-process caches keyed by connection id. Never logged, never returned outside this module
// except the token handed to the caller that asked for it.
const tokens = new Map<string, CachedToken>();
const inflight = new Map<string, Promise<TokenFetchResult>>();
const scopesSeen = new Map<string, readonly string[]>();

/** Test hook: forget every cached token and recorded scope. */
export function clearTokenCache(): void {
  tokens.clear();
  inflight.clear();
  scopesSeen.clear();
}

/** The `scope` of the last token response for a connection (SEC-7), if it carried one. */
export function lastTokenScopes(connectionId: string): readonly string[] | undefined {
  return scopesSeen.get(connectionId);
}

function fingerprintOf(p: OAuthTokenParams): string {
  const grant = p.grant.kind === 'password' ? ['password', p.grant.username, p.grant.password] : ['client_credentials'];
  return createHash('sha256').update(JSON.stringify([p.tokenUrl, p.clientId, p.clientSecret, p.scopes, grant, p.clientAuth])).digest('hex');
}

/** Client credentials token with client_secret_basic, cached per connection; see `oauthToken`. */
export function clientCredentialsToken(
  connectionId: string,
  p: ClientCredentialsParams,
  opts: { now: () => number; rejectedToken?: string },
  transport: Transport,
): Promise<TokenFetchResult> {
  return oauthToken(connectionId, { ...p, grant: { kind: 'client_credentials' }, clientAuth: 'basic' }, opts, transport);
}

/**
 * Cached token for the connection, fetched when absent, expiring or rotated. `rejectedToken` is the
 * token an upstream just answered 401 to: it is dropped and replaced, unless the cache already holds
 * a different token (another call refreshed it meanwhile), which is then returned as is.
 */
export async function oauthToken(
  connectionId: string,
  p: OAuthTokenParams,
  opts: { now: () => number; rejectedToken?: string },
  transport: Transport,
): Promise<TokenFetchResult> {
  const fingerprint = fingerprintOf(p);
  const cached = tokens.get(connectionId);
  const usable = cached?.fingerprint === fingerprint && (cached.renewAt === undefined || opts.now() < cached.renewAt);
  if (cached && usable && cached.token !== opts.rejectedToken) return { ok: true, accessToken: cached.token };
  if (cached && opts.rejectedToken !== undefined && cached.token === opts.rejectedToken) tokens.delete(connectionId);
  const key = `${connectionId}\u0000${fingerprint}`;
  let pending = inflight.get(key);
  if (!pending) {
    const fetched = fetchOAuthToken(p, transport).then((r) => {
      if (r.ok) {
        const renewAt = r.expiresInS === undefined ? undefined : opts.now() + r.expiresInS * 1000 - TOKEN_REFRESH_MARGIN_MS;
        tokens.set(connectionId, { fingerprint, token: r.accessToken, renewAt });
        if (r.scopes !== undefined) scopesSeen.set(connectionId, r.scopes);
        else scopesSeen.delete(connectionId);
      }
      return r;
    });
    pending = fetched;
    inflight.set(key, fetched);
    const forget = (): void => {
      if (inflight.get(key) === fetched) inflight.delete(key);
    };
    // Both handlers: a rejected fetch must not leave an unhandled rejection behind; the caller sees it.
    fetched.then(forget, forget);
  }
  return pending;
}
