// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Mandate Authors
/**
 * Plans in worker tests (CS-9, EXE-13), shared by the integration tests and the history recorder:
 * prepared change-sets of `alice` put in one plan, then each submitted by an approving editor and
 * approved by `rita` (one `reviewer` step), as the api's tools and pages do.
 */
import { randomUUID } from 'node:crypto';
import { planCreatedEvent, type ChangeSetRecord, type ChangeSetRepository, type PlanRecord, type StartRequest } from '@mandate/core';
import { recordApproval, submitChangeSet } from '@mandate/testing';
import { createPrepared } from './changesets.js';
import { APPROVING_GROUP, REVIEWER_GROUP } from './configuration.js';

/** The identity a plan step's execution request carries: the requester's submission (POL-6). */
export const PLAN_REQUESTER = { subject: 'alice', groups: [APPROVING_GROUP] } as const;

export interface PlanSteps {
  readonly planId: string;
  /** The steps in plan order; each `approved`, or `prepared` where `approve` said false. */
  readonly steps: readonly ChangeSetRecord[];
}

/**
 * A plan over prepared change-sets with `items[i]` items each, in that order; step i is submitted
 * and approved unless `approve[i]` is false.
 */
export async function approvedPlan(
  repository: ChangeSetRepository,
  items: readonly number[],
  approve: readonly boolean[] = [],
): Promise<PlanSteps> {
  const prepared: ChangeSetRecord[] = [];
  for (const n of items) prepared.push(await createPrepared(repository, n));
  const planId = randomUUID();
  const now = new Date();
  const plan: PlanRecord = { id: planId, title: 'Launch', requester: 'alice', createdAt: now };
  const created = await repository.createPlan({
    id: planId,
    title: plan.title,
    requester: plan.requester,
    changesetIds: prepared.map((cs) => cs.id),
    now,
    audit: planCreatedEvent({ id: randomUUID(), plan, steps: prepared.length, correlationId: 'corr-plan' }),
  });
  if (!created.ok) throw new Error(`plan not created: ${created.reason}`);
  const steps: ChangeSetRecord[] = [];
  for (const [i, cs] of prepared.entries()) steps.push(approve[i] === false ? cs : await approved(repository, cs));
  return { planId, steps };
}

/** Submits a prepared change-set as an approving editor and approves its one `reviewer` step. */
export async function approved(repository: ChangeSetRepository, cs: ChangeSetRecord): Promise<ChangeSetRecord> {
  const pending = await submitChangeSet(repository, cs, { steps: ['reviewer'], groups: [APPROVING_GROUP] });
  const decided = await recordApproval(repository, pending, { approver: 'rita' });
  if (decided.status !== 'approved') throw new Error(`not approved: ${decided.status}`);
  return decided;
}

/** The approver's start of an approved step for its requester (POL-6), as `startApproved` sends it. */
export function approverStart(cs: ChangeSetRecord, correlationId = 'corr-exec'): StartRequest {
  if (cs.hash === undefined) throw new Error('change-set has no hash');
  return {
    changesetId: cs.id,
    expectedHash: cs.hash,
    actor: 'rita',
    groups: [REVIEWER_GROUP],
    correlationId,
    requester: { subject: PLAN_REQUESTER.subject, groups: [...PLAN_REQUESTER.groups] },
  };
}
