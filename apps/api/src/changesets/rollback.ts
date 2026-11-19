/**
 * The `rollback` block of the detail answers (UI-4, EXE-8): `get_changeset`, the page detail and
 * `review_changeset` all report it through `rollbackBlock`, which asks the one eligibility function
 * of `core` without a hash. Only the requester can see a rollback as available (ruling R10, T11/F3).
 */
import {
  rollbackEligibility,
  type Caller,
  type ChangeSetRecord,
  type ChangeSetRepository,
  type RollbackCounts,
  type RollbackEligibilityDeps,
  type RollbackReason,
} from '@aiops/core';
import type { Snapshot } from '../mcp/tool-pipeline.js';

export interface RollbackBlock {
  available: boolean;
  count?: number;
  /** ISO time; a request must arrive before it, less the request margin. */
  until?: string;
  reason?: RollbackReason | 'policy_denied';
  /** Present once an item has a rollback status. */
  stats?: RollbackCounts;
}

/** Eligibility under one configuration snapshot: its engine and its operations (POL-6, design §2). */
export function eligibilityDeps(repository: ChangeSetRepository, snapshot: Snapshot, now: () => Date): RollbackEligibilityDeps {
  return { repository, engine: snapshot.engine, operations: snapshot.configuration.policy.operations, now };
}

/** The block of get_changeset and the page detail: eligibility without a hash, for the requester only (ruling R10). */
export async function rollbackBlock(
  deps: { repository: ChangeSetRepository; snapshot: Snapshot; now: () => Date },
  record: ChangeSetRecord,
  caller: Caller,
): Promise<RollbackBlock> {
  const stats = record.stats.rollback === undefined ? {} : { stats: record.stats.rollback };
  // A viewer who is not the requester never gets an offer, nor a reason (SEC-1).
  if (record.requester !== caller.subject) return { available: false, ...stats };
  const e = await rollbackEligibility(eligibilityDeps(deps.repository, deps.snapshot, deps.now), { changesetId: record.id, caller });
  if (e.ok) return { available: true, count: e.count, until: e.until.toISOString(), ...stats };
  switch (e.refusal) {
    case 'not_rollbackable':
      return { available: false, reason: e.reason, ...stats };
    case 'policy_denied':
      return { available: false, reason: 'policy_denied', ...stats };
    // Without a hash there is no mismatch; not_found means the record went away meanwhile.
    case 'not_found':
    case 'hash_mismatch':
      return { available: false, ...stats };
  }
}
