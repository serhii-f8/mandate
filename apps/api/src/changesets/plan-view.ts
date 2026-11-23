// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Mandate Authors
import {
  canView,
  planStepGate,
  planStepGateText,
  type ChangeSetRecord,
  type ChangeSetRepository,
  type ChangeSetStatus,
  type PlanStepGate,
} from '@mandate/core';

/**
 * CS-9, MCP-10, UI-4: the plan a change-set is a step of: its title, the step, how many there are, and per
 * step only its position, ID, operation and status (ADR 0074). `visible` is present only on the page
 * answers: whether the viewer passes the page visibility check for that step's change-set.
 */
export interface PlanBlock {
  id: string;
  title: string;
  step: number;
  of: number;
  steps: { step: number; id: string; operation: string; status: ChangeSetStatus; visible?: boolean }[];
  /**
   * EXE-13, UI-4: what this step waits for (`Runs after step N completes`, `Blocked: ...`, `Ready to start`),
   * decided here from the statuses so the browser decides nothing; absent when there is nothing to say.
   */
  startLine?: string;
}

/** The plan block of `record`, or undefined for a change-set outside a plan. `canOpen` adds `visible` to each step. */
export async function planBlock(
  repository: ChangeSetRepository,
  record: ChangeSetRecord,
  canOpen?: (changesetId: string) => Promise<boolean>,
): Promise<PlanBlock | undefined> {
  if (record.plan === undefined) return undefined;
  const stored = await repository.planSteps(record.plan.id);
  if (stored === undefined) return undefined;
  const steps = await Promise.all(
    stored.steps.map(async (s) => ({
      step: s.step,
      id: s.changesetId,
      operation: s.operation,
      status: s.status,
      ...(canOpen === undefined ? {} : { visible: s.changesetId === record.id || (await canOpen(s.changesetId)) }),
    })),
  );
  const startLine = planStepGateText(planStepGate(record.plan.step, stored.steps));
  return {
    id: stored.plan.id,
    title: stored.plan.title,
    step: record.plan.step,
    of: stored.steps.length,
    steps,
    ...(startLine === undefined ? {} : { startLine }),
  };
}

/** The plan block for a viewer of the trusted pages or the review widget: a step is `visible` when the viewer may open it (SEC-1). */
export function planBlockFor(
  repository: ChangeSetRepository,
  record: ChangeSetRecord,
  viewer: { subject: string; roles: readonly string[] },
): Promise<PlanBlock | undefined> {
  return planBlock(repository, record, async (id) => {
    const sibling = await repository.get(id);
    return sibling !== undefined && canView(sibling, await repository.approvals(id), viewer);
  });
}

/** EXE-13: what a plan step waits for, read now; `none` outside a plan, so a refusal text can say whether it is blocked for good. */
export async function planGateOf(repository: ChangeSetRepository, id: string): Promise<PlanStepGate> {
  const record = await repository.get(id);
  if (record?.plan === undefined) return { kind: 'none' };
  const stored = await repository.planSteps(record.plan.id);
  return stored === undefined ? { kind: 'none' } : planStepGate(record.plan.step, stored.steps);
}
