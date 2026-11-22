// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Mandate Authors
import { approvalRuleFor, type LoadedConfiguration } from '@mandate/config';
import {
  approvalRequirement,
  changesetKind,
  createPolicyEngine,
  hashStoredItems,
  isOpaque,
  manifestAction,
  OPAQUE_TARGET_ID,
  planStepMayStart,
  policyDecisionAuditEvent,
  UnknownHashVersionError,
  type AuditLog,
  type Caller,
  type ChangeSetKind,
  type ChangeSetRecord,
  type ChangeSetRepository,
  type ExecutionGuard,
  type ManifestAction,
  type OperationDefinition,
  type PolicyDecision,
} from '@mandate/core';

const INVERSE_ACTION: Readonly<Record<ManifestAction, ManifestAction>> = { create: 'delete', delete: 'create', update: 'update' };

/** The action of an operation; none, or no manifest, is `update`. */
function operationAction(operation: OperationDefinition | undefined): ManifestAction {
  return operation?.manifest === undefined ? 'update' : manifestAction(operation.manifest);
}

/**
 * Whether a stored change-set's action (none counts as `update`) still equals its operation's under
 * the current configuration, so an update is never run as a create or a delete, nor a copy that lost
 * its action (OPS-2, ADR 0071). With `rollback`, an `inverse_operation` strategy must also name an
 * operation that undoes that action: a create's inverse a delete, a delete's a create, an update's an
 * update (EXE-8). Shared by the execution guard and `beginRollback`.
 */
export function storedActionMatches(
  operations: readonly OperationDefinition[],
  changeset: Pick<ChangeSetRecord, 'operation' | 'action'>,
  mode: 'execute' | 'rollback',
): boolean {
  const stored = changeset.action ?? 'update';
  const operation = operations.find((o) => o.id === changeset.operation);
  if (stored !== operationAction(operation)) return false;
  const strategy = operation?.manifest?.rollback;
  if (mode === 'execute' || strategy?.strategy !== 'inverse_operation') return true;
  return operationAction(operations.find((o) => o.id === strategy.operation)) === INVERSE_ACTION[stored];
}

export interface ExecutionGuardDeps {
  readonly repository: Pick<ChangeSetRepository, 'itemsPage' | 'approvals' | 'planSteps'>;
  readonly audit: AuditLog;
  readonly newId: () => string;
  /** Called once per stored-items page while hashing, so a long hash keeps its activity alive. */
  readonly heartbeat?: () => void;
}

/**
 * The production execution guard (design §4, `beginExecution`):
 * 1. the hash recomputed from the stored items, page by page, must equal the stored hash (CS-4);
 * 2. the execution request's caller (stored actor, groups and client) must still be allowed the
 *    operation with the change-set's arguments under the worker's current configuration (POL-6).
 *    A denial is audited as a `policy.decision` with the change-set ID (POL-8, AUD-1);
 * 3. the approval requirement is recomputed from the current configuration, the allowing role of
 *    that re-evaluation and `stats.included` (POL-5). When required, each step needs its own
 *    `approved` row of the current round with that step's role and the recomputed hash (a role
 *    named twice needs two rows; SEC-9, APR-2), and a round holding a `returned` row counts as
 *    unapproved (APR-4); otherwise, or when no step is configured, `approval_missing`. A change-set started from
 *    `prepared` that now needs approval fails closed (design §7).
 *
 * Before 2, a plan step above step 1 needs its predecessor `completed`, read now: the stored status may have
 * moved since the start, so a step that may no longer start is refused as `policy_denied` (EXE-13, fail closed).
 * It is not a policy decision and is not audited as one.
 *
 * Also before 2, the kind the change-set was prepared as (its stored items) must equal the kind of its
 * operation under the current configuration; a reload that flips an operation between
 * `write_opaque` and a diff kind refuses it as `policy_denied`, so a diff is never sent as an opaque
 * call nor an opaque call re-checked and written as a diff (EXE-4, SEC-9, APR-5). Likewise the
 * stored `action` (none counts as `update`) must equal the operation's: an update is never run as a
 * create or a delete, and neither is a copy that lost its action (OPS-2, ADR 0071).
 */
export function createExecutionGuard(deps: ExecutionGuardDeps): (configuration: LoadedConfiguration) => ExecutionGuard {
  const { heartbeat } = deps;
  const repository: Pick<ChangeSetRepository, 'itemsPage'> =
    heartbeat === undefined
      ? deps.repository
      : {
          itemsPage: (changesetId, query) => {
            heartbeat();
            return deps.repository.itemsPage(changesetId, query);
          },
        };

  /**
   * The kind the change-set was prepared as, from its stored items: opaque is exactly one item
   * `call` with `before: null` (design §2, `runOpaquePreparation`); anything else is a diff.
   */
  async function storedKind(changeset: ChangeSetRecord): Promise<ChangeSetKind> {
    const first = await repository.itemsPage(changeset.id, { limit: 2 });
    const [only] = first;
    return first.length === 1 && only?.targetId === OPAQUE_TARGET_ID && only.before === null
      ? 'opaque'
      : 'diff';
  }

  /** Whether the change-set carries the approvals the current configuration requires for it. */
  async function approvalsSuffice(
    configuration: LoadedConfiguration,
    changeset: ChangeSetRecord,
    decision: PolicyDecision,
    hash: string,
  ): Promise<boolean> {
    // The engine allowed the operation, so it is configured; the strictest risk and opaque stand in otherwise.
    const operation = configuration.policy.operations.find((o) => o.id === changeset.operation);
    // The allowing grant's rule, or the role's, then the field rule of a touched field (POL-5).
    const rule = approvalRuleFor(configuration, decision.rule, operation, changeset.args);
    const risk = operation?.risk ?? 'destructive';
    const requirement = approvalRequirement({
      risk,
      opaque: operation === undefined ? true : isOpaque(operation),
      ...(rule === undefined ? {} : { rule }),
      included: changeset.stats.included,
    });
    if (!requirement.required) return true;
    if (requirement.unroutable === true) return false;
    const rows = await deps.repository.approvals(changeset.id, changeset.approvalRound);
    // A returned round was sent back explicitly: none of its approvals count (APR-4).
    if (rows.some((a) => a.decision === 'returned')) return false;
    // Each step is its own approver (APR-2): a role named k times needs k approved rows (POL-5).
    const approvedBy = new Map<string, number>();
    for (const a of rows) {
      if (a.decision === 'approved' && a.hash === hash) approvedBy.set(a.role, (approvedBy.get(a.role) ?? 0) + 1);
    }
    const needed = new Map<string, number>();
    for (const step of requirement.steps) needed.set(step, (needed.get(step) ?? 0) + 1);
    return [...needed].every(([role, count]) => (approvedBy.get(role) ?? 0) >= count);
  }
  return (configuration) => ({
    async check(changeset) {
      let hash: string | undefined;
      try {
        hash = changeset.hash === undefined ? undefined : await hashStoredItems(repository, changeset);
      } catch (error) {
        // CS-4: a hash version this release cannot compute is a mismatch (fail closed).
        if (!(error instanceof UnknownHashVersionError)) throw error;
      }
      if (hash === undefined || hash !== changeset.hash) {
        return { ok: false, outcome: 'hash_mismatch' };
      }
      const request = changeset.executionRequest;
      if (request === undefined) return { ok: false, outcome: 'policy_denied' };
      if (changeset.plan !== undefined && changeset.plan.step > 1) {
        const plan = await deps.repository.planSteps(changeset.plan.id);
        if (plan === undefined || !planStepMayStart(changeset.plan.step, plan.steps)) return { ok: false, outcome: 'policy_denied' };
      }
      const operation = configuration.policy.operations.find((o) => o.id === changeset.operation);
      if (changesetKind(operation) !== (await storedKind(changeset))) return { ok: false, outcome: 'policy_denied' };
      // A change-set stored without an action is an update, so it never runs as a create or a delete (OPS-2, ADR 0071).
      if (!storedActionMatches(configuration.policy.operations, changeset, 'execute')) return { ok: false, outcome: 'policy_denied' };
      const caller: Caller = {
        subject: request.actor,
        groups: request.groups,
        ...(request.clientId === undefined ? {} : { clientId: request.clientId }),
      };
      const decision = createPolicyEngine(configuration.policy).evaluate({
        caller,
        operationId: changeset.operation,
        args: changeset.args,
      });
      if (decision.effect === 'allow') {
        return (await approvalsSuffice(configuration, changeset, decision, hash))
          ? { ok: true }
          : { ok: false, outcome: 'approval_missing' };
      }
      const tool = configuration.policy.operations.find((o) => o.id === changeset.operation)?.toolName ?? changeset.operation;
      await deps.audit.append({
        ...policyDecisionAuditEvent({
          id: deps.newId(),
          caller,
          tool,
          operation: changeset.operation,
          decision,
          correlationId: request.correlationId,
        }),
        changesetId: changeset.id,
      });
      return { ok: false, outcome: 'policy_denied' };
    },
  });
}
