// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The AI Operations Layer Authors
import { describe, expect, it } from 'vitest';
import { clearedSessionCookie, hashToken, sessionCookie, sessionCookieValue, SessionService, type SessionStore } from './session.service.js';

function serviceWith(clock: { now: number }) {
  const purges: Date[] = [];
  const purgeExpired = (now: Date): Promise<number> => {
    purges.push(now);
    return Promise.resolve(0);
  };
  const store = { purgeExpired } as unknown as SessionStore;
  return { purges, service: new SessionService(store, { maxAgeSeconds: 60, now: () => clock.now }) };
}

describe('AUTH-5 expired logins and sessions are purged opportunistically', () => {
  it('AUTH-5 purges at most once a minute per process', async () => {
    const clock = { now: Date.parse('2026-11-16T12:00:00Z') };
    const { purges, service } = serviceWith(clock);
    await service.purgeIfDue();
    clock.now += 59_000;
    await service.purgeIfDue();
    expect(purges).toHaveLength(1);
    clock.now += 1_000;
    await service.purgeIfDue();
    expect(purges.map((d) => d.toISOString())).toEqual(['2026-11-16T12:00:00.000Z', '2026-11-16T12:01:00.000Z']);
  });
});

describe('AUTH-5 SEC-8 the session cookie name follows the public URL scheme', () => {
  it('AUTH-5 https names it __Host-aiops_session (Secure, Path=/, no Domain); http keeps aiops_session', () => {
    const secure = sessionCookie('v', 60, true);
    expect(secure).toMatch(/^__Host-aiops_session=v; /);
    expect(secure).toContain('; Secure');
    expect(secure).toContain('; Path=/;');
    expect(secure.toLowerCase()).not.toContain('domain=');
    expect(clearedSessionCookie(true)).toMatch(/^__Host-aiops_session=; .*Max-Age=0/);
    expect(sessionCookie('v', 60, false)).toMatch(/^aiops_session=v; /);
    expect(sessionCookie('v', 60, false)).not.toContain('Secure');
  });

  it('AUTH-5 reads only the cookie of its own name', () => {
    expect(sessionCookieValue('aiops_session=plain; __Host-aiops_session=hosted', true)).toBe('hosted');
    expect(sessionCookieValue('aiops_session=plain', true)).toBeUndefined();
    expect(sessionCookieValue('__Host-aiops_session=hosted; aiops_session=plain', false)).toBe('plain');
    expect(sessionCookieValue('aiops_session=', false)).toBeUndefined();
  });
});

describe('AUTH-5 a re-login replaces the browser session', () => {
  it('AUTH-5 endCookie deletes the session row of a cookie value by its hash', async () => {
    const deleted: string[] = [];
    const store = { deleteSession: (idHash: string) => Promise.resolve(void deleted.push(idHash)) } as unknown as SessionStore;
    await new SessionService(store, { maxAgeSeconds: 60 }).endCookie('old-cookie');
    expect(deleted).toEqual([hashToken('old-cookie')]);
  });
});
