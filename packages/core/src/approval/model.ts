// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Mandate Authors
export type ApprovalDecision = 'approved' | 'rejected' | 'returned';
export type DecisionRequest = 'approve' | 'reject' | 'return';
export type ApprovalChannel = 'page' | 'widget';
/** `opaque`: an opaque call has no record count, so `above_threshold` cannot waive it (POL-5). */
export type ApprovalReason = 'risk_destructive' | 'role_always' | 'default' | 'above_threshold' | 'opaque';

/** The approval requirement of a change-set round, frozen at submission (POL-5). */
export interface ApprovalPlan {
  readonly reason: ApprovalReason;
  /** Role IDs, 1..5. */
  readonly steps: readonly string[];
  readonly stepUp?: { readonly maxAgeSeconds: number };
  readonly widget: boolean;
  readonly threshold?: number;
  readonly included: number;
}

export type ApprovalRequirement =
  | { readonly required: false }
  | { readonly required: true; readonly unroutable: true; readonly reason: ApprovalReason }
  | ({ readonly required: true; readonly unroutable?: false } & ApprovalPlan);

/** Role approval as core sees it (configuration maps YAML onto this). */
export interface RoleApprovalRule {
  readonly required?: 'always' | 'never' | 'above_threshold';
  readonly recordThreshold?: number;
  readonly steps: readonly string[];
  readonly stepUpMaxAgeSeconds?: number;
  readonly allowWidget: boolean;
}

export const DEFAULT_STEP_UP_SECONDS = 120;

export interface Submission {
  readonly actor: string;
  readonly groups: readonly string[];
  readonly clientId?: string;
  readonly correlationId: string;
  readonly at: Date;
  /** Allowing role and rule reference. */
  readonly role: string;
  readonly rule: string;
}

export interface ApprovalRecord {
  readonly id: string;
  readonly changesetId: string;
  readonly round: number;
  readonly step: number;
  readonly role: string;
  readonly approver: string;
  readonly approverName?: string;
  readonly decision: ApprovalDecision;
  readonly comment?: string;
  readonly hash: string;
  readonly itemCount: number;
  readonly channel: ApprovalChannel;
  readonly authTime?: Date;
  readonly clientId?: string;
  readonly correlationId: string;
  readonly ts: Date;
}

export type DecisionRefusal =
  | 'not_found'
  | 'expired'
  | 'not_pending'
  | 'not_approver'
  | 'separation_of_duties'
  | 'widget_not_allowed'
  | 'step_up_required'
  | 'hash_mismatch'
  | 'count_mismatch'
  | 'comment_required'
  | 'comment_invalid';

export interface Approver {
  readonly subject: string;
  readonly name?: string;
  readonly roles: readonly string[];
  readonly clientId?: string;
  readonly authTime?: Date;
}

export type NotificationKind = 'approval_requested' | 'approval_decided' | 'execution_finished' | 'rollback_result';

export interface NewNotification {
  readonly kind: NotificationKind;
  readonly round: number;
  readonly step: number;
  readonly target: string;
}
