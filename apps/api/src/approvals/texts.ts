// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Mandate Authors
/** Fixed answers for refused approval decisions (SEC-5: IDs only, never change-set content). */
import type { ChangeSetStats, DecisionRefusal, OperationDefinition } from '@mandate/core';

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

/** EXE-12: what the three fixed verification codes read as beside a "Not confirmed" item. */
export const VERIFICATION_CODE_TEXT: Readonly<Record<string, string>> = {
  verify_read_failed: 'could not be read',
  verify_timeout: 'not confirmed in time',
  verify_cancelled: 'verification was cancelled',
};

/**
 * EXE-12: the texts of the verification codes of a verified change-set: the titles of the
 * operation's `verify_after` checks under the current configuration, then the fixed codes' texts.
 * Absent for a change-set that was never verified, so its answer is unchanged. Display only (SEC-3).
 */
export function verificationTitlesOf(op: OperationDefinition | undefined, stats: ChangeSetStats): Record<string, string> | undefined {
  if (stats.verification === undefined) return undefined;
  const out: Record<string, string> = {};
  for (const check of op?.manifest?.verifyAfter?.checks ?? []) if (check.title !== undefined) out[check.code] = check.title;
  return { ...out, ...VERIFICATION_CODE_TEXT };
}
