import { describe, expect, it } from 'vitest';
import { CANCELLABLE, canTransition, executionStarted, isExpiryDue, ROLLBACK_FROM, TRANSITIONS } from './lifecycle.js';
import type { ChangeSetStatus } from './model.js';

const ALL: ChangeSetStatus[] = [
  'preparing', 'prepared', 'pending_approval', 'approved', 'executing', 'completed',
  'completed_with_errors', 'failed', 'rejected', 'expired', 'cancelled', 'rolling_back', 'rolled_back',
];

const EXPECTED: readonly (readonly [ChangeSetStatus, ChangeSetStatus])[] = [
  ['preparing', 'prepared'], ['preparing', 'failed'], ['preparing', 'expired'], ['preparing', 'cancelled'],
  ['prepared', 'pending_approval'], ['prepared', 'executing'], ['prepared', 'rejected'],
  ['prepared', 'expired'], ['prepared', 'cancelled'],
  ['pending_approval', 'approved'], ['pending_approval', 'rejected'],
  ['pending_approval', 'expired'], ['pending_approval', 'cancelled'], ['pending_approval', 'prepared'],
  ['approved', 'executing'], ['approved', 'expired'], ['approved', 'cancelled'],
  ['executing', 'completed'], ['executing', 'completed_with_errors'], ['executing', 'failed'],
  ['executing', 'cancelled'],
  ['completed', 'rolling_back'], ['completed_with_errors', 'rolling_back'],
  ['cancelled', 'rolling_back'], ['failed', 'rolling_back'],
  ['rolling_back', 'rolled_back'], ['rolling_back', 'failed'],
];

describe('CS-6 lifecycle', () => {
  it('CS-6 allows exactly the transitions of the table, nothing else', () => {
    const allowed = new Set(EXPECTED.map(([f, t]) => `${f}>${t}`));
    for (const from of ALL) {
      for (const to of ALL) {
        expect(canTransition(from, to), `${from} -> ${to}`).toBe(allowed.has(`${from}>${to}`));
      }
    }
    expect(Object.keys(TRANSITIONS).sort()).toEqual([...ALL].sort());
  });

  it('APR-4 pending_approval may return to prepared', () => {
    expect(canTransition('pending_approval', 'prepared')).toBe(true);
  });

  it('CS-6 terminal states have no way out', () => {
    expect(canTransition('expired', 'executing')).toBe(false);
    expect(canTransition('preparing', 'failed')).toBe(true);
    expect(canTransition('executing', 'cancelled')).toBe(true);
  });

  it('EXE-8 CS-6 cancelled and failed move only to rolling_back; rolled_back is final', () => {
    expect(TRANSITIONS.cancelled).toEqual(['rolling_back']);
    expect(TRANSITIONS.failed).toEqual(['rolling_back']);
    expect(TRANSITIONS.rolled_back).toEqual([]);
    expect(ROLLBACK_FROM).toEqual(['completed', 'completed_with_errors', 'cancelled', 'failed']);
    for (const s of ROLLBACK_FROM) expect(canTransition(s, 'rolling_back'), s).toBe(true);
    expect(executionStarted({})).toBe(false);
    expect(
      executionStarted({
        executionRequest: { actor: 'a', groups: [], correlationId: 'k', startedAt: new Date(0) },
      }),
    ).toBe(true);
  });

  it('CS-6 CANCELLABLE excludes executing', () => {
    expect([...CANCELLABLE].sort()).toEqual(['approved', 'pending_approval', 'prepared', 'preparing']);
  });

  it('CS-6 expiry is due only before execution and at or after expiresAt', () => {
    const expiresAt = new Date('2026-01-01T00:00:00Z');
    expect(isExpiryDue({ status: 'prepared', expiresAt }, expiresAt)).toBe(true);
    expect(isExpiryDue({ status: 'prepared', expiresAt }, new Date(expiresAt.getTime() - 1))).toBe(false);
    expect(isExpiryDue({ status: 'executing', expiresAt }, new Date('2027-01-01T00:00:00Z'))).toBe(false);
  });
});
