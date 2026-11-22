// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Mandate Authors
import { describe, expect, it } from 'vitest';
import { AUDIT_ACTIONS } from '../audit.js';
import type { ChangeSetStatus } from './model.js';
import {
  PLAN_MAX_STEPS,
  PLAN_MIN_STEPS,
  planAllowsRollback,
  planCreatedEvent,
  planShapeRefusal,
  planStepMayStart,
  type PlanRecord,
  type PlanStep,
  type PlanStepState,
} from './plan.js';

function step(n: number, status: ChangeSetStatus): PlanStep {
  return { step: n, changesetId: `cs-${n}`, operation: 'catalog.update', status };
}

/** A step with its execution state; `written` defaults to 1 for a started step, 0 otherwise. */
function started(n: number, status: ChangeSetStatus, executionStarted: boolean, written = executionStarted ? 1 : 0): PlanStepState {
  return { ...step(n, status), executionStarted, written };
}

const PLAN: PlanRecord = {
  id: '00000000-0000-4000-8000-000000000001',
  title: 'Launch',
  requester: 'alice',
  createdAt: new Date('2026-01-01T00:00:00.000Z'),
};

describe('CS-9 plan rules', () => {
  it('CS-9 a plan has 2 to 20 steps', () => {
    expect(PLAN_MIN_STEPS).toBe(2);
    expect(PLAN_MAX_STEPS).toBe(20);
  });

  it('CS-9 planShapeRefusal refuses too few, too many and duplicate steps', () => {
    expect(planShapeRefusal([])).toBe('too_few_steps');
    expect(planShapeRefusal(['a'])).toBe('too_few_steps');
    expect(planShapeRefusal(Array.from({ length: 21 }, (_, i) => `id-${i}`))).toBe('too_many_steps');
    expect(planShapeRefusal(['a', 'b', 'a'])).toBe('duplicate_step');
    expect(planShapeRefusal(['a', 'b'])).toBeUndefined();
    expect(planShapeRefusal(Array.from({ length: 20 }, (_, i) => `id-${i}`))).toBeUndefined();
  });

  it('EXE-13 step 1 may always start', () => {
    expect(planStepMayStart(1, [step(1, 'approved'), step(2, 'prepared')])).toBe(true);
  });

  it('EXE-13 a later step may start only after the step before it is completed', () => {
    expect(planStepMayStart(2, [step(1, 'completed'), step(2, 'approved')])).toBe(true);
    const blocking: ChangeSetStatus[] = [
      'completed_with_errors',
      'executing',
      'failed',
      'cancelled',
      'rolled_back',
      'approved',
      'prepared',
      'rejected',
      'expired',
      'rolling_back',
    ];
    for (const status of blocking) expect(planStepMayStart(2, [step(1, status), step(2, 'approved')]), status).toBe(false);
    // Only the immediate predecessor counts.
    expect(planStepMayStart(3, [step(1, 'failed'), step(2, 'completed'), step(3, 'approved')])).toBe(true);
    expect(planStepMayStart(3, [step(1, 'completed'), step(2, 'approved'), step(3, 'approved')])).toBe(false);
  });

  it('EXE-13 a missing predecessor fails closed', () => {
    expect(planStepMayStart(2, [step(2, 'approved')])).toBe(false);
    expect(planStepMayStart(0, [step(1, 'completed')])).toBe(false);
  });

  it('EXE-8 planAllowsRollback: a later step that wrote nothing does not block, one running or with writes does', () => {
    // Wrote nothing (guard refusal, every item failed or skipped, cancelled before its first batch,
    // executor_unavailable): it never gets a rollback window, so it must not strand step 1.
    for (const status of ['failed', 'cancelled', 'completed_with_errors', 'completed'] as const) {
      expect(planAllowsRollback(1, [started(1, 'completed', true), started(2, status, true, 0)])).toBe(true);
    }
    expect(planAllowsRollback(1, [started(1, 'completed', true), started(2, 'failed', true, 3)])).toBe(false);
    // Running: its writes are still coming (or being undone), whatever it wrote so far.
    expect(planAllowsRollback(1, [started(1, 'completed', true), started(2, 'executing', true, 0)])).toBe(false);
    expect(planAllowsRollback(1, [started(1, 'completed', true), started(2, 'rolling_back', true, 0)])).toBe(false);
    expect(planAllowsRollback(1, [started(1, 'completed', true), started(2, 'rolled_back', true, 3)])).toBe(true);
  });

  it('EXE-8 planAllowsRollback refuses while a later step that started is not rolled back', () => {
    expect(planAllowsRollback(1, [started(1, 'completed', true), started(2, 'completed', true)])).toBe(false);
    expect(planAllowsRollback(1, [started(1, 'completed', true), started(2, 'executing', true)])).toBe(false);
    expect(planAllowsRollback(1, [started(1, 'completed', true), started(2, 'rolling_back', true)])).toBe(false);
    expect(planAllowsRollback(1, [started(1, 'completed', true), started(2, 'rolled_back', true)])).toBe(true);
    expect(planAllowsRollback(1, [started(1, 'completed', true), started(2, 'approved', false)])).toBe(true);
    // Earlier steps do not count.
    expect(planAllowsRollback(2, [started(1, 'completed', true), started(2, 'completed', true)])).toBe(true);
    expect(
      planAllowsRollback(1, [started(1, 'completed', true), started(2, 'rolled_back', true), started(3, 'failed', true)]),
    ).toBe(false);
  });

  it('AUD-1 planCreatedEvent is a plan.created event without the title (SEC-3)', () => {
    expect(AUDIT_ACTIONS).toContain('plan.created');
    const event = planCreatedEvent({ id: 'ev-1', plan: PLAN, steps: 3, correlationId: 'corr-1', clientId: 'cli' });
    expect(event).toEqual({
      id: 'ev-1',
      actor: 'alice',
      clientId: 'cli',
      action: 'plan.created',
      outcome: 'ok',
      correlationId: 'corr-1',
      details: { planId: PLAN.id, steps: 3 },
    });
    expect(planCreatedEvent({ id: 'ev-2', plan: PLAN, steps: 2, correlationId: 'c' })).not.toHaveProperty('clientId');
  });
});
