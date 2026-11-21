// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The AI Operations Layer Authors
import type { AuditEventInput } from '../audit.js';
import type { Caller } from '../caller.js';
import { policyDecisionAuditEvent } from '../policy-audit.js';
import { changesetTransitionEvent } from './audit.js';
import type { ChangeItemRecord, ChangeSetRecord, ChangeSetStats } from './model.js';
import type { ExecutionLimits, ExecutionUsage, FinishOutcome, ItemOutcome, LimitName, StartEvent } from './ports.js';

export interface BatchCounts {
  readonly written: number;
  readonly failed: number;
  readonly skipped: number;
}

/** Outcomes for exactly the batch: first outcome per target wins, strangers are ignored, gaps fail (EXE-3). */
export function coverBatch(
  items: readonly Pick<ChangeItemRecord, 'targetId'>[],
  outcomes: readonly ItemOutcome[],
): ItemOutcome[] {
  const byTarget = new Map<string, ItemOutcome>();
  for (const o of outcomes) if (!byTarget.has(o.targetId)) byTarget.set(o.targetId, o);
  return items.map((i) => byTarget.get(i.targetId) ?? { targetId: i.targetId, status: 'failed', error: 'no_outcome' });
}

/** First limit the start would exceed, in the order operation, day, concurrent (POL-4). */
export function evaluateLimits(limits: ExecutionLimits, records: number, usage: ExecutionUsage): LimitName | undefined {
  if (limits.recordsPerOperation !== undefined && records > limits.recordsPerOperation) return 'records_per_operation';
  if (limits.recordsPerDay !== undefined && usage.recordsSince + records > limits.recordsPerDay) {
    return 'records_per_day';
  }
  if (limits.concurrentExecutions !== undefined && usage.executing >= limits.concurrentExecutions) {
    return 'concurrent_executions';
  }
  return undefined;
}

/** True when the failed share of processed items is above the threshold (EXE-5). */
export function failureThresholdExceeded(
  stats: Pick<ChangeSetStats, 'written' | 'failed' | 'skipped'>,
  threshold: number,
): boolean {
  const processed = stats.written + stats.failed + stats.skipped;
  return processed > 0 && stats.failed / processed > threshold;
}

/** Terminal status and error code for a finished execution (EXE-6). */
export function executionTerminal(
  stats: ChangeSetStats,
  outcome: Exclude<FinishOutcome, 'cancelled'>,
): { status: 'completed' | 'completed_with_errors' | 'failed'; errorCode?: string } {
  if (outcome !== 'done') return { status: 'failed', errorCode: outcome };
  if (stats.failed === 0) return { status: 'completed' };
  return stats.failed === stats.included ? { status: 'failed' } : { status: 'completed_with_errors' };
}

export interface StartEventContext {
  readonly newId: () => string;
  readonly actor: string;
  readonly clientId?: string;
  readonly groups: readonly string[];
  readonly correlationId: string;
  /** Whose request this execution is, when it differs from the actor (the approver starts it, POL-6). */
  readonly requester?: Caller;
}

/** Audit events written with the transitions and denials of a start (AUD-1). No argument values (SEC-3). */
export function startEventFactory(ctx: StartEventContext): (e: StartEvent, cs: ChangeSetRecord) => AuditEventInput {
  const clientId = ctx.clientId === undefined ? {} : { clientId: ctx.clientId };
  // A limit denial is audited for whoever's limits applied: the requester when one is given.
  const denied: Caller = ctx.requester ?? { subject: ctx.actor, groups: ctx.groups, ...clientId };
  return (e, cs) => {
    if (e.kind === 'limit_denied') {
      return {
        ...policyDecisionAuditEvent({
          id: ctx.newId(),
          caller: denied,
          tool: cs.operation,
          operation: cs.operation,
          decision: {
            effect: 'deny',
            rule: `role:${e.role}/limit:${e.limit}`,
            reason: 'limit_exceeded',
            roles: [e.role],
          },
          correlationId: ctx.correlationId,
        }),
        changesetId: cs.id,
      };
    }
    return changesetTransitionEvent({
      id: ctx.newId(),
      actor: e.kind === 'expired' ? 'system' : ctx.actor,
      ...(e.kind === 'expired' ? {} : clientId),
      changeset: cs,
      from: e.from,
      to: e.kind,
      correlationId: ctx.correlationId,
    });
  };
}

/** One audit event per executed batch: counts only (AUD-1). */
export function changesetBatchEvent(input: {
  id: string;
  changeset: Pick<ChangeSetRecord, 'id' | 'operation'>;
  batchNo: number;
  counts: BatchCounts;
  correlationId: string;
}): AuditEventInput {
  return {
    id: input.id,
    actor: 'system',
    action: 'changeset.batch',
    subject: input.changeset.operation,
    outcome: 'ok',
    correlationId: input.correlationId,
    changesetId: input.changeset.id,
    details: {
      batchNo: input.batchNo,
      written: input.counts.written,
      failed: input.counts.failed,
      skipped: input.counts.skipped,
      operation: input.changeset.operation,
    },
  };
}
