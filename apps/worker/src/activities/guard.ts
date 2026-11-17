import type { LoadedConfiguration } from '@aiops/config';
import {
  createPolicyEngine,
  hashStoredItems,
  policyDecisionAuditEvent,
  type AuditLog,
  type Caller,
  type ChangeSetRepository,
  type ExecutionGuard,
} from '@aiops/core';

export interface ExecutionGuardDeps {
  readonly repository: Pick<ChangeSetRepository, 'itemsPage'>;
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
 *    A denial is audited as a `policy.decision` with the change-set ID (POL-8, AUD-1).
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
  return (configuration) => ({
    async check(changeset) {
      if (changeset.hash === undefined || (await hashStoredItems(repository, changeset)) !== changeset.hash) {
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
      if (decision.effect === 'allow') return { ok: true };
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
