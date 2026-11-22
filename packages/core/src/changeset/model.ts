// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Mandate Authors
import type { ApprovalPlan, Submission } from '../approval/model.js';
import type { ManifestAction } from '../policy-model.js';
import type { HashVersion } from './hash.js';

export type ChangeSetStatus =
  | 'preparing'
  | 'prepared'
  | 'pending_approval'
  | 'approved'
  | 'executing'
  | 'completed'
  | 'completed_with_errors'
  | 'failed'
  | 'rejected'
  | 'expired'
  | 'cancelled'
  | 'rolling_back'
  | 'rolled_back';

export type ItemStatus = 'pending' | 'excluded' | 'written' | 'failed' | 'skipped';

/**
 * The built-in exclusion reasons, in display order. `requester`: excluded by the requester when
 * deriving a change-set (CS-5). `already_exists`: a create whose record is already upstream (OPS-2,
 * ADR 0071).
 */
export const BUILTIN_EXCLUSION_REASONS = [
  'not_found',
  'out_of_scope',
  'missing_data',
  'no_change',
  'already_exists',
  'requester',
] as const;

export type BuiltinExclusionReason = (typeof BUILTIN_EXCLUSION_REASONS)[number];

/**
 * A built-in reason or the `code` of a manifest's preparation check (CS-3, ADR 0072). Code that shows
 * or counts reasons handles any string: an unknown code is shown as it is.
 */
export type ExclusionReason = BuiltinExclusionReason | (string & {});

export interface ChangeSetStats {
  readonly total: number;
  readonly included: number;
  /** Excluded items per reason: the built-ins and any check code (CS-3); a reason with none is absent. */
  readonly excluded: Readonly<Record<string, number>>;
  readonly written: number;
  readonly failed: number;
  readonly skipped: number;
  /** EXE-8: rollback outcomes, present once an item has a rollback status. */
  readonly rollback?: RollbackCounts;
  /** EXE-12: verification outcomes, present once verification began. */
  readonly verification?: VerificationCounts;
}

/** EXE-12 (ADR 0073): an item's verification state; absent on an item that was never verified. */
export type VerificationStatus = 'pending' | 'confirmed' | 'unconfirmed';

export interface VerificationCounts {
  readonly pending: number;
  readonly confirmed: number;
  readonly unconfirmed: number;
}

export type RollbackItemStatus = 'restored' | 'skipped' | 'failed';

export interface RollbackCounts {
  readonly restored: number;
  readonly skipped: number;
  readonly failed: number;
}

/** EXE-8: who asked for the rollback of an executed change-set, once (no retry after a failed rollback). */
export interface RollbackRequest {
  readonly actor: string;
  readonly clientId?: string;
  readonly correlationId: string;
  readonly requestedAt: Date;
}

export interface ExecutionRequest {
  readonly actor: string;
  readonly groups: readonly string[];
  readonly clientId?: string;
  readonly correlationId: string;
  readonly startedAt: Date;
}

export interface CancelRequest {
  readonly actor: string;
  readonly correlationId: string;
  readonly requestedAt: Date;
}

export interface ChangeSetRecord {
  readonly id: string;
  readonly operation: string;
  readonly connection: string;
  readonly requester: string;
  readonly clientId?: string;
  readonly args: Readonly<Record<string, unknown>>;
  readonly hash?: string;
  /**
   * CS-4: the format `hash` was sealed with, written together with it at preparation and fixed from
   * then on. Absent means 1 (a record from before 1.2.0); the repository always returns it.
   */
  readonly hashVersion?: HashVersion;
  /** CS-4: the manifest action sealed into a version 2 hash; absent for version 1 and for an opaque change-set. */
  readonly action?: ManifestAction;
  readonly status: ChangeSetStatus;
  readonly stats: ChangeSetStats;
  readonly errorCode?: string;
  /** Upstream HTTP status of a failed preparation read, stored with `errorCode` (never upstream text, SEC-3). */
  readonly errorStatus?: number;
  readonly configHash: string;
  readonly correlationId: string;
  readonly createdAt: Date;
  /** Latest transition or outcome time (MCP-7 task `lastUpdatedAt`). */
  readonly updatedAt?: Date;
  readonly preparedAt?: Date;
  readonly expiresAt: Date;
  readonly executionRequest?: ExecutionRequest;
  readonly cancelRequest?: CancelRequest;
  /** Approval round: 0 until first submitted for approval; a return starts the next round (APR-4). */
  readonly approvalRound: number;
  readonly submission?: Submission;
  readonly approvalPlan?: ApprovalPlan;
  /** Role of the step awaiting a decision while `pending_approval`. */
  readonly awaitingRole?: string;
  /** CS-5: the source change-set this one was derived from; absent for one prepared by a tool call. */
  readonly derivedFrom?: string;
  /** EXE-8: end of the rollback window, set when execution finished with rollbackable items. */
  readonly rollbackUntil?: Date;
  readonly rollbackRequest?: RollbackRequest;
  /** EXE-12: the verification deadline, written once when verification begins. */
  readonly verificationUntil?: Date;
}

export interface ChangeItemRecord {
  readonly targetId: string;
  readonly status: ItemStatus;
  readonly reason?: ExclusionReason;
  readonly before: unknown;
  readonly after: unknown;
  readonly error?: string;
  /** EXE-8: the outcome of restoring this item's `before` value. */
  readonly rollbackStatus?: RollbackItemStatus;
  readonly rollbackError?: string;
  /** EXE-12: the verification state of a written item; the item's `status` stays `written`. */
  readonly verificationStatus?: VerificationStatus;
  /**
   * EXE-12: the code of the first failing verify check, or a fixed verification code
   * (`verify_read_failed`, `verify_timeout`, `verify_cancelled`). Never a value (SEC-3).
   */
  readonly verificationCode?: string;
}

/**
 * `ChangeSetStats.excluded` from `[reason, count]` pairs, summed per reason. Safe for any string: a
 * check code that names an `Object.prototype` member (`constructor`, `valueOf`) is counted as its
 * own key, never read from the prototype (CS-3).
 */
export function countExclusions(pairs: Iterable<readonly [ExclusionReason, number]>): Record<string, number> {
  const counts = new Map<string, number>();
  for (const [reason, n] of pairs) counts.set(reason, (counts.get(reason) ?? 0) + n);
  // fromEntries defines own data properties, so even `__proto__` stays a plain key.
  return Object.fromEntries(counts);
}

export const EMPTY_STATS: ChangeSetStats = Object.freeze({
  total: 0,
  included: 0,
  excluded: Object.freeze({}),
  written: 0,
  failed: 0,
  skipped: 0,
});
