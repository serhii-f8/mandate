import { randomUUID } from 'node:crypto';
import {
  approvalDecisionEvent,
  approvalRequestedEvent,
  changesetTransitionEvent,
  type ApprovalDecision,
  type ApprovalPlan,
  type ApprovalRecord,
  type ChangeSetRecord,
  type ChangeSetRepository,
  type DecisionRequest,
  type NewNotification,
} from '@aiops/core';

const REQUEST_OF: Record<ApprovalDecision, DecisionRequest> = { approved: 'approve', rejected: 'reject', returned: 'return' };

/** Submits a prepared change-set for approval (APR-1); steps default to `['lead']`. Throws on refusal. */
export async function submitChangeSet(
  repository: ChangeSetRepository,
  cs: ChangeSetRecord,
  opts: {
    steps?: readonly string[];
    groups?: readonly string[];
    at?: Date;
    widget?: boolean;
    stepUp?: number;
    notifications?: readonly NewNotification[];
  } = {},
): Promise<ChangeSetRecord> {
  const steps = opts.steps ?? ['lead'];
  const first = steps[0];
  if (first === undefined || cs.hash === undefined) throw new Error('submitChangeSet needs a prepared change-set and steps');
  const at = opts.at ?? new Date();
  const plan: ApprovalPlan = {
    reason: 'default',
    steps,
    ...(opts.stepUp === undefined ? {} : { stepUp: { maxAgeSeconds: opts.stepUp } }),
    widget: opts.widget ?? false,
    included: cs.stats.included,
  };
  const correlationId = randomUUID();
  const result = await repository.submitForApproval({
    changesetId: cs.id,
    expectedHash: cs.hash,
    submission: { actor: cs.requester, groups: opts.groups ?? [], correlationId, at, role: 'writer', rule: 'role:writer/approval' },
    plan,
    audit: {
      transition: changesetTransitionEvent({
        id: randomUUID(),
        actor: cs.requester,
        changeset: cs,
        from: 'prepared',
        to: 'pending_approval',
        correlationId,
      }),
      requested: approvalRequestedEvent({
        id: randomUUID(),
        actor: cs.requester,
        changeset: cs,
        round: cs.approvalRound + 1,
        step: 1,
        role: first,
        correlationId,
      }),
    },
    notifications: opts.notifications ?? [],
  });
  if (!result.ok) throw new Error(`submitForApproval refused: ${result.reason}`);
  return result.changeset;
}

/** Decides the current step of a pending change-set; computes `next`. Throws on refusal. */
export async function recordApproval(
  repository: ChangeSetRepository,
  cs: ChangeSetRecord,
  opts: {
    approver: string;
    decision?: ApprovalDecision;
    hash?: string;
    comment?: string;
    notifications?: readonly NewNotification[];
  },
): Promise<ChangeSetRecord> {
  const plan = cs.approvalPlan;
  if (plan === undefined || cs.hash === undefined) throw new Error('recordApproval needs a pending change-set');
  const round = cs.approvalRound;
  const decided = (await repository.approvals(cs.id, round)).filter((a) => a.decision === 'approved').length;
  const step = decided + 1;
  const role = plan.steps[step - 1];
  if (role === undefined) throw new Error('no step left to decide');
  const decision = opts.decision ?? 'approved';
  const nextRole = plan.steps[step];
  const next =
    decision !== 'approved'
      ? { kind: decision === 'rejected' ? ('rejected' as const) : ('returned' as const) }
      : nextRole === undefined
        ? { kind: 'approved' as const }
        : { kind: 'next_step' as const, awaitingRole: nextRole };
  const correlationId = randomUUID();
  const record: ApprovalRecord = {
    id: randomUUID(),
    changesetId: cs.id,
    round,
    step,
    role,
    approver: opts.approver,
    decision,
    ...(opts.comment === undefined ? {} : { comment: opts.comment }),
    hash: opts.hash ?? cs.hash,
    itemCount: cs.stats.included,
    channel: 'page',
    correlationId,
    ts: new Date(),
  };
  const audit = [
    approvalDecisionEvent({
      id: randomUUID(),
      actor: opts.approver,
      changeset: cs,
      round,
      step,
      role,
      channel: 'page',
      decision: REQUEST_OF[decision],
      count: cs.stats.included,
      correlationId,
    }),
    next.kind === 'next_step'
      ? approvalRequestedEvent({
          id: randomUUID(),
          actor: opts.approver,
          changeset: cs,
          round,
          step: step + 1,
          role: next.awaitingRole,
          correlationId,
        })
      : changesetTransitionEvent({
          id: randomUUID(),
          actor: opts.approver,
          changeset: cs,
          from: 'pending_approval',
          to: next.kind === 'returned' ? 'prepared' : next.kind,
          correlationId,
        }),
  ];
  const result = await repository.recordDecision({ changesetId: cs.id, round, step, record, next, audit, notifications: opts.notifications ?? [] });
  if (!result.ok) throw new Error(`recordDecision refused: ${result.reason}`);
  return result.changeset;
}
