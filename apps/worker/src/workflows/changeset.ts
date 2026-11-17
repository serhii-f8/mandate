/**
 * `changesetWorkflow` (design §4): one workflow per change-set, workflow ID = change-set ID
 * (EXE-1). State-driven: every turn re-reads the truth from PostgreSQL through `inspect`, so a
 * wake lost to a crash, a continue-as-new or a race resolves itself. Input, signal and activity
 * arguments carry identifiers and counters only (EXE-2).
 *
 * Deterministic code (ADR 0006): imports only `@temporalio/workflow` and the contract.
 * A brand-new workflow type with no patches; any change to its command sequence from now on
 * follows the versioning convention (EXE-10).
 */
import {
  ActivityFailure,
  ApplicationFailure,
  condition,
  continueAsNew,
  defineQuery,
  defineSignal,
  proxyActivities,
  setHandler,
  sleep,
  workflowInfo,
} from '@temporalio/workflow';
import {
  PREPARE_MAX_ATTEMPTS,
  PROGRESS_QUERY,
  WAKE_SIGNAL,
  type BatchResult,
  type BeginResult,
  type ChangesetActivities,
  type ChangesetWorkflowInput,
  type ChangesetWorkflowResult,
  type ChangeSetStatus,
  type FinishOutcome,
  type WorkflowProgress,
} from '@aiops/temporal/contract';

/** Statuses in which the workflow waits for a wake (a start or a cancel) until the change-set expires. */
const WAITING: readonly ChangeSetStatus[] = ['prepared', 'pending_approval', 'approved'];

const wakeSignal = defineSignal(WAKE_SIGNAL);
const progressQuery = defineQuery<WorkflowProgress>(PROGRESS_QUERY);

/**
 * How a batch activity that finally failed ends the run. Retries exhausted on a retryable
 * failure (`writer_failed`, a timeout) is the writer's failure (NFR-2). A non-retryable one
 * (`batch_superseded`: another attempt owns the batch; `operation_unavailable`) is not the
 * writer's: the executor could not run the batch.
 */
function batchFailureOutcome(failure: ActivityFailure): FinishOutcome {
  const cause = failure.cause;
  return cause instanceof ApplicationFailure && cause.nonRetryable ? 'executor_error' : 'writer_error';
}

export async function changesetWorkflow(input: ChangesetWorkflowInput): Promise<ChangesetWorkflowResult> {
  const id = input.changesetId;
  // PostgreSQL-only activities that must eventually happen: unlimited attempts.
  const db = proxyActivities<ChangesetActivities>({
    startToCloseTimeout: '30 seconds',
    retry: { maximumInterval: '1 minute' },
  });

  let woken = false;
  let progress: WorkflowProgress = {
    status: 'preparing',
    total: 0,
    ...(input.resume?.counts ?? { done: 0, failed: 0, skipped: 0 }),
  };
  setHandler(wakeSignal, () => {
    woken = true;
  });
  setHandler(progressQuery, () => progress);

  for (;;) {
    // Reset before inspect: a wake that arrives while inspect runs is not lost.
    woken = false;
    const s = await db.inspect(id);
    progress = { status: s.status, total: s.total, done: s.done, failed: s.failed, skipped: s.skipped };
    const slow = proxyActivities<ChangesetActivities>({
      startToCloseTimeout: '15 minutes',
      heartbeatTimeout: '60 seconds',
      retry: {
        initialInterval: s.tuning.retryInitialMs,
        maximumInterval: s.tuning.retryMaxMs,
        maximumAttempts: PREPARE_MAX_ATTEMPTS,
      },
    });

    if (s.status === 'preparing') {
      try {
        await slow.prepare(id);
      } catch (e) {
        if (!(e instanceof ActivityFailure)) throw e;
        // The change-set stays `preparing`; inspect again after a pause.
        await sleep('1 minute');
      }
      continue;
    }

    if (WAITING.includes(s.status)) {
      const left = s.expiresAtMs - Date.now(); // workflow time
      if (left <= 0 || !(await condition(() => woken, left))) await db.expire(id);
      continue;
    }

    if (s.status !== 'executing') return { status: s.status };

    // Execution (EXE-3, EXE-5, EXE-6, EXE-7, EXE-9).
    const batches = proxyActivities<ChangesetActivities>({
      startToCloseTimeout: s.tuning.batchTimeoutMs,
      heartbeatTimeout: s.tuning.batchHeartbeatMs,
      retry: {
        initialInterval: s.tuning.retryInitialMs,
        backoffCoefficient: 2,
        maximumInterval: s.tuning.retryMaxMs,
        maximumAttempts: s.tuning.batchMaxAttempts,
      },
    });
    const finish = async (outcome: FinishOutcome): Promise<ChangesetWorkflowResult> => {
      const r = await db.finishExecution(id, outcome);
      progress = { ...progress, status: r.status };
      return { status: r.status };
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
      // Stop order as the in-memory executor: nothing left, then a stored cancel, then the threshold.
      if (r.remaining === 0) return finish('done');
      // A batch that took nothing while items remain would loop forever: fail closed.
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
