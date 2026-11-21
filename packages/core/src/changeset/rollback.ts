// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The AI Operations Layer Authors
import type { AuditEventInput } from '../audit.js';
import type { Caller } from '../caller.js';
import type { PolicyEngine } from '../policy-engine.js';
import type { OperationDefinition } from '../policy-model.js';
import { isTaskId } from '../task.js';
import { changesetTransitionEvent } from './audit.js';
import { executionStarted, ROLLBACK_FROM } from './lifecycle.js';
import type { ChangeSetRecord, RollbackCounts, RollbackRequest } from './model.js';
import type { ItemOutcome, RollbackItemOutcome } from './ports.js';

/** EXE-8: a request inside this margin before `rollbackUntil` is refused, so it cannot race the workflow's last look. */
export const ROLLBACK_REQUEST_MARGIN_MS = 60_000;

const HOUR_MS = 3_600_000;

export type RollbackReason = 'not_finished' | 'already_rolled_back' | 'strategy_none' | 'window_closed' | 'nothing_written';

export type RollbackRefusal =
  | { readonly refusal: 'not_found' | 'hash_mismatch' | 'policy_denied' }
  | { readonly refusal: 'not_rollbackable'; readonly reason: RollbackReason };

export type RollbackEligibility =
  | { readonly ok: true; readonly count: number; readonly until: Date }
  | ({ readonly ok: false } & RollbackRefusal);

/** The reads eligibility needs; ChangeSetRepository gains `rollbackableCount` with this signature in Task 5. */
export interface RollbackReads {
  get(changesetId: string): Promise<ChangeSetRecord | undefined>;
  rollbackableCount(changesetId: string): Promise<number>;
}

export interface RollbackEligibilityDeps {
  readonly repository: RollbackReads;
  readonly engine: Pick<PolicyEngine, 'evaluate'>;
  readonly operations: readonly OperationDefinition[];
  readonly now: () => Date;
}

const refuse = (reason: RollbackReason): RollbackEligibility => ({ ok: false, refusal: 'not_rollbackable', reason });

/** EXE-8: a finished status a rollback may start from; `cancelled`/`failed` only when execution started. */
export function rollbackFromFinished(cs: Pick<ChangeSetRecord, 'status' | 'executionRequest'>): boolean {
  if (!ROLLBACK_FROM.includes(cs.status)) return false;
  return (cs.status !== 'cancelled' && cs.status !== 'failed') || executionStarted(cs);
}

/**
 * EXE-8: a request is accepted strictly before `until − marginMs`. Written as `now < end` so an absent or
 * invalid window end, clock or margin (NaN) closes the window instead of opening it.
 */
export function rollbackWindowOpen(until: Date | undefined, now: Date, marginMs: number): boolean {
  return until !== undefined && now.getTime() < until.getTime() - marginMs;
}

/** The operation's rollback strategy in the current configuration allows a rollback. */
function strategyAllows(operation: OperationDefinition | undefined): boolean {
  const strategy = operation?.manifest?.rollback.strategy;
  return strategy !== undefined && strategy !== 'none';
}

/**
 * EXE-8: whether the caller may roll the change-set back now. One function for the tool, the detail
 * answers and the page route; refusals come in the fixed order of the plan's Global Constraints.
 */
export async function rollbackEligibility(
  deps: RollbackEligibilityDeps,
  req: { readonly changesetId: string; readonly caller: Caller; readonly hash?: string },
): Promise<RollbackEligibility> {
  // 1. Unknown, non-UUID and foreign change-sets look the same (SEC-1); a non-UUID never reaches the store.
  const cs = isTaskId(req.changesetId) ? await deps.repository.get(req.changesetId) : undefined;
  if (cs?.requester !== req.caller.subject) return { ok: false, refusal: 'not_found' };

  // 2. The caller's hash, when given, names exactly this change-set's content.
  if (req.hash !== undefined && req.hash !== cs.hash) return { ok: false, refusal: 'hash_mismatch' };

  // 3. not_rollbackable, in the order of ruling R2.
  if (cs.status === 'rolling_back' || cs.status === 'rolled_back' || cs.rollbackRequest !== undefined) {
    return refuse('already_rolled_back');
  }
  if (!rollbackFromFinished(cs)) return refuse('not_finished');
  if (!strategyAllows(deps.operations.find((o) => o.id === cs.operation))) return refuse('strategy_none');
  const until = cs.rollbackUntil;
  if (until === undefined || !rollbackWindowOpen(until, deps.now(), ROLLBACK_REQUEST_MARGIN_MS)) {
    return refuse('window_closed');
  }
  const count = await deps.repository.rollbackableCount(cs.id);
  if (!(count > 0)) return refuse('nothing_written');

  // 4. POL-6: the policy is evaluated now for the caller with the stored arguments.
  const decision = deps.engine.evaluate({ caller: req.caller, operationId: cs.operation, args: cs.args });
  if (decision.effect !== 'allow') return { ok: false, refusal: 'policy_denied' };

  return { ok: true, count, until };
}

/** EXE-8: the end of the window for a change-set that just finished, or undefined when it is not rollbackable apart from the window (status, strategy, rollbackable > 0) or `hours` is 0. */
export function rollbackWindowEnd(input: {
  readonly changeset: ChangeSetRecord;
  readonly operation: OperationDefinition | undefined;
  readonly rollbackable: number;
  readonly hours: number;
  readonly now: Date;
}): Date | undefined {
  const { changeset: cs } = input;
  if (!(input.hours > 0) || input.rollbackable <= 0) return undefined;
  if (!rollbackFromFinished(cs) || cs.rollbackRequest !== undefined || !strategyAllows(input.operation)) return undefined;
  return new Date(input.now.getTime() + Math.round(input.hours * HOUR_MS));
}

/** EXE-8: a writer's outcome going back: a write restored the item (its error kept, e.g. `already_restored`). */
export function rollbackOutcome(o: ItemOutcome): RollbackItemOutcome {
  const status = o.status === 'written' ? 'restored' : o.status;
  return { targetId: o.targetId, status, ...(o.error === undefined ? {} : { error: o.error }) };
}

export type RollbackOutcome = 'done' | 'writer_error' | 'executor_error' | 'hash_mismatch';

/** Terminal status and error code of a finished rollback (ruling R4). */
export function rollbackTerminal(
  outcome: RollbackOutcome,
):
  | { readonly status: 'rolled_back' }
  | { readonly status: 'failed'; readonly errorCode: `rollback_${Exclude<RollbackOutcome, 'done'>}` } {
  if (outcome === 'done') return { status: 'rolled_back' };
  return { status: 'failed', errorCode: `rollback_${outcome}` };
}

/** One transaction's audit rows of an accepted request (ruling R5): the transition, then `changeset.rollback` ok `{ channel, count }`. */
export function rollbackRequestEvents(input: {
  readonly newId: () => string;
  readonly changeset: ChangeSetRecord;
  readonly request: RollbackRequest;
  readonly channel: 'page';
  readonly count: number;
}): readonly AuditEventInput[] {
  const { changeset: cs, request } = input;
  const clientId = request.clientId === undefined ? {} : { clientId: request.clientId };
  return [
    changesetTransitionEvent({
      id: input.newId(),
      actor: request.actor,
      ...clientId,
      changeset: cs,
      from: cs.status,
      to: 'rolling_back',
      correlationId: request.correlationId,
    }),
    {
      id: input.newId(),
      actor: request.actor,
      ...clientId,
      action: 'changeset.rollback',
      subject: cs.operation,
      outcome: 'ok',
      correlationId: request.correlationId,
      changesetId: cs.id,
      // Counts and IDs only: never target IDs, values or the hash (SEC-3).
      details: { channel: input.channel, count: input.count },
    },
  ];
}

/** `changeset.batch` with `details: { phase: 'rollback', batchNo, restored, skipped, failed }`. */
export function changesetRollbackBatchEvent(input: {
  readonly id: string;
  readonly changeset: Pick<ChangeSetRecord, 'id' | 'operation'>;
  readonly batchNo: number;
  readonly counts: RollbackCounts;
  readonly correlationId: string;
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
      phase: 'rollback',
      batchNo: input.batchNo,
      restored: input.counts.restored,
      skipped: input.counts.skipped,
      failed: input.counts.failed,
    },
  };
}
