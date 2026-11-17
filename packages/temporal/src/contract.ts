/**
 * The contract between `changesetWorkflow` and its starters and activities (EXE-1, EXE-2).
 * Imported by workflow code through `@aiops/temporal/contract`: it must stay pure, with
 * type-only imports, so the workflow bundle pulls in nothing non-deterministic (EXE-10).
 * Workflow code imports the core types it needs from here, never from `@aiops/core`.
 */
import type { ChangeSetStatus, FinishOutcome } from '@aiops/core';

export type { ChangeSetStatus, FinishOutcome } from '@aiops/core';

export const CHANGESET_WORKFLOW = 'changesetWorkflow';
export const DEFAULT_TASK_QUEUE = 'aiops-operations';
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
    } & ExecutionCounts)
  | { readonly ok: false; readonly outcome: 'hash_mismatch' | 'policy_denied' };

export interface BatchResult {
  readonly written: number;
  readonly failed: number;
  readonly skipped: number;
  readonly remaining: number;
  readonly cancelRequested: boolean;
  readonly thresholdExceeded: boolean;
}

export interface ChangesetActivities {
  inspect(changesetId: string): Promise<InspectResult>;
  prepare(changesetId: string): Promise<{ status: ChangeSetStatus }>;
  expire(changesetId: string): Promise<void>;
  beginExecution(changesetId: string, options: { verified: boolean }): Promise<BeginResult>;
  executeBatch(changesetId: string, batchNo: number): Promise<BatchResult>;
  finishExecution(changesetId: string, outcome: FinishOutcome): Promise<{ status: ChangeSetStatus }>;
}
