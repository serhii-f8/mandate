// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Mandate Authors
import { createHash } from 'node:crypto';
import type { LoginRow, PostgresSessionStore, SessionRow } from '@mandate/db';
import { randomToken, type OidcIdentity } from './oidc-client.js';

export const SESSION_COOKIE = 'mandate_session';
/**
 * The session cookie's name on https: the `__Host-` prefix makes the browser refuse it
 * unless it is Secure, has Path=/ and no Domain, so a sibling host cannot plant or shadow it.
 */
export const HOST_SESSION_COOKIE = `__Host-${SESSION_COOKIE}`;

export const sessionCookieName = (secure: boolean): string => (secure ? HOST_SESSION_COOKIE : SESSION_COOKIE);

/** The session cookie's value from a `Cookie` header, by the name of the scheme; empty is none. */
export function sessionCookieValue(header: string | undefined, secure: boolean): string | undefined {
  const value = parseCookies(header).get(sessionCookieName(secure));
  return value === '' ? undefined : value;
}
/** Binds a login's state to the browser that started it (login CSRF, SEC-8). */
export const LOGIN_COOKIE = 'mandate_login';
/** Login state lives 10 minutes (design §4). */
const LOGIN_TTL_SECONDS = 600;
const LOGIN_TTL_MS = LOGIN_TTL_SECONDS * 1000;
/** Expired rows are removed at most this often per process. */
const PURGE_INTERVAL_MS = 60_000;

/** SHA-256 hex: how state and cookie values are keyed in PostgreSQL; the raw values are never stored. */
export const hashToken = (value: string): string => createHash('sha256').update(value).digest('hex');

/** The `Cookie` header as name → value (first occurrence wins, values kept as sent). */
export function parseCookies(header: string | undefined): Map<string, string> {
  const cookies = new Map<string, string>();
  for (const part of (header ?? '').split(';')) {
    const i = part.indexOf('=');
    if (i <= 0) continue;
    const name = part.slice(0, i).trim();
    if (name !== '' && !cookies.has(name)) cookies.set(name, part.slice(i + 1).trim());
  }
  return cookies;
}

/**
 * `Set-Cookie` for the session: HttpOnly, SameSite=Strict, Path=/, no Domain; on https
 * Secure and named `__Host-mandate_session` (design §4).
 */
export function sessionCookie(value: string, maxAgeSeconds: number, secure: boolean): string {
  return `${sessionCookieName(secure)}=${value}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${String(maxAgeSeconds)}${secure ? '; Secure' : ''}`;
}

export function clearedSessionCookie(secure: boolean): string {
  return sessionCookie('', 0, secure);
}

/**
 * `Set-Cookie` holding the login state: `SameSite=Lax` so it comes back on the top-level
 * redirect from the identity provider, scoped to the callback path, as long as the login row.
 */
export function loginCookie(state: string, secure: boolean, maxAgeSeconds = LOGIN_TTL_SECONDS): string {
  return `${LOGIN_COOKIE}=${state}; HttpOnly; SameSite=Lax; Path=/auth/callback; Max-Age=${String(maxAgeSeconds)}${secure ? '; Secure' : ''}`;
}

export function clearedLoginCookie(secure: boolean): string {
  return loginCookie('', secure, 0);
}

/** How the access guard finds the session of a cookie value. */
export interface SessionLookup {
  find(cookieValue: string): Promise<SessionRow | undefined>;
}

export type SessionStore = Pick<PostgresSessionStore, 'createLogin' | 'consumeLogin' | 'createSession' | 'findSession' | 'deleteSession' | 'purgeExpired'>;

export interface PendingLogin {
  readonly state: string;
  readonly codeVerifier: string;
  readonly nonce: string;
  readonly returnTo: string;
  readonly fresh: boolean;
}

/** Login state and page sessions over the shared store, so any instance serves any page request (NFR-3). */
export class SessionService implements SessionLookup {
  constructor(
    private readonly store: SessionStore,
    private readonly options: { readonly maxAgeSeconds: number; readonly now?: () => number },
  ) {}

  private lastPurge: number | undefined;

  private now(): number {
    return this.options.now?.() ?? Date.now();
  }

  /** Removes expired logins and sessions, at most once a minute per process. */
  async purgeIfDue(): Promise<void> {
    const now = this.now();
    if (this.lastPurge !== undefined && now - this.lastPurge < PURGE_INTERVAL_MS) return;
    this.lastPurge = now;
    await this.store.purgeExpired(new Date(now));
  }

  async beginLogin(login: PendingLogin): Promise<void> {
    await this.store.createLogin({
      stateHash: hashToken(login.state),
      codeVerifier: login.codeVerifier,
      nonce: login.nonce,
      returnTo: login.returnTo,
      fresh: login.fresh,
      expiresAt: new Date(this.now() + LOGIN_TTL_MS),
    });
  }

  /** Single use: a replayed or expired state finds nothing (AUTH-5). */
  consumeLogin(state: string): Promise<LoginRow | undefined> {
    return this.store.consumeLogin(hashToken(state), new Date(this.now()));
  }

  async create(identity: OidcIdentity): Promise<{ readonly cookieValue: string; readonly session: SessionRow }> {
    const cookieValue = randomToken();
    const session: SessionRow = {
      idHash: hashToken(cookieValue),
      subject: identity.subject,
      clientId: identity.clientId,
      groups: identity.groups,
      authTime: identity.authTime,
      csrfToken: randomToken(),
      expiresAt: new Date(this.now() + this.options.maxAgeSeconds * 1000),
      ...(identity.username === undefined ? {} : { username: identity.username }),
    };
    await this.store.createSession(session);
    return { cookieValue, session };
  }

  find(cookieValue: string): Promise<SessionRow | undefined> {
    return this.store.findSession(hashToken(cookieValue), new Date(this.now()));
  }

  end(session: SessionRow): Promise<void> {
    return this.store.deleteSession(session.idHash);
  }

  /** Deletes the session a cookie value names, if any (a re-login replaces it). */
  endCookie(cookieValue: string): Promise<void> {
    return this.store.deleteSession(hashToken(cookieValue));
  }
}
