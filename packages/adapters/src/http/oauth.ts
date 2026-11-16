import { createHash } from 'node:crypto';
import type { ReadErrorCode } from '@aiops/connector-sdk';
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

/** application/x-www-form-urlencoded encoding of one value (RFC 6749 appendix B). */
export function formEncode(value: string): string {
  return new URLSearchParams([['v', value]]).toString().slice(2);
}

/**
 * Client credentials grant (RFC 6749 §4.4) with client_secret_basic (§2.3.1). The returned token is
 * secret material: callers add it to their scrubber and never log it.
 */
export async function fetchClientCredentialsToken(p: ClientCredentialsParams, transport: Transport): Promise<TokenFetchResult> {
  let url: URL;
  try {
    url = new URL(p.tokenUrl);
  } catch {
    return { ok: false, code: 'credential_unusable', message: 'token URL is not a valid URL' };
  }
  const form = new URLSearchParams({ grant_type: 'client_credentials' });
  if (p.scopes.length > 0) form.set('scope', p.scopes.join(' '));
  const basic = Buffer.from(`${formEncode(p.clientId)}:${formEncode(p.clientSecret)}`).toString('base64');
  const r = await transport(
    {
      method: 'POST',
      url,
      headers: { accept: 'application/json', 'content-type': 'application/x-www-form-urlencoded', authorization: `Basic ${basic}` },
      body: form.toString(),
    },
    p.timeoutMs,
  );
  if (r.kind === 'error') return { ok: false, code: r.code, message: `token request failed: ${r.message}` };
  if (r.kind === 'status') return { ok: false, code: 'credential_unusable', status: r.status, message: `token endpoint returned status ${r.status}` };
  const parsed = TokenResponse.safeParse(r.json);
  if (!parsed.success) return { ok: false, code: 'invalid_response', message: 'token response has no usable access_token' };
  const out: TokenFetchResult = { ok: true, accessToken: parsed.data.access_token };
  if (parsed.data.expires_in !== undefined) out.expiresInS = parsed.data.expires_in;
  if (parsed.data.scope !== undefined) out.scopes = parsed.data.scope.split(' ').filter((s) => s !== '');
  return out;
}

interface CachedToken {
  /** Hash of token URL, client and scopes: a rotated credential never reuses an old token. */
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

function fingerprintOf(p: ClientCredentialsParams): string {
  return createHash('sha256').update(JSON.stringify([p.tokenUrl, p.clientId, p.clientSecret, p.scopes])).digest('hex');
}

/** Cached token for the connection, fetched when absent, expiring, rotated or `forceRefresh`. */
export async function clientCredentialsToken(
  connectionId: string,
  p: ClientCredentialsParams,
  opts: { now: () => number; forceRefresh: boolean },
  transport: Transport,
): Promise<TokenFetchResult> {
  const fingerprint = fingerprintOf(p);
  const cached = tokens.get(connectionId);
  if (!opts.forceRefresh && cached?.fingerprint === fingerprint && (cached.renewAt === undefined || opts.now() < cached.renewAt)) {
    return { ok: true, accessToken: cached.token };
  }
  if (opts.forceRefresh && cached?.fingerprint === fingerprint) tokens.delete(connectionId);
  const key = `${connectionId}\u0000${fingerprint}`;
  let pending = inflight.get(key);
  if (!pending) {
    pending = fetchClientCredentialsToken(p, transport).then((r) => {
      if (r.ok) {
        const renewAt = r.expiresInS === undefined ? undefined : opts.now() + r.expiresInS * 1000 - TOKEN_REFRESH_MARGIN_MS;
        tokens.set(connectionId, { fingerprint, token: r.accessToken, renewAt });
        if (r.scopes !== undefined) scopesSeen.set(connectionId, r.scopes);
        else scopesSeen.delete(connectionId);
      }
      return r;
    });
    inflight.set(key, pending);
    void pending.finally(() => {
      inflight.delete(key);
    });
  }
  return pending;
}
