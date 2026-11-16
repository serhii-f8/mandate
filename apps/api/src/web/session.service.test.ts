import { describe, expect, it } from 'vitest';
import { SessionService, type SessionStore } from './session.service.js';

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
