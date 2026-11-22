// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Mandate Authors
import type { ApprovalPlan, Submission } from '../approval/model.js';

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

/** `requester`: excluded by the requester when deriving a change-set (CS-5). */
export type ExclusionReason = 'not_found' | 'out_of_scope' | 'missing_data' | 'no_change' | 'requester';

export interface ChangeSetStats {
  readonly total: number;
  readonly included: number;
  readonly excluded: Readonly<Partial<Record<ExclusionReason, number>>>;
  readonly written: number;
  readonly failed: number;
  readonly skipped: number;
  /** EXE-8: rollback outcomes, present once an item has a rollback status. */
  readonly rollback?: RollbackCounts;
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
}

export const EMPTY_STATS: ChangeSetStats = Object.freeze({
  total: 0,
  included: 0,
  excluded: Object.freeze({}),
  written: 0,
  failed: 0,
  skipped: 0,
});
