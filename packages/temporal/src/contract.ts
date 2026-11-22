// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Mandate Authors
/**
 * The contract between `changesetWorkflow` and its starters and activities (EXE-1, EXE-2).
 * Imported by workflow code through `@mandate/temporal/contract`: it must stay pure, with
 * type-only imports, so the workflow bundle pulls in nothing non-deterministic (EXE-10).
 * Workflow code imports the core types it needs from here, never from `@mandate/core`.
 */
import type { ChangeSetStatus, FinishOutcome, RollbackCounts, RollbackOutcome, VerificationEnd } from '@mandate/core';

export type { ChangeSetStatus, FinishOutcome, RollbackCounts, RollbackOutcome, VerificationEnd } from '@mandate/core';

export const CHANGESET_WORKFLOW = 'changesetWorkflow';
export const DEFAULT_TASK_QUEUE = 'mandate-operations';
export const WAKE_SIGNAL = 'wake';
export const PROGRESS_QUERY = 'progress';
export const PREPARE_MAX_ATTEMPTS = 5;

export interface ExecutionCounts {
  readonly done: number;
  readonly failed: number;
  readonly skipped: number;
}

/** Carried through continue-as-new: where the next run resumes (identifiers and counters only). */
export interface ExecutionResume {
  readonly nextBatch: number;
  readonly counts: ExecutionCounts;
  readonly verified: true;
  /** EXE-12: the last verification round a previous run looked at; absent before verification began. */
  readonly verificationRound?: number;
}

export interface ChangesetWorkflowInput {
  readonly changesetId: string;
  readonly resume?: ExecutionResume;
}

export interface ChangesetWorkflowResult {
  readonly status: ChangeSetStatus;
}

export interface WorkflowProgress extends ExecutionCounts {
  readonly status: ChangeSetStatus;
  readonly total: number;
}

export interface ActivityTuning {
  /** Start-to-close of one `prepare` attempt: the ceiling of a whole preparation (NFR-7). */
  readonly prepareTimeoutMs: number;
  readonly batchHeartbeatMs: number;
  readonly batchTimeoutMs: number;
  readonly batchMaxAttempts: number;
  readonly retryInitialMs: number;
  readonly retryMaxMs: number;
}

/** Heartbeat timeout of `prepare` (fixed): a lost worker is noticed within it. */
export const PREPARE_HEARTBEAT_MS = 60_000;

export const DEFAULT_TUNING: ActivityTuning = {
  prepareTimeoutMs: 3_600_000,
  batchHeartbeatMs: 30_000,
  batchTimeoutMs: 900_000,
  batchMaxAttempts: 10,
  retryInitialMs: 1_000,
  retryMaxMs: 30_000,
};

export interface InspectResult extends ExecutionCounts {
  readonly status: ChangeSetStatus;
  readonly expiresAtMs: number;
  readonly total: number;
  readonly tuning: ActivityTuning;
}

export type BeginResult =
  | ({
      readonly ok: true;
      readonly total: number;
      readonly batchSize: number;
      readonly itemsPerRun: number;
      readonly cancelRequested: boolean;
      /** EXE-12: true when the operation's manifest has `verify_after`; absent means no verification. */
      readonly verifyAfter?: boolean;
    } & ExecutionCounts)
  | { readonly ok: false; readonly outcome: 'hash_mismatch' | 'policy_denied' | 'approval_missing' };

export interface BatchResult {
  readonly written: number;
  readonly failed: number;
  readonly skipped: number;
  readonly remaining: number;
  readonly cancelRequested: boolean;
  readonly thresholdExceeded: boolean;
}

/** EXE-8: the end of the rollback window in epoch milliseconds, or null when none opens. */
export interface RollbackWindow {
  readonly untilMs: number | null;
}

export type BeginRollbackResult =
  | { readonly ok: true; readonly nextBatch: number; readonly itemsPerRun: number }
  | { readonly ok: false; readonly outcome: 'hash_mismatch' | 'executor_error' };

/** Counts of one rollback batch; `remaining` is the rollbackable count after it, `empty` an empty claim. */
export interface RollbackBatchResult extends RollbackCounts {
  readonly remaining: number;
  readonly empty: boolean;
}

/**
 * EXE-12: the stored verification schedule in epoch milliseconds, the wait between looks, the last
 * round in which an item missed (0 when none) and the pending count; `ok: false` when there is
 * nothing to verify (the change-set is no longer executing, or the operation lost `verify_after`).
 */
export type BeginVerificationResult =
  | {
      readonly ok: true;
      readonly firstAtMs: number;
      readonly untilMs: number;
      readonly everyMs: number;
      readonly round: number;
      readonly pending: number;
    }
  | { readonly ok: false };

/** EXE-12: one chunk of a verification round. */
export interface VerifyBatchResult {
  /** Items this chunk confirmed. */
  readonly confirmed: number;
  /** Pending items this round has not looked at yet. */
  readonly left: number;
  /** Pending items in total. */
  readonly pending: number;
  /** A stored cancel request: nothing was read, verification stops (EXE-7). */
  readonly cancelRequested: boolean;
}

export interface ChangesetActivities {
  inspect(changesetId: string): Promise<InspectResult>;
  prepare(changesetId: string): Promise<{ status: ChangeSetStatus }>;
  expire(changesetId: string): Promise<void>;
  beginExecution(changesetId: string, options: { verified: boolean }): Promise<BeginResult>;
  executeBatch(changesetId: string, batchNo: number): Promise<BatchResult>;
  finishExecution(changesetId: string, outcome: FinishOutcome): Promise<{ status: ChangeSetStatus }>;
  openRollbackWindow(changesetId: string): Promise<RollbackWindow>;
  beginRollback(changesetId: string): Promise<BeginRollbackResult>;
  rollbackBatch(changesetId: string, batchNo: number): Promise<RollbackBatchResult>;
  finishRollback(changesetId: string, outcome: RollbackOutcome): Promise<{ status: ChangeSetStatus }>;
  beginVerification(changesetId: string): Promise<BeginVerificationResult>;
  verifyBatch(changesetId: string, round: number): Promise<VerifyBatchResult>;
  finishVerification(changesetId: string, end: VerificationEnd): Promise<void>;
}
