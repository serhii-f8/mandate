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
 * - `changeset-workflow-verify-after-20261122` (EXE-12, ADR 0073) — after the last batch of an
 *   operation with `verify_after` the workflow verifies the written items before it finishes;
 *   checked only when `beginExecution` answered `verifyAfter: true` (absent in every older
 *   history), so an execution without `verify_after` records no marker.
 * - `changeset-workflow-plan-advance-20261122` (EXE-13, ADR 0074) — a plan step that finished
 *   `completed` starts the next approved step (`advancePlan`) before its rollback window opens;
 *   checked only when `beginExecution` answered `inPlan: true` (absent in every older history), so
 *   a change-set outside a plan records no marker.
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
  type BeginVerificationResult,
  type ChangesetActivities,
  type ChangesetWorkflowInput,
  type ChangesetWorkflowResult,
  type ChangeSetStatus,
  type FinishOutcome,
  type RollbackBatchResult,
  type RollbackOutcome,
  type RollbackWindow,
  type VerifyBatchResult,
  type WorkflowProgress,
} from '@mandate/temporal/contract';

/**
 * EXE-8 (ADR 0042): after a finished status the workflow keeps a rollback window open.
 * remove not before 2027-06-23 — earliest deployment 2026-11-18 + 90 d maximum expiry
 * (expire_after_hours ≤ 2160) + 90 d maximum rollback window (rollback_window_hours ≤ 2160)
 * + 30 d assumed longest execution + 7 d namespace retention; recompute from the real deployment date.
 */
const ROLLBACK_PATCH = 'changeset-workflow-rollback-20261118';

/**
 * EXE-12 (ADR 0073): after the last batch the workflow verifies the written items.
 * remove not before 2027-07-04 — earliest deployment 2026-11-22 + 90 d maximum expiry
 * (expire_after_hours ≤ 2160) + 7 d maximum verification (timeout_seconds ≤ 604800) + 90 d maximum
 * rollback window (rollback_window_hours ≤ 2160) + 30 d assumed longest execution + 7 d namespace
 * retention; recompute from the real deployment date.
 */
const VERIFY_PATCH = 'changeset-workflow-verify-after-20261122';

/**
 * EXE-13 (ADR 0074): a completed plan step starts the next approved one.
 * remove not before 2027-07-04 — earliest deployment 2026-11-22 + 90 d maximum expiry
 * (expire_after_hours ≤ 2160) + 7 d maximum verification (timeout_seconds ≤ 604800) + 90 d maximum
 * rollback window (rollback_window_hours ≤ 2160) + 30 d assumed longest execution + 7 d namespace
 * retention; recompute from the real deployment date.
 */
const PLAN_PATCH = 'changeset-workflow-plan-advance-20261122';
/** Looks (verifyBatch calls plus waits) per run before continuing as new; keeps a run's history small. */
const MAX_LOOKS_PER_RUN = 50;

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

/**
 * PostgreSQL-only activities that must eventually happen but may take longer than the `db` proxy allows
 * (`beginVerification` marks every written item): unlimited attempts, no heartbeat (EXE-12, NFR-2).
 * Building a proxy emits no command.
 */
function stateActivities(tuning: ActivityTuning): ChangesetActivities {
  return proxyActivities<ChangesetActivities>({
    startToCloseTimeout: '5 minutes',
    retry: { initialInterval: tuning.retryInitialMs, maximumInterval: tuning.retryMaxMs },
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
    // EXE-13: set from `beginExecution` once it answered; false on the paths that finish before it.
    let inPlan = false;
    const finish = async (outcome: FinishOutcome): Promise<ChangesetWorkflowResult> => {
      const r = await db.finishExecution(id, outcome);
      progress = { ...progress, status: r.status };
      // The result field first: a change-set outside a plan records no marker (old histories never
      // have the field). Bounded retries: a start that cannot be made does not hold up the window.
      if (r.status === 'completed' && inPlan && patched(PLAN_PATCH)) {
        try {
          await slow.advancePlan(id);
        } catch (e) {
          // The plan simply does not advance by itself; the next step stays approved.
          if (!(e instanceof ActivityFailure)) throw e;
        }
      }
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
    inPlan = begin.inPlan === true;
    progress = { status: 'executing', total: begin.total, done: begin.done, failed: begin.failed, skipped: begin.skipped };
    // A run continued during verification (only new histories carry `verificationRound`), or any run
    // of a change-set whose verification began (a reset, a fresh start: `verificationBegun`, absent in
    // older histories), has written everything: a stored cancel stops its verification instead (EXE-7).
    const continuedVerification = input.resume?.verificationRound !== undefined;
    const verifying = continuedVerification || begin.verificationBegun === true;
    if (begin.cancelRequested && !verifying) return finish('cancelled');

    let batchNo = input.resume?.nextBatch ?? 0;
    let thisRun = 0;

    /**
     * EXE-12: the batch loop ended with nothing left. With `verify_after` (behind VERIFY_PATCH),
     * look at the written items until none is pending, the stored deadline passed (tested after every
     * look) or a cancel stops it, waiting on workflow timers between rounds; then finish `done` (the
     * items give the status).
     * Continues as new after MAX_LOOKS_PER_RUN looks; the next run comes back here through
     * `inspect`, `beginExecution` and one empty `executeBatch`, and `beginVerification` answers the
     * stored schedule.
     */
    const finishDone = async (): Promise<ChangesetWorkflowResult> => {
      // The result field first: a run without verify_after records no marker (old histories never
      // have the field). A continued verification run finishes even if the operation lost it since.
      if ((begin.verifyAfter !== true && !verifying) || !patched(VERIFY_PATCH)) return finish('done');
      // `woken` is not reset here: a wake during the batches (a cancel) ends the first wait at once.
      // Unlimited attempts: a failure here must not end a fully written change-set failed, and a
      // verification that never began would let it end completed unverified (NFR-2).
      const v: BeginVerificationResult = await stateActivities(s.tuning).beginVerification(id);
      if (!v.ok) return finish('done');
      const schedule = v;
      let round = input.resume?.verificationRound ?? v.round + 1;
      let looks = 0;
      // Waits until `untilMs` (workflow time) unless a wake (a cancel) starts the next look early.
      const wait = async (untilMs: number): Promise<void> => {
        const left = untilMs - Date.now(); // workflow time
        if (left > 0) await condition(() => woken, left);
      };
      // A continued run already waited; a fresh run with a stored cancel looks at once.
      if (v.pending > 0 && !continuedVerification && !begin.cancelRequested) await wait(v.firstAtMs);
      for (;;) {
        // Reset before the look: a wake that arrives while it runs ends the next wait at once.
        woken = false;
        let r: VerifyBatchResult;
        try {
          r = await batches.verifyBatch(id, round);
        } catch (e) {
          if (!(e instanceof ActivityFailure)) throw e;
          // Infrastructure only (upstream trouble is recorded per item): close what is left as not confirmed.
          await db.finishVerification(id, 'timeout');
          return finish('done');
        }
        looks += 1;
        if (r.cancelRequested) {
          await db.finishVerification(id, 'cancelled');
          return finish('done');
        }
        if (r.pending === 0) {
          await db.finishVerification(id, 'done');
          return finish('done');
        }
        // After every look (workflow time), not only at the end of a round: a round of many chunks
        // must not hold the change-set `executing` long past its deadline. Items never looked at
        // end `verify_timeout`.
        if (Date.now() >= schedule.untilMs) {
          await db.finishVerification(id, 'timeout');
          return finish('done');
        }
        if (r.left === 0) {
          round += 1;
          await wait(Math.min(Date.now() + schedule.everyMs, schedule.untilMs));
          looks += 1;
        }
        if (looks >= MAX_LOOKS_PER_RUN || workflowInfo().continueAsNewSuggested) {
          await continueAsNew<typeof changesetWorkflow>({
            changesetId: id,
            resume: {
              nextBatch: batchNo,
              counts: { done: progress.done, failed: progress.failed, skipped: progress.skipped },
              verified: true,
              verificationRound: round,
            },
          });
        }
      }
    };
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
      if (r.remaining === 0) return finishDone();
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
