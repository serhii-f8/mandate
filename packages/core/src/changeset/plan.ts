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

/** A step with what its execution did so far: whether it ever started, and how many items it wrote. */
export interface PlanStepState extends PlanStep {
  readonly executionStarted: boolean;
  /** `stats.written` of the step's change-set. */
  readonly written: number;
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
 * EXE-13: the statuses of a predecessor that can never become `completed` again: the plan stopped there.
 * `rolling_back` ends `rolled_back` or `failed`.
 */
const PLAN_STOPPED: readonly ChangeSetStatus[] = [
  'failed',
  'rejected',
  'cancelled',
  'expired',
  'rolled_back',
  'completed_with_errors',
  'rolling_back',
];

/**
 * EXE-13, UI-4: what a step's place in its plan means for its start, from the statuses alone. `waiting`: the
 * step before it can still complete; `blocked`: it ended otherwise, so this step can never start; `ready`: it
 * completed and this step is `approved` (not yet running); `none`: nothing to say (step 1, a predecessor not in
 * `steps`, or a step that is prepared, running or done).
 */
export type PlanStepGate =
  | { readonly kind: 'none' }
  | { readonly kind: 'ready' }
  | { readonly kind: 'waiting' | 'blocked'; readonly step: number; readonly status: ChangeSetStatus };

export function planStepGate(step: number, steps: readonly PlanStep[]): PlanStepGate {
  if (!Number.isInteger(step) || step <= 1) return { kind: 'none' };
  const before = steps.find((s) => s.step === step - 1);
  if (before === undefined) return { kind: 'none' };
  if (before.status === 'completed') {
    return steps.find((s) => s.step === step)?.status === 'approved' ? { kind: 'ready' } : { kind: 'none' };
  }
  return { kind: PLAN_STOPPED.includes(before.status) ? 'blocked' : 'waiting', step: before.step, status: before.status };
}

/** The one line the views show for a gate (UI-4); the server builds it, the browser only renders it. */
export function planStepGateText(gate: PlanStepGate): string | undefined {
  switch (gate.kind) {
    case 'none':
      return undefined;
    case 'ready':
      return 'Ready to start';
    case 'waiting':
      return `Runs after step ${String(gate.step)} completes (now: ${gate.status})`;
    case 'blocked':
      return `Blocked: step ${String(gate.step)} ${endedText(gate.status)}; this step cannot start`;
  }
}

/** The text of a `plan_blocked` refusal (EXE-13): blocked for good, or not yet. */
export function planBlockedText(changesetId: string, gate: PlanStepGate): string {
  if (gate.kind === 'blocked') {
    return `Change-set ${changesetId} is blocked: step ${String(gate.step)} of its plan ${endedText(gate.status)}, so this step cannot start.`;
  }
  const now = gate.kind === 'waiting' ? ` (now: ${gate.status})` : '';
  return `Change-set ${changesetId} cannot start yet: the step before it in its plan has not completed${now}.`;
}

function endedText(status: ChangeSetStatus): string {
  return status === 'rolling_back' ? 'is rolling_back' : `ended ${status}`;
}

/**
 * EXE-8, EXE-13: true when a step may be rolled back. A later step blocks it only while it is `executing` or
 * `rolling_back`, or when it wrote items and is not `rolled_back`. A later step that started but wrote
 * nothing (a guard refusal, every item failed or skipped, cancelled before its first batch,
 * `executor_unavailable`) never gets a rollback window and could never become `rolled_back`, so it does not.
 */
export function planAllowsRollback(step: number, steps: readonly PlanStepState[]): boolean {
  return steps.every(
    (s) =>
      s.step <= step ||
      (s.status !== 'executing' && s.status !== 'rolling_back' && (s.written === 0 || s.status === 'rolled_back')),
  );
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
