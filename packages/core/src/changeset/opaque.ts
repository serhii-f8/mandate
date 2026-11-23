// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Mandate Authors
import type { OperationDefinition } from '../policy-model.js';
import { changesetTransitionEvent } from './audit.js';
import { CURRENT_HASH_VERSION, FILES_HASH_VERSION } from './hash.js';
import type { ChangeItemRecord, ChangeSetRecord, ChangeSetStatus } from './model.js';
import type { PrepareDeps, PrepareOutcome } from './prepare.js';
import { hashStoredItems } from './verify.js';

/** The target ID of the one item an opaque change-set holds (design §2). */
export const OPAQUE_TARGET_ID = 'call';

/** How a change-set is shown and handled: one raw call, or a per-record diff. */
export type ChangeSetKind = 'opaque' | 'diff';

/**
 * Whether an operation is opaque (design §2): `write_opaque`, or `destructive` without a
 * manifest. Its change-set is one upstream call with no diff, no exclusion and no rollback.
 * The only definition; every other module calls it.
 */
export function isOpaque(op: Pick<OperationDefinition, 'risk' | 'manifest'>): boolean {
  return op.risk === 'write_opaque' || (op.risk === 'destructive' && op.manifest === undefined);
}

/** The kind of a change-set from its operation in the snapshot; a missing operation reads as `diff`. */
export function changesetKind(op: Pick<OperationDefinition, 'risk' | 'manifest'> | undefined): ChangeSetKind {
  return op !== undefined && isOpaque(op) ? 'opaque' : 'diff';
}

export interface OpaquePreparationRequest {
  readonly changesetId: string;
  readonly operation: OperationDefinition;
  readonly actor: string;
  readonly clientId?: string;
  readonly correlationId: string;
}

/** As `runPreparation`: the first items an answer carries. */
const FIRST_ITEMS = 20;

/**
 * Prepares a created opaque change-set (design §3): stores its one item (`call`, `before` null,
 * `after` the stored arguments) and hashes it, so the hash binds the raw arguments (CS-4, SEC-9).
 * Reads nothing upstream (CS-1). The append is idempotent by target, so a re-run after a crash
 * continues where it stopped (NFR-2, ruling R5); a change-set that left `preparing` is answered as
 * `runPreparation` answers it.
 */
export async function runOpaquePreparation(
  deps: Pick<PrepareDeps, 'repository' | 'newId' | 'now'>,
  req: OpaquePreparationRequest,
): Promise<PrepareOutcome> {
  const { repository } = deps;
  const id = req.changesetId;

  const current = await repository.get(id);
  if (current === undefined) return { ok: false, code: 'not_found' };
  if (current.status === 'prepared') {
    return { ok: true, changeset: current, firstItems: await repository.itemsPage(id, { limit: FIRST_ITEMS }) };
  }
  if (current.status === 'cancelled' || current.status === 'expired') {
    return { ok: false, changesetId: id, code: 'cancelled' };
  }
  if (current.status !== 'preparing') {
    return { ok: false, changesetId: id, code: current.errorCode ?? 'internal' };
  }

  const event = (to: ChangeSetStatus, details: Record<string, string | number>) =>
    changesetTransitionEvent({
      id: deps.newId(),
      actor: req.actor,
      ...(req.clientId === undefined ? {} : { clientId: req.clientId }),
      changeset: { id, operation: req.operation.id },
      from: 'preparing',
      to,
      correlationId: req.correlationId,
      details,
    });
  const fail = async (code: string): Promise<PrepareOutcome> => {
    const failed = await repository.completePreparation(
      id,
      { status: 'failed', errorCode: code },
      event('failed', { errorCode: code }),
    );
    return { ok: false, changesetId: id, code: failed === undefined ? 'cancelled' : code };
  };

  // The configuration changed under a created change-set: never store a raw call for a diff operation.
  if (!isOpaque(req.operation)) return fail('operation_unavailable');

  let changeset: ChangeSetRecord | undefined;
  try {
    const item: ChangeItemRecord = { targetId: OPAQUE_TARGET_ID, status: 'pending', before: null, after: current.args };
    await repository.appendItems(id, [item]);
    const stats = await repository.stats(id);
    // CS-4: the current version, or version 3 for a change-set with files (CS-10); an opaque change-set
    // has no manifest, so no action (hashed as null).
    const hashVersion = (current.files?.length ?? 0) > 0 ? FILES_HASH_VERSION : CURRENT_HASH_VERSION;
    const hash = await hashStoredItems(repository, {
      id: current.id,
      operation: current.operation,
      args: current.args,
      hashVersion,
    });
    changeset = await repository.completePreparation(
      id,
      { status: 'prepared', hash, hashVersion, stats, preparedAt: deps.now() },
      event('prepared', { included: 1, excluded: 0 }),
    );
  } catch (err) {
    const now = await repository.get(id);
    if (now !== undefined && now.status !== 'preparing') return { ok: false, changesetId: id, code: 'cancelled' };
    try {
      return await fail('internal');
    } catch {
      // Marking is best effort; the original error is the one worth reporting.
      throw err;
    }
  }
  if (changeset === undefined) return { ok: false, changesetId: id, code: 'cancelled' };
  return { ok: true, changeset, firstItems: await repository.itemsPage(id, { limit: FIRST_ITEMS }) };
}
