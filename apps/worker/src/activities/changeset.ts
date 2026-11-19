/**
 * The change-set activities of `changesetWorkflow` (design §4, §5). Each one reads the truth from
 * PostgreSQL and is safe to retry (NFR-2). The failures they raise themselves carry fixed codes,
 * a writer's error is replaced by `writer_failed`, and the PostgreSQL stores report value-free
 * messages (SEC-3); an unexpected programming error is not rewritten. Activity names and argument
 * shapes are part of workflow history (EXE-10).
 */
import type { LoadedConfiguration } from '@aiops/config';
import {
  BatchFenced,
  changesetBatchEvent,
  changesetRollbackBatchEvent,
  changesetTransitionEvent,
  coverBatch,
  executionTerminal,
  failureThresholdExceeded,
  hashStoredItems,
  PRE_EXECUTION,
  resultNotifications,
  RetryableWriteError,
  rollbackOutcome,
  rollbackTerminal,
  rollbackWindowEnd,
  runPreparation,
  type BatchContext,
  type ChangeSetRecord,
  type ChangeSetRepository,
  type ChangeSetStats,
  type ChangeSetStatus,
  type ChangeWriter,
  type ExecutionGuard,
  type ItemOutcome,
  type RollbackCounts,
  type UpstreamReader,
} from '@aiops/core';
import {
  PREPARE_MAX_ATTEMPTS,
  type ActivityTuning,
  type BatchResult,
  type ChangesetActivities,
  type RollbackBatchResult,
} from '@aiops/temporal';
import { Context } from '@temporalio/activity';
import { ApplicationFailure } from '@temporalio/common';
import { markActivitySpan, rollbackCorrelation } from '../telemetry/span-attributes.js';
import { whileHeartbeating } from './heartbeat.js';
import { executionSettings, type ExecutionSettings } from './settings.js';

export interface ActivityDeps {
  readonly repository: ChangeSetRepository;
  /** The worker's current configuration (it changes on SIGHUP). */
  readonly configuration: () => LoadedConfiguration;
  readonly writerFor: (configuration: LoadedConfiguration, operationId: string) => ChangeWriter;
  /** EXE-8, OPS-3: the reverse writer of an operation; undefined when it cannot be rolled back. */
  readonly rollbackWriterFor: (configuration: LoadedConfiguration, operationId: string) => ChangeWriter | undefined;
  readonly readerFor: (configuration: LoadedConfiguration, correlationId: string) => UpstreamReader;
  readonly guardFor: (configuration: LoadedConfiguration) => ExecutionGuard;
  readonly settingsFor?: (configuration: LoadedConfiguration, operationId: string) => ExecutionSettings;
  readonly tuning: ActivityTuning;
  readonly newId: () => string;
  readonly now: () => Date;
}

const notFound = (): ApplicationFailure => ApplicationFailure.nonRetryable('changeset_not_found');
const superseded = (): ApplicationFailure => ApplicationFailure.nonRetryable('batch_superseded');

function remaining(stats: ChangeSetStats): number {
  return stats.included - stats.written - stats.failed - stats.skipped;
}

/** The same write failure handling for execution and rollback batches (NFR-2, SEC-3). */
function writeFailure(error: unknown, changesetId: string, batchNo: number, message: string): ApplicationFailure {
  // A newer attempt owns the batch: this one stops without recording anything (NFR-2).
  if (error instanceof BatchFenced) return superseded();
  // The class name and fixed code only, never the message (SEC-3).
  Context.current().log.warn(message, {
    changesetId,
    batchNo,
    errorClass: error instanceof Error ? error.constructor.name : typeof error,
    ...(error instanceof RetryableWriteError ? { code: error.code } : {}),
  });
  // Retried by the activity's policy; the writer's message stays out of history (SEC-3).
  return ApplicationFailure.retryable('writer_failed');
}

export function createActivities(deps: ActivityDeps): ChangesetActivities {
  const { repository } = deps;
  const settingsFor = deps.settingsFor ?? executionSettings;

  const load = async (changesetId: string): Promise<ChangeSetRecord> => {
    const changeset = await repository.get(changesetId);
    if (changeset === undefined) throw notFound();
    return changeset;
  };

  /** Fails a change-set still in `preparing` with a fixed code, audited as its requester's preparation. */
  const failPreparation = async (changeset: ChangeSetRecord, errorCode: string): Promise<{ status: ChangeSetStatus }> => {
    await repository.completePreparation(
      changeset.id,
      { status: 'failed', errorCode },
      changesetTransitionEvent({
        id: deps.newId(),
        actor: changeset.requester,
        ...(changeset.clientId === undefined ? {} : { clientId: changeset.clientId }),
        changeset,
        from: 'preparing',
        to: 'failed',
        correlationId: changeset.correlationId,
        details: { errorCode },
      }),
    );
    return { status: (await load(changeset.id)).status };
  };

  /** Counts after a batch, with the cancel request and the threshold over the whole change-set (EXE-5, EXE-7). */
  const batchResult = async (
    changeset: ChangeSetRecord,
    settings: ExecutionSettings,
    counts: { written: number; failed: number; skipped: number },
  ): Promise<BatchResult> => {
    const current = await load(changeset.id);
    const stats = await repository.stats(changeset.id);
    return {
      written: counts.written,
      failed: counts.failed,
      skipped: counts.skipped,
      remaining: remaining(stats),
      cancelRequested: current.cancelRequest !== undefined,
      thresholdExceeded: failureThresholdExceeded(stats, settings.failureThreshold),
    };
  };

  /** Counts of a rollback batch with the rollbackable items left after it (EXE-8). */
  const rollbackResult = async (changesetId: string, counts: RollbackCounts, empty: boolean): Promise<RollbackBatchResult> => ({
    restored: counts.restored,
    skipped: counts.skipped,
    failed: counts.failed,
    remaining: await repository.rollbackableCount(changesetId),
    empty,
  });

  return {
    async inspect(changesetId) {
      const changeset = await load(changesetId);
      markActivitySpan(changeset, 'prepare');
      const stats = await repository.stats(changesetId);
      return {
        status: changeset.status,
        expiresAtMs: changeset.expiresAt.getTime(),
        total: stats.included,
        done: stats.written,
        failed: stats.failed,
        skipped: stats.skipped,
        tuning: deps.tuning,
      };
    },

    async prepare(changesetId) {
      const configuration = deps.configuration();
      const changeset = await load(changesetId);
      markActivitySpan(changeset, 'prepare');
      if (changeset.status !== 'preparing') return { status: changeset.status };
      // The arguments were validated and authorized under the configuration the change-set names (EXE-1).
      if (changeset.configHash !== configuration.hash) {
        if (Context.current().info.attempt < PREPARE_MAX_ATTEMPTS) {
          throw ApplicationFailure.retryable('config_not_current');
        }
        return failPreparation(changeset, 'config_changed');
      }
      const operation = configuration.policy.operations.find((o) => o.id === changeset.operation);
      const manifest = operation?.manifest;
      if (operation === undefined || manifest === undefined) return failPreparation(changeset, 'operation_unavailable');

      const reader = deps.readerFor(configuration, changeset.correlationId);
      // Every read chunk is a sign of life: a stuck preparation is noticed by its heartbeat timeout.
      const heartbeatingReader: UpstreamReader = {
        read: (operationId, args) => {
          Context.current().heartbeat();
          return reader.read(operationId, args);
        },
      };
      // A slow read chunk is kept alive by the timer heartbeat (EXE-4).
      await whileHeartbeating(() =>
        runPreparation(
          { repository, reader: heartbeatingReader, newId: deps.newId, now: deps.now },
          {
            changesetId,
            operation: { ...operation, manifest },
            readFieldsArg: (id) => configuration.policy.operations.find((o) => o.id === id)?.fieldsArg,
            actor: changeset.requester,
            ...(changeset.clientId === undefined ? {} : { clientId: changeset.clientId }),
            correlationId: changeset.correlationId,
          },
        ),
      );
      return { status: (await load(changesetId)).status };
    },

    async expire(changesetId) {
      const changeset = await load(changesetId);
      markActivitySpan(changeset, 'prepare');
      if (!PRE_EXECUTION.includes(changeset.status)) return;
      // CAS from the status read, so the audited `from` is the one replaced; a lost race is a no-op.
      await repository.transition(
        changesetId,
        [changeset.status],
        'expired',
        changesetTransitionEvent({
          id: deps.newId(),
          actor: 'system',
          changeset,
          from: changeset.status,
          to: 'expired',
          correlationId: changeset.correlationId,
        }),
        { expiredBefore: deps.now() },
      );
    },

    async beginExecution(changesetId, options) {
      const configuration = deps.configuration();
      const changeset = await load(changesetId);
      markActivitySpan(changeset, 'execute');
      if (!options.verified) {
        const checked = await deps.guardFor(configuration).check(changeset);
        if (!checked.ok) return { ok: false, outcome: checked.outcome };
      }
      const settings = settingsFor(configuration, changeset.operation);
      const stats = await repository.stats(changesetId);
      return {
        ok: true,
        total: stats.included,
        done: stats.written,
        failed: stats.failed,
        skipped: stats.skipped,
        batchSize: settings.batchSize,
        itemsPerRun: settings.itemsPerRun,
        cancelRequested: changeset.cancelRequest !== undefined,
      };
    },

    async executeBatch(changesetId, batchNo) {
      const configuration = deps.configuration();
      const changeset = await load(changesetId);
      markActivitySpan(changeset, 'execute');
      const settings = settingsFor(configuration, changeset.operation);
      const attempt = Context.current().info.attempt;

      const claim = await repository.claimBatch(changesetId, batchNo, attempt, settings.batchSize);
      if (claim.kind === 'fenced') throw superseded();
      if (claim.kind === 'done') return batchResult(changeset, settings, claim.counts);
      if (claim.kind === 'empty') return batchResult(changeset, settings, { written: 0, failed: 0, skipped: 0 });

      const batch: BatchContext = {
        key: `${changesetId}:${String(batchNo)}`,
        ...(claim.batch.submission === undefined ? {} : { submission: claim.batch.submission }),
        recordSubmission: async (submission) => {
          if (!(await repository.recordSubmission(changesetId, batchNo, attempt, submission))) throw new BatchFenced();
        },
        heartbeat: () => {
          Context.current().heartbeat();
        },
      };
      const writer = deps.writerFor(configuration, changeset.operation);
      let outcomes: readonly ItemOutcome[];
      try {
        // The whole write (read, submit, poll, verify) is kept alive by the timer heartbeat (EXE-4).
        outcomes = await whileHeartbeating(() => writer.writeBatch({ changeset, items: claim.items, batch }));
      } catch (error) {
        throw writeFailure(error, changesetId, batchNo, 'change-set batch write failed');
      }

      const covered = coverBatch(claim.items, outcomes);
      // Claimed items are pending, so these are exactly the counts completeBatch applies.
      const counts = { written: 0, failed: 0, skipped: 0 };
      for (const o of covered) counts[o.status] += 1;
      const completed = await repository.completeBatch(
        changesetId,
        batchNo,
        attempt,
        covered,
        changesetBatchEvent({
          id: deps.newId(),
          changeset,
          batchNo,
          counts,
          correlationId: changeset.executionRequest?.correlationId ?? changeset.correlationId,
        }),
      );
      if (!completed.ok) throw superseded();
      return batchResult(changeset, settings, completed.counts);
    },

    async finishExecution(changesetId, outcome) {
      const changeset = await load(changesetId);
      markActivitySpan(changeset, 'execute');
      const cancel = changeset.cancelRequest;
      // NTF-1: the requester role's result targets, in the transition's transaction; a retry after success inserts nothing (NTF-3).
      const notifications = resultNotifications(deps.configuration().notify, {
        kind: 'execution_finished',
        role: changeset.submission?.role,
        round: changeset.approvalRound,
        step: 0,
      });
      let finished: ChangeSetRecord | undefined;
      if (outcome === 'cancelled' && cancel !== undefined) {
        // The stored request's actor and correlation ID end the run (EXE-7).
        finished = await repository.transition(
          changesetId,
          ['executing'],
          'cancelled',
          changesetTransitionEvent({
            id: deps.newId(),
            actor: cancel.actor,
            changeset,
            from: 'executing',
            to: 'cancelled',
            correlationId: cancel.correlationId,
          }),
          { notifications },
        );
      } else {
        // `cancelled` without a stored request cannot come from the workflow; fail closed as the in-memory executor does.
        const terminal = executionTerminal(
          await repository.stats(changesetId),
          outcome === 'cancelled' ? 'executor_error' : outcome,
        );
        finished = await repository.transition(
          changesetId,
          ['executing'],
          terminal.status,
          changesetTransitionEvent({
            id: deps.newId(),
            actor: 'system',
            changeset,
            from: 'executing',
            to: terminal.status,
            correlationId: changeset.executionRequest?.correlationId ?? changeset.correlationId,
          }),
          { notifications, ...(terminal.errorCode === undefined ? {} : { errorCode: terminal.errorCode }) },
        );
      }
      // A lost compare-and-set (a retry after success, NFR-2) answers the current status.
      return { status: (finished ?? (await load(changesetId))).status };
    },

    async openRollbackWindow(changesetId) {
      const changeset = await load(changesetId);
      markActivitySpan(changeset, 'rollback');
      // Write-once (NFR-2): a window already opened is answered as stored.
      if (changeset.rollbackUntil !== undefined) return { untilMs: changeset.rollbackUntil.getTime() };
      const configuration = deps.configuration();
      const operation = configuration.policy.operations.find((o) => o.id === changeset.operation);
      // An operation gone from the configuration opens no window; this never fails the workflow.
      if (operation?.manifest === undefined) return { untilMs: null };
      const end = rollbackWindowEnd({
        changeset,
        operation,
        rollbackable: await repository.rollbackableCount(changesetId),
        hours: settingsFor(configuration, changeset.operation).rollbackWindowHours,
        now: deps.now(),
      });
      if (end === undefined) return { untilMs: null };
      const stored = await repository.openRollbackWindow(changesetId, end);
      return { untilMs: stored === undefined ? null : stored.getTime() };
    },

    async beginRollback(changesetId) {
      const changeset = await load(changesetId);
      markActivitySpan(changeset, 'rollback');
      if (changeset.status !== 'rolling_back') return { ok: false, outcome: 'executor_error' };
      // CS-4: the stored items still hash to the stored hash; one heartbeat per page keeps a long hash alive.
      const pages: Pick<ChangeSetRepository, 'itemsPage'> = {
        itemsPage: (id, query) => {
          Context.current().heartbeat();
          return repository.itemsPage(id, query);
        },
      };
      const hash = changeset.hash === undefined ? undefined : await hashStoredItems(pages, changeset);
      if (hash === undefined || hash !== changeset.hash) return { ok: false, outcome: 'hash_mismatch' };
      const configuration = deps.configuration();
      // Ruling R13: no rollback writer (strategy none, operation or binding gone) ends the rollback failed.
      if (deps.rollbackWriterFor(configuration, changeset.operation) === undefined) return { ok: false, outcome: 'executor_error' };
      return {
        ok: true,
        nextBatch: await repository.nextRollbackBatch(changesetId),
        itemsPerRun: settingsFor(configuration, changeset.operation).itemsPerRun,
      };
    },

    async rollbackBatch(changesetId, batchNo) {
      const configuration = deps.configuration();
      const changeset = await load(changesetId);
      markActivitySpan(changeset, 'rollback');
      const settings = settingsFor(configuration, changeset.operation);
      const attempt = Context.current().info.attempt;

      const claim = await repository.claimRollbackBatch(changesetId, batchNo, attempt, settings.batchSize);
      if (claim.kind === 'fenced') throw superseded();
      if (claim.kind === 'done') return rollbackResult(changesetId, claim.counts, false);
      if (claim.kind === 'empty') return rollbackResult(changesetId, { restored: 0, skipped: 0, failed: 0 }, true);

      const writer = deps.rollbackWriterFor(configuration, changeset.operation);
      if (writer === undefined) throw ApplicationFailure.nonRetryable('operation_unavailable');
      // Rollback batches are their own sequence: the key never collides with an execution batch's.
      const batch: BatchContext = {
        key: `${changesetId}:rollback:${String(batchNo)}`,
        ...(claim.batch.submission === undefined ? {} : { submission: claim.batch.submission }),
        recordSubmission: async (submission) => {
          if (!(await repository.recordRollbackSubmission(changesetId, batchNo, attempt, submission))) throw new BatchFenced();
        },
        heartbeat: () => {
          Context.current().heartbeat();
        },
      };
      let outcomes: readonly ItemOutcome[];
      try {
        // A recorded submission is resumed by the writer, never resubmitted (EXE-4, NFR-2).
        outcomes = await whileHeartbeating(() => writer.writeBatch({ changeset, items: claim.items, batch }));
      } catch (error) {
        throw writeFailure(error, changesetId, batchNo, 'change-set rollback batch write failed');
      }

      // The writer's returned outcomes decide, never the stored plan (which holds internal outcomes).
      const covered = coverBatch(claim.items, outcomes).map(rollbackOutcome);
      // Claimed items are rollbackable, so these are exactly the counts completeRollbackBatch applies.
      const counts = { restored: 0, skipped: 0, failed: 0 };
      for (const o of covered) counts[o.status] += 1;
      const completed = await repository.completeRollbackBatch(
        changesetId,
        batchNo,
        attempt,
        covered,
        changesetRollbackBatchEvent({ id: deps.newId(), changeset, batchNo, counts, correlationId: rollbackCorrelation(changeset) }),
      );
      if (!completed.ok) throw superseded();
      return rollbackResult(changesetId, completed.counts, false);
    },

    async finishRollback(changesetId, outcome) {
      const changeset = await load(changesetId);
      markActivitySpan(changeset, 'rollback');
      const terminal = rollbackTerminal(outcome);
      // NTF-1: the requester role's result targets, in the transition's transaction; a retry after success inserts nothing (NTF-3).
      const notifications = resultNotifications(deps.configuration().notify, {
        kind: 'rollback_result',
        role: changeset.submission?.role,
        round: changeset.approvalRound,
        step: 0,
      });
      const finished = await repository.transition(
        changesetId,
        ['rolling_back'],
        terminal.status,
        changesetTransitionEvent({
          id: deps.newId(),
          actor: 'system',
          changeset,
          from: 'rolling_back',
          to: terminal.status,
          correlationId: rollbackCorrelation(changeset),
        }),
        { notifications, ...(terminal.status === 'failed' ? { errorCode: terminal.errorCode } : {}) },
      );
      // A lost compare-and-set (a retry after success, NFR-2) answers the current status.
      return { status: (finished ?? (await load(changesetId))).status };
    },
  };
}
