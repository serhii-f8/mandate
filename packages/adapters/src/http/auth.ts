// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Mandate Authors
import { parseSecret, type ConnectionSettings, type CredentialSource, type ReadErrorCode } from '@mandate/connector-sdk';
import type { Transport } from './client.js';
import { clientSecretBasicValue, formEncode, HEADER_SAFE, oauthToken, type OAuthTokenParams } from './oauth.js';
import { createScrubber, type Scrubber } from './scrub.js';

/** A credential failure; the message is already scrubbed and names no secret (SEC-3). */
export interface AuthFailure {
  ok: false;
  code: ReadErrorCode;
  status?: number;
  message: string;
}

/** The credential of one connection, opened and ready to inject into one client operation (CONN-3). */
export interface PreparedAuth {
  /** The header to set last, if the connection has auth. */
  header(): readonly [name: string, value: string] | undefined;
  /** Scrubs every secret known so far, including a token fetched by `refreshAfter401` (SEC-3). */
  readonly scrubber: Scrubber;
  /** OAuth only: refresh once after a 401 with the rejected token; undefined when nothing to refresh. */
  refreshAfter401(): Promise<{ ok: true } | AuthFailure | undefined>;
}

export interface PrepareAuthDeps {
  now: () => number;
  transport: Transport;
}

function failure(code: ReadErrorCode, message: string, scrubber: Scrubber, status?: number): AuthFailure {
  return { ok: false, code, ...(status === undefined ? {} : { status }), message: scrubber.text(message) };
}

/**
 * Opens the connection's credential and prepares its header per scheme (CONN-3); for OAuth it
 * fetches (or reuses) the access token. Every secret, its encoded forms and every fetched token are
 * added to the scrubber, and every failure message is scrubbed (SEC-3).
 */
export async function prepareAuth(
  settings: ConnectionSettings,
  credential: CredentialSource | undefined,
  deps: PrepareAuthDeps,
): Promise<{ ok: true; auth: PreparedAuth } | AuthFailure> {
  const auth = settings.auth;
  const empty = createScrubber([]);
  if (!auth) {
    return { ok: true, auth: { header: () => undefined, scrubber: empty, refreshAfter401: () => Promise.resolve(undefined) } };
  }
  if (!credential) return failure('credential_missing', `connection ${settings.id} has no credential`, empty);
  if (credential.scheme !== auth.scheme) return failure('credential_unusable', `credential scheme does not match connection ${settings.id}`, empty);
  let opened: Readonly<Record<string, string>>;
  try {
    opened = await credential.open();
  } catch {
    return failure('credential_unusable', `credential ${credential.ref} could not be opened`, empty);
  }
  const parsed = parseSecret(auth.scheme, opened);
  if (!parsed.ok) {
    // Scrub whatever we were handed even though the material is unusable.
    const handed = createScrubber(Object.values(opened).filter((v): v is string => typeof v === 'string'));
    return failure('credential_unusable', parsed.message, handed);
  }
  const s = parsed.secret;
  const secrets: string[] = [];
  // A user name (Basic, password grant) is an identifier, not a secret: scrubbing it would redact
  // ordinary response data ("admin"). The password and the encoded pair are scrubbed.
  const isUserName = (k: string): boolean => (auth.scheme === 'basic' || auth.scheme === 'oauth_password') && k === 'username';
  secrets.push(...Object.entries(s).filter(([k]) => !isUserName(k)).map(([, v]) => v));
  const unsendable = (): AuthFailure => failure('credential_unusable', `credential ${credential.ref} contains characters not allowed in a header`, empty);
  let authHeader: readonly [string, string] | undefined;
  let oauth: OAuthTokenParams | undefined;
  switch (auth.scheme) {
    case 'bearer':
      if (!HEADER_SAFE.test(s.token ?? '')) return unsendable();
      authHeader = ['authorization', `Bearer ${s.token ?? ''}`];
      break;
    case 'api_key':
      if (!HEADER_SAFE.test(s.key ?? '')) return unsendable();
      authHeader = [auth.header.toLowerCase(), s.key ?? ''];
      break;
    case 'basic': {
      const value = Buffer.from(`${s.username ?? ''}:${s.password ?? ''}`).toString('base64');
      // Base64 is always visible ASCII; checked anyway so the rule is the same for every scheme.
      if (!HEADER_SAFE.test(value)) return unsendable();
      secrets.push(value);
      authHeader = ['authorization', `Basic ${value}`];
      break;
    }
    case 'oauth_client_credentials': {
      const clientId = s.client_id ?? '';
      const clientSecret = s.client_secret ?? '';
      secrets.push(Buffer.from(`${clientId}:${clientSecret}`).toString('base64'));
      // The exact value sent to the token endpoint (form-encoded id and secret, RFC 6749 §2.3.1).
      secrets.push(clientSecretBasicValue(clientId, clientSecret));
      oauth = { tokenUrl: auth.tokenUrl, clientId, clientSecret, scopes: auth.scopes, timeoutMs: settings.timeoutMs, grant: { kind: 'client_credentials' }, clientAuth: 'basic' };
      break;
    }
    case 'oauth_password': {
      const clientId = s.client_id ?? '';
      const clientSecret = s.client_secret ?? '';
      const password = s.password ?? '';
      secrets.push(Buffer.from(`${clientId}:${clientSecret}`).toString('base64'));
      // The exact value sent to the token endpoint (form-encoded id and secret, RFC 6749 §2.3.1).
      secrets.push(clientSecretBasicValue(clientId, clientSecret));
      // The form-encoded forms are what an endpoint echoing the request body would return.
      secrets.push(formEncode(password), formEncode(clientSecret));
      oauth = {
        tokenUrl: auth.tokenUrl,
        clientId,
        clientSecret,
        scopes: auth.scopes,
        timeoutMs: settings.timeoutMs,
        grant: { kind: 'password', username: s.username ?? '', password },
        clientAuth: auth.clientAuth,
      };
      break;
    }
  }
  let scrubber = createScrubber(secrets);

  const params = oauth;
  let currentToken: string | undefined;
  let refreshed = false;
  const useToken = async (rejectedToken?: string): Promise<AuthFailure | undefined> => {
    if (!params) return undefined;
    const opts = rejectedToken === undefined ? { now: deps.now } : { now: deps.now, rejectedToken };
    const t = await oauthToken(settings.id, params, opts, deps.transport);
    if (!t.ok) return failure(t.code, t.message, scrubber, t.status);
    secrets.push(t.accessToken);
    scrubber = createScrubber(secrets);
    currentToken = t.accessToken;
    authHeader = ['authorization', `Bearer ${t.accessToken}`];
    return undefined;
  };
  const tokenFailure = await useToken();
  if (tokenFailure) return tokenFailure;

  const prepared: PreparedAuth = {
    header: () => authHeader,
    get scrubber() {
      return scrubber;
    },
    refreshAfter401: async () => {
      if (!params || refreshed) return undefined;
      // The cached token may have been revoked or expired early: refresh once (spec §4.5).
      // Passing the rejected token lets a concurrent call that already refreshed win (no second fetch).
      refreshed = true;
      return (await useToken(currentToken)) ?? { ok: true };
    },
  };
  return { ok: true, auth: prepared };
}
