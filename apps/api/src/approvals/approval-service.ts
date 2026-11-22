// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Mandate Authors
/**
 * Approval decisions (design part 1 §6): runs the pure checks of `checkDecision`, records the
 * decision in one repository transaction, wakes the workflow on reject and return, and starts an
 * approved change-set with the requester's submitted identity (POL-6). Every refusal is audited
 * (SEC-1, SEC-11); audit rows never carry the comment text (SEC-3).
 */
import { executionLimits, type LoadedConfiguration } from '@mandate/config';
import {
  approvalDecisionEvent,
  approvalRequestedEvent,
  approvalRequestNotifications,
  changesetTransitionEvent,
  checkDecision,
  currentStep,
  ExecutorUnavailable,
  resultNotifications,
  type ApprovalChannel,
  type ApprovalDecision,
  type ApprovalRecord,
  type Approver,
  type AuditEventInput,
  type AuditLog,
  type ChangeSetExecutor,
  type ChangeSetRecord,
  type ChangeSetRepository,
  type ChangeSetStatus,
  type DecisionRefusal,
  type DecisionRequest,
  type StartOutcome,
} from '@mandate/core';

export interface ApprovalServiceDeps {
  repository: ChangeSetRepository;
  executor: ChangeSetExecutor;
  audit: AuditLog;
  newId: () => string;
  now: () => Date;
}

export interface DecideInput {
  changesetId: string;
  decision: DecisionRequest;
  hash: string;
  count: number;
  comment?: string;
  approver: Approver;
  channel: ApprovalChannel;
  correlationId: string;
  snapshot: LoadedConfiguration;
}

export type DecideResult =
  | { ok: true; status: ChangeSetStatus; start?: StartOutcome | 'executor_unavailable' }
  | { ok: false; reason: DecisionRefusal };

export interface StartApprovedInput {
  changesetId: string;
  actor: string;
  clientId?: string;
  correlationId: string;
  snapshot: LoadedConfiguration;
}

export type StartApprovedResult = StartOutcome | { ok: false; reason: 'executor_unavailable' };

const DECIDED: Record<DecisionRequest, ApprovalDecision> = { approve: 'approved', reject: 'rejected', return: 'returned' };

type Next = { kind: 'rejected' | 'returned' | 'approved' } | { kind: 'next_step'; awaitingRole: string };

export class ApprovalService {
  constructor(private readonly deps: ApprovalServiceDeps) {}

  async decide(input: DecideInput): Promise<DecideResult> {
    const { repository } = this.deps;
    const now = this.deps.now();
    const record = await repository.get(input.changesetId);
    if (record === undefined) return this.refuse(input, undefined, [], 'not_found');
    const approvals = await repository.approvals(record.id);
    const refusal = checkDecision({
      changeset: record,
      approvals,
      approver: input.approver,
      channel: input.channel,
      decision: input.decision,
      hash: input.hash,
      count: input.count,
      ...(input.comment === undefined ? {} : { comment: input.comment }),
      now,
    });
    if (refusal === 'expired' && record.status !== 'expired') {
      // Lazy expiry (CS-6). A lost compare-and-set means someone else moved it: the answer stays expired.
      await repository.transition(
        record.id,
        [record.status],
        'expired',
        changesetTransitionEvent({
          id: this.deps.newId(),
          actor: 'system',
          changeset: record,
          from: record.status,
          to: 'expired',
          correlationId: input.correlationId,
        }),
        { expiredBefore: now },
      );
    }
    if (refusal !== undefined) return this.refuse(input, record, approvals, refusal);

    // checkDecision allowed it, so the change-set is pending with a plan and a current step.
    const plan = record.approvalPlan;
    const step = currentStep(record, approvals);
    const role = step === undefined ? undefined : (record.awaitingRole ?? plan?.steps[step - 1]);
    if (plan === undefined || step === undefined || role === undefined) {
      return this.refuse(input, record, approvals, 'not_pending');
    }
    const approver = input.approver;
    const approval: ApprovalRecord = {
      id: this.deps.newId(),
      changesetId: record.id,
      round: record.approvalRound,
      step,
      role,
      approver: approver.subject,
      ...(approver.name === undefined ? {} : { approverName: approver.name }),
      decision: DECIDED[input.decision],
      ...(input.comment === undefined ? {} : { comment: input.comment }),
      hash: input.hash,
      itemCount: input.count,
      channel: input.channel,
      ...(approver.authTime === undefined ? {} : { authTime: approver.authTime }),
      ...(approver.clientId === undefined ? {} : { clientId: approver.clientId }),
      correlationId: input.correlationId,
      ts: now,
    };
    const nextRole = plan.steps[step];
    const next: Next =
      input.decision === 'reject'
        ? { kind: 'rejected' }
        : input.decision === 'return'
          ? { kind: 'returned' }
          : nextRole === undefined
            ? { kind: 'approved' }
            : { kind: 'next_step', awaitingRole: nextRole };

    const clientId = approver.clientId === undefined ? {} : { clientId: approver.clientId };
    const audit: AuditEventInput[] = [
      approvalDecisionEvent({
        id: this.deps.newId(),
        actor: approver.subject,
        ...clientId,
        changeset: record,
        round: record.approvalRound,
        step,
        role,
        channel: input.channel,
        decision: input.decision,
        count: input.count,
        correlationId: input.correlationId,
      }),
    ];
    if (next.kind === 'next_step') {
      audit.push(
        approvalRequestedEvent({
          id: this.deps.newId(),
          actor: approver.subject,
          ...clientId,
          changeset: record,
          round: record.approvalRound,
          step: step + 1,
          role: next.awaitingRole,
          correlationId: input.correlationId,
        }),
      );
    } else {
      audit.push(
        changesetTransitionEvent({
          id: this.deps.newId(),
          actor: approver.subject,
          ...clientId,
          changeset: record,
          from: record.status,
          to: next.kind === 'returned' ? 'prepared' : next.kind,
          correlationId: input.correlationId,
        }),
      );
    }

    const recorded = await repository.recordDecision({
      changesetId: record.id,
      round: record.approvalRound,
      step,
      record: approval,
      next,
      audit,
      notifications: decisionNotifications(input.snapshot, record, step, next),
    });
    // A concurrent decision won the step (APR-3).
    if (!recorded.ok) return this.refuse(input, record, approvals, recorded.reason);
    const status = recorded.changeset.status;

    if (next.kind === 'rejected' || next.kind === 'returned') {
      await this.wake(record.id);
      return { ok: true, status };
    }
    if (next.kind === 'approved') {
      const start = await this.startApproved({
        changesetId: record.id,
        actor: approver.subject,
        ...clientId,
        correlationId: input.correlationId,
        snapshot: input.snapshot,
      });
      // The approval stands whatever the start answers; the answer reports it separately.
      return { ok: true, status, start: !start.ok && start.reason === 'executor_unavailable' ? 'executor_unavailable' : start };
    }
    return { ok: true, status };
  }

  /** Starts an approved change-set with its submission's requester identity and role limits (POL-4, POL-6, SEC-9). */
  async startApproved(input: StartApprovedInput): Promise<StartApprovedResult> {
    const record = await this.deps.repository.get(input.changesetId);
    if (record === undefined) return this.refuseStart(input, undefined, { ok: false, reason: 'not_found' });
    const { submission, hash } = record;
    if (record.status !== 'approved' || submission === undefined || hash === undefined) {
      return this.refuseStart(input, record, { ok: false, reason: 'not_executable' });
    }
    const limits = executionLimits(input.snapshot, submission.role);
    let outcome: StartOutcome;
    try {
      outcome = await this.deps.executor.start({
        changesetId: record.id,
        expectedHash: hash,
        actor: input.actor,
        ...(input.clientId === undefined ? {} : { clientId: input.clientId }),
        correlationId: input.correlationId,
        requester: {
          subject: submission.actor,
          groups: submission.groups,
          ...(submission.clientId === undefined ? {} : { clientId: submission.clientId }),
        },
        ...(limits === undefined ? {} : { limits }),
      });
    } catch (e) {
      if (!(e instanceof ExecutorUnavailable)) throw e;
      return this.refuseStart(input, record, { ok: false, reason: 'executor_unavailable' });
    }
    return outcome.ok ? outcome : this.refuseStart(input, record, outcome);
  }

  /** Best effort, as cancel does: the workflow also re-reads its status at expiry. */
  private async wake(changesetId: string): Promise<void> {
    try {
      await this.deps.executor.wake(changesetId);
    } catch {
      // The decision is committed; a missed wake only delays the workflow's reaction.
    }
  }

  private async refuse(
    input: DecideInput,
    record: ChangeSetRecord | undefined,
    approvals: readonly ApprovalRecord[],
    reason: DecisionRefusal,
  ): Promise<{ ok: false; reason: DecisionRefusal }> {
    const step = record === undefined ? undefined : currentStep(record, approvals);
    const role = record?.awaitingRole;
    const event = approvalDecisionEvent({
      id: this.deps.newId(),
      actor: input.approver.subject,
      ...(input.approver.clientId === undefined ? {} : { clientId: input.approver.clientId }),
      changeset: { id: input.changesetId, operation: record?.operation ?? '' },
      round: record?.approvalRound ?? 0,
      ...(step === undefined ? {} : { step }),
      ...(role === undefined ? {} : { role }),
      channel: input.channel,
      decision: input.decision,
      count: input.count,
      refusal: reason,
      correlationId: input.correlationId,
    });
    await this.deps.audit.append(record === undefined ? withoutOperation(event) : event);
    return { ok: false, reason };
  }

  private async refuseStart<T extends Exclude<StartApprovedResult, { ok: true }>>(
    input: StartApprovedInput,
    record: ChangeSetRecord | undefined,
    refusal: T,
  ): Promise<T> {
    await this.deps.audit.append({
      id: this.deps.newId(),
      actor: input.actor,
      ...(input.clientId === undefined ? {} : { clientId: input.clientId }),
      action: 'changeset.start',
      subject: input.changesetId,
      outcome: 'denied',
      correlationId: input.correlationId,
      changesetId: input.changesetId,
      details: {
        reason: refusal.reason,
        ...('limit' in refusal ? { limit: refusal.limit } : {}),
        ...(record === undefined ? {} : { operation: record.operation }),
      },
    });
    return refusal;
  }
}

/**
 * NTF-1: the next step's role is asked to decide; a rejection or return is told to the requester's
 * role; the final approval queues nothing (execution_finished follows when the run ends).
 */
function decisionNotifications(snapshot: LoadedConfiguration, record: ChangeSetRecord, step: number, next: Next) {
  const round = record.approvalRound;
  switch (next.kind) {
    case 'next_step':
      return approvalRequestNotifications(snapshot.notify, { role: next.awaitingRole, round, step: step + 1 });
    case 'rejected':
    case 'returned':
      return resultNotifications(snapshot.notify, { kind: 'approval_decided', role: record.submission?.role, round, step });
    case 'approved':
      return [];
  }
}

/** An unknown change-set has no operation to name. */
function withoutOperation(event: AuditEventInput): AuditEventInput {
  const { operation: _operation, ...details } = event.details; // eslint-disable-line @typescript-eslint/no-unused-vars -- dropped on purpose
  return { ...event, details };
}
