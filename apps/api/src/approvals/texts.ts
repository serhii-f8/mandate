/** Fixed answers for refused approval decisions (SEC-5: IDs only, never change-set content). */
import type { DecisionRefusal } from '@aiops/core';

export const DECISION_REFUSAL_TEXT: Readonly<Record<DecisionRefusal, (id: string) => string>> = {
  not_found: (id) => `Change-set ${id} was not found.`,
  expired: (id) => `Change-set ${id} has expired.`,
  not_pending: (id) => `Change-set ${id} is not awaiting approval.`,
  not_approver: () => 'You do not hold the role this approval step needs.',
  separation_of_duties: () => 'You cannot decide this step: you requested the change-set or decided an earlier step.',
  widget_not_allowed: () => 'This change-set must be decided on the approval page.',
  step_up_required: () => 'Log in again to decide this change-set.',
  hash_mismatch: () => 'The change-set changed; review it again.',
  count_mismatch: () => 'The number of changes does not match; review the change-set again.',
  comment_required: () => 'A comment is required to return a change-set.',
  comment_invalid: () => 'The comment is longer than 2000 characters or contains control characters.',
};
