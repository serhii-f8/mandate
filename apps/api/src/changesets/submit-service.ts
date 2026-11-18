/**
 * Submission of a prepared or approved change-set (MCP-8; design part 1 §5), shared by
 * `submit_for_approval` and the change-set page. Re-checks policy with the caller's current identity
 * and configuration (POL-6). A prepared one starts when the allowing role needs no approval (POL-5),
 * with that role's limits (POL-4), or moves to `pending_approval` for the role's approval steps; an
 * approved one starts with the identity it was submitted under. The caller maps the outcome to its
 * own answer; texts and audit details stay with the channel.
 */
import { executionLimits } from '@aiops/config';
import {
  allowingRole,
  approvalRequestedEvent,
  approvalRequestNotifications,
  approvalRequirement,
  changesetTransitionEvent,
  ExecutorUnavailable,
  type ApprovalPlan,
  type AuditLog,
  type Caller,
  type ChangeSetExecutor,
  type ChangeSetRecord,
  type ChangeSetRepository,
  type ChangeSetStatus,
  type PolicyDecision,
  type StartOutcome,
  type Submission,
} from '@aiops/core';
import type { ApprovalService } from '../approvals/approval-service.js';
import { load } from '../mcp/changeset-tools.js';
import { recordDecision } from '../mcp/policy-answers.js';
import type { Snapshot } from '../mcp/tool-pipeline.js';

/** The tool name the decision row carries for both channels (ruling R5). */
export const SUBMIT_TOOL = 'submit_for_approval';

export interface SubmitServiceDeps {
  readonly repository: ChangeSetRepository;
  readonly executor: ChangeSetExecutor;
  readonly audit: AuditLog;
  readonly approvals: Pick<ApprovalService, 'startApproved'>;
  readonly newId: () => string;
  readonly now: () => Date;
}

export interface SubmitRequest {
  readonly caller: Caller;
  readonly correlationId: string;
  readonly changesetId: string;
  readonly hash: string;
  readonly snapshot: Snapshot;
}

type PlainReason = 'not_found' | 'hash_mismatch' | 'expired' | 'approval_unroutable' | 'executor_unavailable' | 'audit_unavailable';

export type SubmitRefusal =
  | { readonly kind: 'refused'; readonly reason: PlainReason }
  /** The transaction to `pending_approval` refused after the checks passed: someone changed the row meanwhile (ruling F2). */
  | { readonly kind: 'refused'; readonly reason: 'not_found' | 'hash_mismatch' | 'expired'; readonly raced: true }
  /** `wrong_status`: before any change; `not_prepared`: lost the race in `submitForApproval`, with the status it has now. */
  | { readonly kind: 'refused'; readonly reason: 'wrong_status' | 'not_prepared'; readonly status: ChangeSetStatus }
  | { readonly kind: 'refused'; readonly reason: 'policy_denied'; readonly decision: PolicyDecision }
  | { readonly kind: 'refused'; readonly reason: 'start_refused'; readonly role: string; readonly refusal: Exclude<StartOutcome, { ok: true }> };

export type SubmitOutcome =
  | { readonly kind: 'pending_approval'; readonly changeset: ChangeSetRecord; readonly plan: ApprovalPlan }
  | { readonly kind: 'started'; readonly changeset: ChangeSetRecord }
  | SubmitRefusal;

const refused = (reason: PlainReason): SubmitRefusal => ({ kind: 'refused', reason });

export class SubmitService {
  constructor(private readonly deps: SubmitServiceDeps) {}

  async submit(req: SubmitRequest): Promise<SubmitOutcome> {
    const { deps } = this;
    const { caller, correlationId, changesetId: id, hash, snapshot } = req;

    // 1. Requester only; unknown and foreign IDs look the same (expires lazily, CS-6).
    const record = await load(deps, caller, correlationId, id);
    if (record === undefined) return refused('not_found');

    // 2. Only prepared and approved change-sets can be submitted; a second submit finds it pending or executing.
    if (record.status !== 'prepared' && record.status !== 'approved') return { kind: 'refused', reason: 'wrong_status', status: record.status };

    // 3. SEC-9: the hash the caller reviewed, on every path and before anything changes.
    if (record.hash !== hash) return refused('hash_mismatch');

    // 4. POL-6: the stored arguments against the caller's current identity and configuration, audited (POL-8).
    const decision = snapshot.engine.evaluate({ caller, operationId: record.operation, args: record.args });
    const recorded = await recordDecision(deps, { caller, correlationId }, SUBMIT_TOOL, decision, { operation: record.operation, changesetId: id });
    if (decision.effect === 'deny') return { kind: 'refused', reason: 'policy_denied', decision };
    if (!recorded) return refused('audit_unavailable');

    // 5. Approved: start with the identity and role it was submitted under (POL-6, design §6).
    if (record.status === 'approved') {
      const outcome = await deps.approvals.startApproved({
        changesetId: id,
        actor: caller.subject,
        ...(caller.clientId === undefined ? {} : { clientId: caller.clientId }),
        correlationId,
        snapshot: snapshot.configuration,
      });
      if (!outcome.ok) {
        if (outcome.reason === 'executor_unavailable') return refused('executor_unavailable');
        return { kind: 'refused', reason: 'start_refused', role: record.submission?.role ?? '', refusal: outcome };
      }
      return { kind: 'started', changeset: record };
    }

    // 6. Prepared: the allowing rule's role decides approval (POL-5), as it decides limits (ADR 0027).
    const role = allowingRole(decision.rule);
    const rule = role === undefined ? undefined : snapshot.configuration.approval.get(role);
    // An operation the engine allowed is in the snapshot; the strictest risk stands in otherwise.
    const risk = snapshot.configuration.policy.operations.find((op) => op.id === record.operation)?.risk ?? 'destructive';
    const requirement = approvalRequirement({ risk, ...(rule === undefined ? {} : { rule }), included: record.stats.included });
    if (role === undefined || (requirement.required && requirement.unroutable === true)) return refused('approval_unroutable');
    const submission: Submission = {
      actor: caller.subject,
      groups: caller.groups,
      ...(caller.clientId === undefined ? {} : { clientId: caller.clientId }),
      correlationId,
      at: deps.now(),
      role,
      rule: decision.rule,
    };
    if (requirement.required) {
      const { required: _required, unroutable: _unroutable, ...plan } = requirement; // eslint-disable-line @typescript-eslint/no-unused-vars -- not part of the plan
      return this.sendForApproval(req, record, submission, plan);
    }

    // 7. No approval: start with the role's limits (POL-4); a limit refusal's deny row is written by the start itself.
    const limits = executionLimits(snapshot.configuration, role);
    let outcome: StartOutcome;
    try {
      outcome = await deps.executor.start({
        changesetId: id,
        expectedHash: hash,
        actor: caller.subject,
        correlationId,
        groups: caller.groups,
        ...(limits === undefined ? {} : { limits }),
        ...(caller.clientId === undefined ? {} : { clientId: caller.clientId }),
        submission,
      });
    } catch (e) {
      if (!(e instanceof ExecutorUnavailable)) throw e;
      return refused('executor_unavailable');
    }
    if (!outcome.ok) return { kind: 'refused', reason: 'start_refused', role, refusal: outcome };
    return { kind: 'started', changeset: record };
  }

  /** Required approval (POL-5): one transaction to `pending_approval`; it waits for people (APR-1). */
  private async sendForApproval(req: SubmitRequest, record: ChangeSetRecord, submission: Submission, plan: ApprovalPlan): Promise<SubmitOutcome> {
    const { deps } = this;
    const { caller, correlationId, hash, snapshot } = req;
    const id = record.id;
    const first = plan.steps[0];
    // A required plan always has steps; the unroutable case was answered before.
    if (first === undefined) throw new Error('approval plan has no steps');
    const clientId = caller.clientId === undefined ? {} : { clientId: caller.clientId };
    const round = record.approvalRound + 1;
    const outcome = await deps.repository.submitForApproval({
      changesetId: id,
      expectedHash: hash,
      submission,
      plan,
      audit: {
        transition: changesetTransitionEvent({
          id: deps.newId(),
          actor: caller.subject,
          ...clientId,
          changeset: record,
          from: 'prepared',
          to: 'pending_approval',
          correlationId,
        }),
        requested: approvalRequestedEvent({
          id: deps.newId(),
          actor: caller.subject,
          ...clientId,
          changeset: record,
          round,
          step: 1,
          role: first,
          correlationId,
        }),
      },
      // NTF-1: the step-1 role is asked to decide, not the requester's role.
      notifications: approvalRequestNotifications(snapshot.configuration.notify, { role: first, round, step: 1 }),
    });
    if (!outcome.ok) {
      if (outcome.reason === 'not_prepared') {
        // Someone else moved it first: name the status it has now.
        return { kind: 'refused', reason: 'not_prepared', status: (await deps.repository.get(id))?.status ?? record.status };
      }
      return { kind: 'refused', reason: outcome.reason, raced: true };
    }
    return { kind: 'pending_approval', changeset: record, plan };
  }
}
