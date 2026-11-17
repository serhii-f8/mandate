import 'reflect-metadata';
import { HttpException, type ExecutionContext } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { describe, expect, it } from 'vitest';
import type { SessionRow } from '@aiops/db';
import { PageAccess, PageAccessGuard, pageDenial, Public, type PageRequest } from './access.js';
import { hashToken } from './session.service.js';

const ORIGIN = 'https://aiops.example.test';
const NOW = Date.parse('2026-11-16T12:00:00Z');
const COOKIE = 'cookie-value-1';

function session(overrides: Partial<SessionRow> = {}): SessionRow {
  return {
    idHash: hashToken(COOKIE),
    subject: 'carol-id',
    username: 'carol',
    clientId: 'aiops-web',
    groups: ['admins'],
    authTime: new Date(NOW - 60_000),
    csrfToken: 'csrf-token-1',
    expiresAt: new Date(NOW + 3_600_000),
    ...overrides,
  };
}

@Public()
class PublicController {
  open(): string {
    return 'route';
  }
}

@Public()
class MixedController {
  @PageAccess({ csrf: true })
  change(): string {
    return 'route';
  }
}

class PagesController {
  @PageAccess()
  read(): string {
    return 'route';
  }

  @PageAccess({ csrf: true })
  change(): string {
    return 'route';
  }

  @PageAccess({ csrf: true, fresh: true })
  secret(): string {
    return 'route';
  }

  @Public()
  health(): string {
    return 'route';
  }

  unmarked(): string {
    return 'route';
  }
}

interface FakeRequest extends Partial<PageRequest> {
  headers: Record<string, string | undefined>;
}

function contextFor(cls: abstract new () => unknown, method: string, req: FakeRequest): ExecutionContext {
  const handler = (cls.prototype as Record<string, () => void>)[method];
  const headers = new Map<string, string>();
  const res = { setHeader: (k: string, v: string) => headers.set(k, v), getHeader: (k: string) => headers.get(k) };
  return {
    getHandler: () => handler,
    getClass: () => cls,
    switchToHttp: () => ({ getRequest: () => req, getResponse: () => res, getNext: () => undefined }),
  } as unknown as ExecutionContext;
}

function guard(row: SessionRow | null = session()): PageAccessGuard {
  return new PageAccessGuard(
    new Reflector(),
    { find: (cookieValue) => Promise.resolve(row !== null && hashToken(cookieValue) === row.idHash ? row : undefined) },
    (groups) => (groups.includes('admins') ? ['integration_admin'] : []),
    { publicOrigin: ORIGIN, freshAuthSeconds: 300, now: () => NOW },
  );
}

async function outcome(g: PageAccessGuard, cls: abstract new () => unknown, method: string, req: FakeRequest): Promise<unknown> {
  try {
    return await g.canActivate(contextFor(cls, method, req));
  } catch (error) {
    if (error instanceof HttpException) return { status: error.getStatus(), body: error.getResponse() };
    throw error;
  }
}

// ORIGIN is https, so the session cookie carries the `__Host-` prefix.
const withCookie = (extra: Record<string, string> = {}): FakeRequest => ({ headers: { cookie: `other=1; __Host-aiops_session=${COOKIE}`, ...extra } });

describe('AUTH-5 SEC-8 the guard reads the session cookie of the public URL scheme', () => {
  it('AUTH-5 on https only __Host-aiops_session counts; on http only aiops_session', async () => {
    expect(await outcome(guard(), PagesController, 'read', { headers: { cookie: `aiops_session=${COOKIE}` } })).toEqual({ status: 401, body: { error: 'unauthenticated' } });
    expect(await outcome(guard(), PagesController, 'read', withCookie())).toBe(true);
    const plain = new PageAccessGuard(
      new Reflector(),
      { find: (cookieValue) => Promise.resolve(hashToken(cookieValue) === session().idHash ? session() : undefined) },
      () => [],
      { publicOrigin: 'http://localhost:8400', freshAuthSeconds: 300, now: () => NOW },
    );
    expect(await outcome(plain, PagesController, 'read', { headers: { cookie: `aiops_session=${COOKIE}` } })).toBe(true);
    expect(await outcome(plain, PagesController, 'read', { headers: { cookie: `__Host-aiops_session=${COOKIE}` } })).toEqual({ status: 401, body: { error: 'unauthenticated' } });
  });
});

describe('SEC-1 every page route is authorized', () => {
  it('SEC-1 lets @Public routes through without a session, on the class or the handler', async () => {
    expect(await outcome(guard(null), PublicController, 'open', { headers: {} })).toBe(true);
    expect(await outcome(guard(null), PagesController, 'health', { headers: {} })).toBe(true);
  });

  it('SEC-1 a @PageAccess handler in a @Public class still needs a session and CSRF', async () => {
    expect(await outcome(guard(), MixedController, 'change', { headers: {} })).toEqual({ status: 401, body: { error: 'unauthenticated' } });
    expect(await outcome(guard(), MixedController, 'change', withCookie())).toEqual({ status: 403, body: { error: 'csrf' } });
  });

  it('SEC-1 denies a route with neither marker, even with a valid session', async () => {
    expect(await outcome(guard(), PagesController, 'unmarked', withCookie())).toEqual({ status: 403, body: { error: 'forbidden' } });
  });

  it('SEC-1 answers 401 without a cookie, with an unknown cookie, or with an expired session', async () => {
    expect(await outcome(guard(), PagesController, 'read', { headers: {} })).toEqual({ status: 401, body: { error: 'unauthenticated' } });
    expect(await outcome(guard(), PagesController, 'read', { headers: { cookie: 'aiops_session=nope' } })).toEqual({ status: 401, body: { error: 'unauthenticated' } });
    expect(await outcome(guard(null), PagesController, 'read', withCookie())).toEqual({ status: 401, body: { error: 'unauthenticated' } });
  });

  it('AUTH-5 SEC-1 puts the session and the roles mapped from its groups on the request', async () => {
    const req = withCookie();
    expect(await outcome(guard(), PagesController, 'read', req)).toBe(true);
    expect(req.page).toEqual({ session: session(), roles: ['integration_admin'] });
  });
});

describe('SEC-8 CSRF and fresh session on page mutations', () => {
  const good = { origin: ORIGIN, 'x-csrf-token': 'csrf-token-1' };

  it('SEC-8 accepts the session token from the public origin', async () => {
    expect(await outcome(guard(), PagesController, 'change', withCookie(good))).toBe(true);
  });

  it.each<[string, Record<string, string>]>([
    ['no token', { origin: ORIGIN }],
    ['a wrong token', { origin: ORIGIN, 'x-csrf-token': 'csrf-token-2' }],
    ['a token of another length', { origin: ORIGIN, 'x-csrf-token': 'x' }],
    ['no Origin', { 'x-csrf-token': 'csrf-token-1' }],
    ['another Origin', { origin: 'https://evil.example.test', 'x-csrf-token': 'csrf-token-1' }],
    ['an Origin with another port', { origin: 'https://aiops.example.test:8443', 'x-csrf-token': 'csrf-token-1' }],
  ])('SEC-8 refuses a mutation with %s', async (_name, headers) => {
    expect(await outcome(guard(), PagesController, 'change', withCookie(headers))).toEqual({ status: 403, body: { error: 'csrf' } });
  });

  it('SEC-8 a fresh route accepts a recent login and refuses an old one', async () => {
    expect(await outcome(guard(), PagesController, 'secret', withCookie(good))).toBe(true);
    const old = session({ authTime: new Date(NOW - 301_000) });
    expect(await outcome(guard(old), PagesController, 'secret', withCookie(good))).toEqual({ status: 403, body: { error: 'reauthentication_required' } });
    // CSRF is checked before freshness: a forged request never learns the session age.
    expect(await outcome(guard(old), PagesController, 'secret', withCookie({ origin: ORIGIN }))).toEqual({ status: 403, body: { error: 'csrf' } });
  });
});

describe('SEC-8 page checks run in a fixed order', () => {
  const checks = { publicOrigin: ORIGIN, freshAuthSeconds: 300, now: () => NOW };
  const good = { origin: ORIGIN, 'x-csrf-token': 'csrf-token-1' };
  const old = session({ authTime: new Date(NOW - 301_000) });
  const all = { permitted: false, csrf: true, fresh: true };

  it('SEC-8 SEC-1 permission first, then Origin + CSRF, then freshness', () => {
    expect(pageDenial({}, old, all, checks)).toBe('forbidden');
    expect(pageDenial({}, old, { ...all, permitted: true }, checks)).toBe('csrf');
    expect(pageDenial(good, old, { ...all, permitted: true }, checks)).toBe('reauthentication_required');
    expect(pageDenial(good, session(), { ...all, permitted: true }, checks)).toBeUndefined();
  });

  it('SEC-8 checks not required are not run', () => {
    expect(pageDenial({}, old, {}, checks)).toBeUndefined();
    expect(pageDenial({}, old, { fresh: false, csrf: false }, checks)).toBeUndefined();
    expect(pageDenial(good, old, { csrf: true }, checks)).toBeUndefined();
  });
});
