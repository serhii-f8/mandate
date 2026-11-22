// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Mandate Authors
import { canView, type ChangeSetRecord, type ChangeSetRepository, type ChangeSetStatus } from '@mandate/core';

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
  return { id: stored.plan.id, title: stored.plan.title, step: record.plan.step, of: stored.steps.length, steps };
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
