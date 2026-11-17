import type { LoadedConfiguration } from '@aiops/config';
import {
  allowingRole,
  approvalRequirement,
  createPolicyEngine,
  hashStoredItems,
  policyDecisionAuditEvent,
  type AuditLog,
  type Caller,
  type ChangeSetRecord,
  type ChangeSetRepository,
  type ExecutionGuard,
  type PolicyDecision,
} from '@aiops/core';

export interface ExecutionGuardDeps {
  readonly repository: Pick<ChangeSetRepository, 'itemsPage' | 'approvals'>;
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

  /** Whether the change-set carries the approvals the current configuration requires for it. */
  async function approvalsSuffice(
    configuration: LoadedConfiguration,
    changeset: ChangeSetRecord,
    decision: PolicyDecision,
    hash: string,
  ): Promise<boolean> {
    const role = allowingRole(decision.rule);
    const rule = role === undefined ? undefined : configuration.approval.get(role);
    // The engine allowed the operation, so it is configured; the strictest risk stands in otherwise.
    const risk = configuration.policy.operations.find((o) => o.id === changeset.operation)?.risk ?? 'destructive';
    const requirement = approvalRequirement({
      risk,
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
      const hash = changeset.hash === undefined ? undefined : await hashStoredItems(repository, changeset);
      if (hash === undefined || hash !== changeset.hash) {
        return { ok: false, outcome: 'hash_mismatch' };
      }
      const request = changeset.executionRequest;
      if (request === undefined) return { ok: false, outcome: 'policy_denied' };
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
