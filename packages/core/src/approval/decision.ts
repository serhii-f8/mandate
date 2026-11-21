// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The AI Operations Layer Authors
import { isExpiryDue } from '../changeset/lifecycle.js';
import type { ChangeSetRecord } from '../changeset/model.js';
import { serviceClientOf } from '../roles.js';
import type {
  ApprovalChannel,
  ApprovalRecord,
  Approver,
  DecisionRefusal,
  DecisionRequest,
} from './model.js';

/** Tolerated lead of the identity provider's clock over the server's for `auth_time` (AUTH-6). */
const AUTH_TIME_SKEW_MS = 60_000;

export const MAX_COMMENT_LENGTH = 2000;
// Control characters except tab (\u0009) and newline (\u000A).
// eslint-disable-next-line no-control-regex -- the point of the check
const CONTROL = /[\u0000-\u0008\u000B-\u001F\u007F]/;

function roundApprovals(changeset: ChangeSetRecord, approvals: readonly ApprovalRecord[]): ApprovalRecord[] {
  return approvals.filter((a) => a.round === changeset.approvalRound);
}

/** The 1-based next undecided step of the current round; `undefined` unless `pending_approval`. */
export function currentStep(changeset: ChangeSetRecord, approvals: readonly ApprovalRecord[]): number | undefined {
  if (changeset.status !== 'pending_approval' || changeset.approvalPlan === undefined) return undefined;
  const decided = roundApprovals(changeset, approvals).filter((a) => a.decision === 'approved').length;
  return decided + 1;
}

/** Who may see a change-set's approval view (SEC-1): the requester, holders of a plan step role, recorded approvers. */
export function canView(
  changeset: ChangeSetRecord,
  approvals: readonly ApprovalRecord[],
  viewer: { subject: string; roles: readonly string[] },
): boolean {
  if (changeset.requester === viewer.subject) return true;
  if (changeset.approvalPlan === undefined) return false;
  if (changeset.approvalPlan.steps.some((role) => viewer.roles.includes(role))) return true;
  return approvals.some((a) => a.approver === viewer.subject);
}

/** Pure checks 1-9 of design part 1 section 6, in that order, except the lazy expiry write; `undefined` = allowed. */
export function checkDecision(input: {
  changeset: ChangeSetRecord;
  approvals: readonly ApprovalRecord[];
  approver: Approver;
  channel: ApprovalChannel;
  decision: DecisionRequest;
  hash: string;
  count: number;
  comment?: string;
  now: Date;
}): DecisionRefusal | undefined {
  const { changeset, approvals, approver, channel, decision, now } = input;
  const plan = changeset.approvalPlan;

  // 1. Not visible looks like unknown (SEC-1).
  if (!canView(changeset, approvals, { subject: approver.subject, roles: approver.roles })) return 'not_found';
  // 2. Expired, including a change-set the workflow timer already moved to expired (CS-6).
  if (changeset.status === 'expired' || isExpiryDue(changeset, now)) return 'expired';
  // 3.
  if (changeset.status !== 'pending_approval' || plan === undefined) return 'not_pending';
  const mine = roundApprovals(changeset, approvals);
  const step = currentStep(changeset, approvals) ?? 1;
  const role = changeset.awaitingRole ?? plan.steps[step - 1];
  // 4. APR-1.
  if (role === undefined || !approver.roles.includes(role)) return 'not_approver';
  // AUTH-4: service accounts never decide (APR-2, APR-8).
  if (serviceClientOf(approver.subject) !== undefined) return 'not_approver';
  // 5. APR-2: not the requester, and one person decides one step of a round.
  if (approver.subject === changeset.requester) return 'separation_of_duties';
  if (mine.some((a) => a.approver === approver.subject)) return 'separation_of_duties';
  // 6. APR-8.
  if (channel === 'widget' && !plan.widget) return 'widget_not_allowed';
  // 7. AUTH-6, page channel only.
  if (channel === 'page' && plan.stepUp !== undefined) {
    const authTime = approver.authTime;
    // Fail closed on an unusable time: an Invalid Date compares false both ways, and a login
    // later than the server clock beyond a small skew cannot be a real login (AUTH-6).
    if (authTime === undefined || !Number.isFinite(authTime.getTime())) return 'step_up_required';
    if (authTime.getTime() > now.getTime() + AUTH_TIME_SKEW_MS) return 'step_up_required';
    if (changeset.submission !== undefined && authTime.getTime() < changeset.submission.at.getTime()) {
      return 'step_up_required';
    }
    if (now.getTime() - authTime.getTime() > plan.stepUp.maxAgeSeconds * 1000) return 'step_up_required';
  }
  // 8. SEC-9, APR-6: only approve is bound to the hash and count.
  if (decision === 'approve') {
    if (changeset.hash !== input.hash) return 'hash_mismatch';
    if (changeset.stats.included !== input.count) return 'count_mismatch';
  }
  // 9. APR-4.
  const comment = input.comment;
  if (decision === 'return' && (comment === undefined || comment.trim() === '')) return 'comment_required';
  if (comment !== undefined && (comment.length > MAX_COMMENT_LENGTH || CONTROL.test(comment))) {
    return 'comment_invalid';
  }
  return undefined;
}
