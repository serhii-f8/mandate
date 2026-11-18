/**
 * The requester's exclusions (CS-5): derive a new change-set and start its workflow (EXE-1), shared by
 * the MCP tool and the page route so one request yields one outcome.
 */
import { deriveChangeSet, type ChangeSetRepository, type DeriveOutcome, type DeriveRequest, type WorkflowStarter } from '@aiops/core';

export interface ExclusionDeps {
  readonly repository: ChangeSetRepository;
  readonly starter: WorkflowStarter;
  readonly newId: () => string;
  readonly now: () => Date;
  readonly onStartFailure: (changesetId: string, error: unknown) => void;
}

/** deriveChangeSet, then on success starts the new change-set's workflow (EXE-1); a failed start is reported and ignored. */
export async function excludeItems(deps: ExclusionDeps, req: DeriveRequest): Promise<DeriveOutcome> {
  const outcome = await deriveChangeSet(deps, req);
  if (!outcome.ok) return outcome;
  try {
    await deps.starter.start(outcome.changeset.id);
  } catch (e) {
    // The derived change-set is prepared and stored; its submission still works, so the answer stands.
    deps.onStartFailure(outcome.changeset.id, e);
  }
  return outcome;
}
