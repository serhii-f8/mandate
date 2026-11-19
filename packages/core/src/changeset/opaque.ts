import type { OperationDefinition } from '../policy-model.js';

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
