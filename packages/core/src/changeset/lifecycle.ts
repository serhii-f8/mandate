import type { ChangeSetRecord, ChangeSetStatus } from './model.js';

/** Allowed status transitions (CS-6, design section 5.3). Anything not listed is refused. */
export const TRANSITIONS: Readonly<Record<ChangeSetStatus, readonly ChangeSetStatus[]>> = {
  preparing: ['prepared', 'failed', 'expired', 'cancelled'],
  prepared: ['pending_approval', 'executing', 'rejected', 'expired', 'cancelled'],
  pending_approval: ['approved', 'rejected', 'expired', 'cancelled'],
  approved: ['executing', 'expired', 'cancelled'],
  executing: ['completed', 'completed_with_errors', 'failed', 'cancelled'],
  completed: ['rolling_back'],
  completed_with_errors: ['rolling_back'],
  failed: [],
  rejected: [],
  expired: [],
  cancelled: [],
  rolling_back: ['rolled_back', 'failed'],
  rolled_back: [],
};

export function canTransition(from: ChangeSetStatus, to: ChangeSetStatus): boolean {
  return TRANSITIONS[from].includes(to);
}

/** Statuses before execution starts; only these expire (CS-6). */
export const PRE_EXECUTION: readonly ChangeSetStatus[] = ['preparing', 'prepared', 'pending_approval', 'approved'];

/** Statuses from which cancel_changeset applies directly (not an in-flight execution). */
export const CANCELLABLE: readonly ChangeSetStatus[] = (Object.keys(TRANSITIONS) as ChangeSetStatus[]).filter(
  (s) => s !== 'executing' && canTransition(s, 'cancelled'),
);

export function isExpiryDue(record: Pick<ChangeSetRecord, 'status' | 'expiresAt'>, now: Date): boolean {
  return PRE_EXECUTION.includes(record.status) && record.expiresAt.getTime() <= now.getTime();
}
