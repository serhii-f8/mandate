// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Mandate Authors
/**
 * `changesetWorkflow` (design §4): one workflow per change-set, workflow ID = change-set ID
 * (EXE-1). State-driven: every turn re-reads the truth from PostgreSQL through `inspect`, so a
 * wake lost to a crash, a continue-as-new or a race resolves itself. Input, signal and activity
 * arguments carry identifiers and counters only (EXE-2).
 *
 * Deterministic code (ADR 0006): imports only `@temporalio/workflow` and the contract.
 * Any change to its command sequence follows the versioning convention (EXE-10). Patches:
 * - first patch: `changeset-workflow-rollback-20261118` (EXE-8, ADR 0042) — after a finished status
 *   the workflow keeps a rollback window open and runs a requested rollback; executions that
 *   finished before it keep their old path on replay.
 */
import {
  ActivityFailure,
  ApplicationFailure,
  condition,
  continueAsNew,
  defineQuery,
  defineSignal,
  patched,
  proxyActivities,
  setHandler,
  sleep,
  workflowInfo,
} from '@temporalio/workflow';
import {
  PREPARE_HEARTBEAT_MS,
  PREPARE_MAX_ATTEMPTS,
  PROGRESS_QUERY,
  WAKE_SIGNAL,
  type ActivityTuning,
  type BatchResult,
  type BeginResult,
  type BeginRollbackResult,
  type ChangesetActivities,
  type ChangesetWorkflowInput,
  type ChangesetWorkflowResult,
  type ChangeSetStatus,
  type FinishOutcome,
  type RollbackBatchResult,
  type RollbackOutcome,
  type RollbackWindow,
  type WorkflowProgress,
} from '@mandate/temporal/contract';

/**
 * EXE-8 (ADR 0042): after a finished status the workflow keeps a rollback window open.
 * remove not before 2027-06-23 — earliest deployment 2026-11-18 + 90 d maximum expiry
 * (expire_after_hours ≤ 2160) + 90 d maximum rollback window (rollback_window_hours ≤ 2160)
 * + 30 d assumed longest execution + 7 d namespace retention; recompute from the real deployment date.
 */
const ROLLBACK_PATCH = 'changeset-workflow-rollback-20261118';

/** Statuses in which the workflow waits for a wake (a start or a cancel) until the change-set expires. */
const WAITING: readonly ChangeSetStatus[] = ['prepared', 'pending_approval', 'approved'];

/** Outer-loop turns (inspect and act) per run before continuing as new; keeps a run's history small. */
const MAX_TURNS_PER_RUN = 50;
/** Pause before inspecting a change-set again whose preparation failed on infrastructure. */
const PREPARE_RETRY_PAUSE_MS = 60_000;
/** Pause before calling `expire` again after one that changed nothing. */
const EXPIRE_RETRY_PAUSE_MS = 5_000;

const wakeSignal = defineSignal(WAKE_SIGNAL);
const progressQuery = defineQuery<WorkflowProgress>(PROGRESS_QUERY);

/**
 * How a batch activity that finally failed ends the run. Retries exhausted on a retryable
 * failure (`writer_failed`, a timeout) is the writer's failure (NFR-2). A non-retryable one
 * (`batch_superseded`: another attempt owns the batch; `operation_unavailable`) is not the
 * writer's: the executor could not run the batch.
 */
function batchFailureOutcome(failure: ActivityFailure): 'executor_error' | 'writer_error' {
  const cause = failure.cause;
  return cause instanceof ApplicationFailure && cause.nonRetryable ? 'executor_error' : 'writer_error';
}

/** Retries of the slow PostgreSQL-and-guard activities, from the tuning. */
function slowRetry(tuning: ActivityTuning): { initialInterval: number; maximumInterval: number; maximumAttempts: number } {
  return { initialInterval: tuning.retryInitialMs, maximumInterval: tuning.retryMaxMs, maximumAttempts: PREPARE_MAX_ATTEMPTS };
}

/** The begin activities of execution and rollback. Building a proxy emits no command. */
function slowActivities(tuning: ActivityTuning): ChangesetActivities {
  return proxyActivities<ChangesetActivities>({
    startToCloseTimeout: '15 minutes',
    heartbeatTimeout: PREPARE_HEARTBEAT_MS,
    retry: slowRetry(tuning),
  });
}

/** The batch activities of execution and rollback (EXE-3, NFR-2). Building a proxy emits no command. */
function batchActivities(tuning: ActivityTuning): ChangesetActivities {
  return proxyActivities<ChangesetActivities>({
    startToCloseTimeout: tuning.batchTimeoutMs,
    heartbeatTimeout: tuning.batchHeartbeatMs,
    retry: {
      initialInterval: tuning.retryInitialMs,
      backoffCoefficient: 2,
      maximumInterval: tuning.retryMaxMs,
      maximumAttempts: tuning.batchMaxAttempts,
    },
  });
}

export async function changesetWorkflow(input: ChangesetWorkflowInput): Promise<ChangesetWorkflowResult> {
  const id = input.changesetId;
  // PostgreSQL-only activities that must eventually happen: unlimited attempts.
  const db = proxyActivities<ChangesetActivities>({
    startToCloseTimeout: '30 seconds',
    retry: { maximumInterval: '1 minute' },
  });

  let woken = false;
  // A continued execution run is executing until its first inspect says otherwise.
  let progress: WorkflowProgress = {
    status: input.resume === undefined ? 'preparing' : 'executing',
    total: 0,
    ...(input.resume?.counts ?? { done: 0, failed: 0, skipped: 0 }),
  };
  setHandler(wakeSignal, () => {
    woken = true;
  });
  setHandler(progressQuery, () => progress);

  // Whether the previous turn called `expire` (reset by any turn that does not).
  let expireTried = false;
  let turns = 0;

  /**
   * EXE-8: compensation of a change-set in `rolling_back`, in fenced batches from the next open or
   * unrun batch on; continues as new (input `{ changesetId }`) after `itemsPerRun` items, and the
   * next run comes back here through `inspect`. Ends with `finishRollback`; no second window.
   */
  const compensate = async (tuning: ActivityTuning): Promise<ChangesetWorkflowResult> => {
    const batches = batchActivities(tuning);
    const slow = slowActivities(tuning);
    const finishRollback = async (outcome: RollbackOutcome): Promise<ChangesetWorkflowResult> => {
      const r = await db.finishRollback(id, outcome);
      progress = { ...progress, status: r.status };
      return { status: r.status };
    };

    let begin: BeginRollbackResult;
    try {
      begin = await slow.beginRollback(id);
    } catch (e) {
      if (e instanceof ActivityFailure) return finishRollback('executor_error');
      throw e;
    }
    if (!begin.ok) return finishRollback(begin.outcome);

    let batchNo = begin.nextBatch;
    let thisRun = 0;
    for (;;) {
      let r: RollbackBatchResult;
      try {
        r = await batches.rollbackBatch(id, batchNo);
      } catch (e) {
        if (e instanceof ActivityFailure) return finishRollback(batchFailureOutcome(e));
        throw e;
      }
      // An empty claim: nothing rollbackable is left.
      if (r.empty) return finishRollback('done');
      batchNo += 1;
      const processed = r.restored + r.skipped + r.failed;
      thisRun += processed;
      // As execution: nothing left finishes before the continue-as-new check (ruling F2); a batch
      // that took nothing while items remain would loop forever, so it fails closed.
      if (r.remaining === 0) return finishRollback('done');
      if (processed === 0) return finishRollback('executor_error');
      if (thisRun >= begin.itemsPerRun || workflowInfo().continueAsNewSuggested) {
        await continueAsNew<typeof changesetWorkflow>({ changesetId: id });
      }
    }
  };

  /**
   * A finished status (EXE-8): behind the first patch, opens the rollback window and waits in it
   * for a wake; a stored request runs `compensate`, the window's end closes the workflow. Without
   * the patch marker (an execution that finished before it, on replay) it returns at once.
   */
  const settle = async (status: ChangeSetStatus): Promise<ChangesetWorkflowResult> => {
    if (!patched(ROLLBACK_PATCH)) return { status };
    let w: RollbackWindow;
    try {
      w = await db.openRollbackWindow(id);
    } catch (e) {
      if (e instanceof ActivityFailure) return { status };
      throw e;
    }
    if (w.untilMs === null) return { status };
    for (;;) {
      const left = w.untilMs - Date.now(); // workflow time
      const fired = left <= 0 || !(await condition(() => woken, left));
      // Reset before inspect: a wake that arrives while inspect runs is not lost.
      woken = false;
      const s = await db.inspect(id);
      progress = { status: s.status, total: s.total, done: s.done, failed: s.failed, skipped: s.skipped };
      if (s.status === 'rolling_back') return compensate(s.tuning);
      if (fired) return { status: s.status };
      turns += 1;
      if (turns >= MAX_TURNS_PER_RUN || workflowInfo().continueAsNewSuggested) {
        await continueAsNew<typeof changesetWorkflow>({ changesetId: id });
      }
    }
  };
  for (;;) {
    // Bounded history outside execution: a fresh run re-reads everything from PostgreSQL, so it
    // carries the change-set ID only (execution continues as new with its resume state below).
    if (turns >= MAX_TURNS_PER_RUN || workflowInfo().continueAsNewSuggested) {
      await continueAsNew<typeof changesetWorkflow>({ changesetId: id });
    }
    turns += 1;
    // Reset before inspect: a wake that arrives while inspect runs is not lost.
    woken = false;
    const s = await db.inspect(id);
    progress = { status: s.status, total: s.total, done: s.done, failed: s.failed, skipped: s.skipped };
    // A whole preparation is one attempt: its ceiling comes from the tuning (NFR-7); the heartbeat
    // timeout notices a lost worker.
    const preparing = proxyActivities<ChangesetActivities>({
      startToCloseTimeout: s.tuning.prepareTimeoutMs,
      heartbeatTimeout: PREPARE_HEARTBEAT_MS,
      retry: slowRetry(s.tuning),
    });
    const slow = slowActivities(s.tuning);

    if (s.status === 'preparing' || WAITING.includes(s.status)) {
      const left = s.expiresAtMs - Date.now(); // workflow time
      if (left > 0) {
        expireTried = false;
        if (s.status === 'preparing') {
          try {
            await preparing.prepare(id);
          } catch (e) {
            if (!(e instanceof ActivityFailure)) throw e;
            // Still `preparing` (an infrastructure failure): inspect again after a pause, never past expiry.
            await sleep(Math.min(PREPARE_RETRY_PAUSE_MS, left));
          }
          continue;
        }
        if (await condition(() => woken, left)) continue;
      }
      // Due by workflow time. An earlier expire that changed nothing (the worker's clock is behind
      // workflow time) is retried after a pause instead of in a busy loop.
      if (expireTried) await sleep(EXPIRE_RETRY_PAUSE_MS);
      await db.expire(id);
      expireTried = true;
      continue;
    }

    if (s.status !== 'executing') {
      // `patched` only on a rollback: no pre-patch history ever saw `rolling_back`.
      if (s.status === 'rolling_back' && patched(ROLLBACK_PATCH)) return compensate(s.tuning);
      return settle(s.status);
    }

    // Execution (EXE-3, EXE-5, EXE-6, EXE-7, EXE-9).
    const batches = batchActivities(s.tuning);
    const finish = async (outcome: FinishOutcome): Promise<ChangesetWorkflowResult> => {
      const r = await db.finishExecution(id, outcome);
      progress = { ...progress, status: r.status };
      return settle(r.status);
    };

    // Always runs: it supplies the run size; `verified` skips only the guard on resumed runs.
    let begin: BeginResult;
    try {
      begin = await slow.beginExecution(id, { verified: input.resume?.verified === true });
    } catch (e) {
      if (e instanceof ActivityFailure) return finish('executor_error');
      throw e;
    }
    if (!begin.ok) return finish(begin.outcome);
    progress = { status: 'executing', total: begin.total, done: begin.done, failed: begin.failed, skipped: begin.skipped };
    if (begin.cancelRequested) return finish('cancelled');

    let batchNo = input.resume?.nextBatch ?? 0;
    let thisRun = 0;
    for (;;) {
      let r: BatchResult;
      try {
        r = await batches.executeBatch(id, batchNo);
      } catch (e) {
        if (e instanceof ActivityFailure) return finish(batchFailureOutcome(e));
        throw e;
      }
      batchNo += 1;
      const processed = r.written + r.failed + r.skipped;
      thisRun += processed;
      progress = {
        ...progress,
        done: progress.done + r.written,
        failed: progress.failed + r.failed,
        skipped: progress.skipped + r.skipped,
      };
      // Nothing left finishes done; with work remaining, a stored cancel wins over the threshold, as
      // in the in-memory executor. The empty-claim check between them is this workflow's own (the
      // in-memory executor treats an empty claim as done): a batch that took nothing while items
      // remain would loop forever, so it fails closed, deliberately before a stored cancel.
      if (r.remaining === 0) return finish('done');
      if (processed === 0) return finish('executor_error');
      if (r.cancelRequested) return finish('cancelled');
      if (r.thresholdExceeded) return finish('failure_threshold');
      if (thisRun >= begin.itemsPerRun || workflowInfo().continueAsNewSuggested) {
        await continueAsNew<typeof changesetWorkflow>({
          changesetId: id,
          resume: {
            nextBatch: batchNo,
            counts: { done: progress.done, failed: progress.failed, skipped: progress.skipped },
            verified: true,
          },
        });
      }
    }
  }
}
