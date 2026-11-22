// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Mandate Authors
import type { AuditEventInput } from '../audit.js';
import type { ChangeSetStatus } from './model.js';

/** CS-9 (ADR 0074): the fewest and the most change-sets one plan orders. */
export const PLAN_MIN_STEPS = 2;
export const PLAN_MAX_STEPS = 20;

/** CS-9: a plan. Its order lives on the change-sets (`plan_id`, `plan_step`), outside every hash. */
export interface PlanRecord {
  readonly id: string;
  readonly title: string;
  readonly requester: string;
  readonly createdAt: Date;
}

/** One step of a plan: its 1-based position and the change-set that holds it. */
export interface PlanStep {
  readonly step: number;
  readonly changesetId: string;
  readonly operation: string;
  readonly status: ChangeSetStatus;
}

/** CS-9: the fixed refusal codes of plan creation. */
export type CreatePlanRefusal =
  | 'not_found'
  | 'not_requester'
  | 'not_prepared'
  | 'already_in_plan'
  | 'duplicate_step'
  | 'too_few_steps'
  | 'too_many_steps';

/** Refusals that need no storage: count and duplicates. */
export function planShapeRefusal(
  changesetIds: readonly string[],
): 'duplicate_step' | 'too_few_steps' | 'too_many_steps' | undefined {
  if (changesetIds.length < PLAN_MIN_STEPS) return 'too_few_steps';
  if (changesetIds.length > PLAN_MAX_STEPS) return 'too_many_steps';
  if (new Set(changesetIds).size !== changesetIds.length) return 'duplicate_step';
  return undefined;
}

/**
 * EXE-13: true when a step may start: step 1, or the step before it is `completed` (all written, none
 * failed, verification confirmed). Any other status of the predecessor, or no predecessor in `steps`,
 * blocks the step (fail closed).
 */
export function planStepMayStart(step: number, steps: readonly PlanStep[]): boolean {
  if (step === 1) return true;
  if (!Number.isInteger(step) || step < 1) return false;
  return steps.some((s) => s.step === step - 1 && s.status === 'completed');
}

/**
 * EXE-8, EXE-13: true when a step may be rolled back: no later step has an execution request, or each that
 * has is `rolled_back`.
 */
export function planAllowsRollback(step: number, steps: readonly (PlanStep & { executionStarted: boolean })[]): boolean {
  return steps.every((s) => s.step <= step || !s.executionStarted || s.status === 'rolled_back');
}

/**
 * AUD-1: the audit event of a created plan, by its requester. The title is caller text and stays out of the
 * audit (SEC-3); the plan ID and the number of steps identify it.
 */
export function planCreatedEvent(input: {
  id: string;
  plan: PlanRecord;
  steps: number;
  correlationId: string;
  clientId?: string;
}): AuditEventInput {
  return {
    id: input.id,
    actor: input.plan.requester,
    ...(input.clientId === undefined ? {} : { clientId: input.clientId }),
    action: 'plan.created',
    outcome: 'ok',
    correlationId: input.correlationId,
    details: { planId: input.plan.id, steps: input.steps },
  };
}
