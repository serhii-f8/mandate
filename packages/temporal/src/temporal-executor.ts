import {
  CANCELLABLE,
  changesetTransitionEvent,
  ExecutorUnavailable,
  ROLLBACK_REQUEST_MARGIN_MS,
  rollbackRequestEvents,
  startEventFactory,
  type ChangeSetExecutor,
  type ChangeSetRecord,
  type ChangeSetRepository,
  type ChangeSetStatus,
  type ExecutionProgress,
  type RollbackRequestInput,
  type RollbackRequestOutcome,
  type StartOutcome,
  type StartRequest,
} from '@aiops/core';
import {
  NamespaceNotFoundError,
  ServiceError,
  WorkflowExecutionAlreadyStartedError,
  WorkflowNotFoundError,
  type Client,
} from '@temporalio/client';
import {
  CHANGESET_WORKFLOW,
  PROGRESS_QUERY,
  WAKE_SIGNAL,
  type ChangesetWorkflowInput,
  type WorkflowProgress,
} from './contract.js';

export interface TemporalExecutorDeps {
  readonly client: Client;
  readonly taskQueue: string;
  readonly repository: ChangeSetRepository;
  readonly newId: () => string;
  readonly now: () => Date;
}

type CancelAnswer = { ok: true; status: ChangeSetStatus } | { ok: false; reason: 'not_found' | 'not_cancellable' };

/**
 * Durable executor (EXE-11): the start checks, limits and the move to `executing` happen in one
 * repository transaction (POL-4, POL-6), then the change-set's workflow is woken, or started when
 * absent, and runs the batches (EXE-1, EXE-3). Requests live in PostgreSQL; signals carry no data.
 */
export class TemporalExecutor implements ChangeSetExecutor {
  private readonly client: Client;
  private readonly taskQueue: string;
  private readonly repository: ChangeSetRepository;
  private readonly newId: () => string;
  private readonly now: () => Date;

  constructor(deps: TemporalExecutorDeps) {
    this.client = deps.client;
    this.taskQueue = deps.taskQueue;
    this.repository = deps.repository;
    this.newId = deps.newId;
    this.now = deps.now;
  }

  async start(req: StartRequest): Promise<StartOutcome> {
    // The requester's identity is the execution's request; the actor only starts it (POL-6).
    const identity = req.requester ?? { subject: req.actor, groups: req.groups ?? [], ...(req.clientId === undefined ? {} : { clientId: req.clientId }) };
    const clientId = identity.clientId === undefined ? {} : { clientId: identity.clientId };
    const started = await this.repository.startExecution({
      changesetId: req.changesetId,
      expectedHash: req.expectedHash,
      request: { actor: identity.subject, groups: identity.groups, ...clientId, correlationId: req.correlationId },
      ...(req.limits === undefined ? {} : { limits: req.limits }),
      ...(req.submission === undefined ? {} : { submission: req.submission }),
      now: this.now(),
      event: startEventFactory({
        newId: this.newId,
        actor: req.actor,
        ...(req.clientId === undefined ? {} : { clientId: req.clientId }),
        groups: req.groups ?? [],
        correlationId: req.correlationId,
        ...(req.requester === undefined ? {} : { requester: req.requester }),
      }),
    });
    if (!started.ok) return started;
    const changeset = started.changeset;
    const input: ChangesetWorkflowInput = { changesetId: changeset.id };
    try {
      // Wakes the waiting workflow; starts one when absent. A closed workflow ID is not reused.
      await this.client.workflow.signalWithStart(CHANGESET_WORKFLOW, {
        workflowId: changeset.id,
        taskQueue: this.taskQueue,
        args: [input],
        signal: WAKE_SIGNAL,
        signalArgs: [],
        workflowIdReusePolicy: 'REJECT_DUPLICATE',
      });
    } catch (error) {
      return this.afterFailedSignal(changeset, req.correlationId, error);
    }
    return { ok: true };
  }

  /**
   * A failed signalWithStart is not proof that nothing runs: the server may have accepted it and
   * only the response was lost, so a live run answers ok. A closed workflow ID can never run again
   * (REJECT_DUPLICATE): `workflow_closed`; anything else: `executor_unavailable`. Either way the
   * change-set must not stay `executing`. The compare-and-set loses when a run already moved the
   * change-set on, or already claimed a batch (it may be writing upstream: failing the change-set
   * under it would hide those writes, AUD-1); then the record answers. A live run is woken once
   * more, in case the lost call never delivered the wake.
   */
  private async afterFailedSignal(changeset: ChangeSetRecord, correlationId: string, error: unknown): Promise<StartOutcome> {
    const closed = error instanceof WorkflowExecutionAlreadyStartedError;
    if (!closed && (await this.runIsLive(changeset.id))) {
      await this.wake(changeset.id);
      return { ok: true };
    }
    const errorCode = closed ? 'workflow_closed' : 'executor_unavailable';
    // Fixed codes only, no error text (SEC-3).
    const failed = await this.repository.transition(
      changeset.id,
      ['executing'],
      'failed',
      changesetTransitionEvent({
        id: this.newId(),
        actor: 'system',
        changeset,
        from: 'executing',
        to: 'failed',
        correlationId,
        details: { errorCode },
      }),
      { errorCode, unlessBatches: true },
    );
    if (failed === undefined) {
      // From `executing` the compare-and-set loses only to a run: its terminal transition moved the
      // change-set on, or it claimed a batch. Either way this start ran.
      if ((await this.repository.get(changeset.id)) !== undefined) return { ok: true };
    }
    throw new ExecutorUnavailable();
  }

  /** Whether the change-set's workflow is running; false when Temporal cannot tell. */
  private async runIsLive(changesetId: string): Promise<boolean> {
    try {
      const description = await this.client.workflow.getHandle(changesetId).describe();
      return description.status.name === 'RUNNING';
    } catch {
      return false;
    }
  }

  async cancel(req: { changesetId: string; actor: string; correlationId: string }): Promise<CancelAnswer> {
    const record = await this.repository.get(req.changesetId);
    if (record === undefined) return { ok: false, reason: 'not_found' };
    if (record.status === 'executing') {
      // Stored, not audited on its own: the run's final `executing → cancelled` carries the request (EXE-7).
      const stored = await this.repository.requestCancel(record.id, {
        actor: req.actor,
        correlationId: req.correlationId,
        requestedAt: this.now(),
      });
      if (!stored.ok) return { ok: false, reason: 'not_cancellable' };
      await this.wake(record.id);
      return { ok: true, status: 'executing' };
    }
    if (!CANCELLABLE.includes(record.status)) return { ok: false, reason: 'not_cancellable' };
    const cancelled = await this.repository.transition(
      record.id,
      [record.status],
      'cancelled',
      changesetTransitionEvent({
        id: this.newId(),
        actor: req.actor,
        changeset: record,
        from: record.status,
        to: 'cancelled',
        correlationId: req.correlationId,
      }),
    );
    if (cancelled === undefined) return { ok: false, reason: 'not_cancellable' };
    // The waiting workflow re-reads the status and ends; without it, it would end at expiry.
    await this.wake(record.id);
    return { ok: true, status: 'cancelled' };
  }

  /**
   * EXE-8: describe the run first, so an unreachable Temporal changes nothing (ExecutorUnavailable); a run
   * that is not running has no window left to wake. Then the request and its audit rows in one compare-
   * and-set transaction, which checks the window again on the database clock (SEC-8, AUD-1), and a
   * data-free wake. A signal that finds the run closed (it closed after describe) fails the rollback
   * instead of leaving it `rolling_back` with no run to do it.
   */
  async requestRollback(req: RollbackRequestInput): Promise<RollbackRequestOutcome> {
    const record = await this.repository.get(req.changesetId);
    if (record === undefined) return { ok: false, reason: 'not_found' };
    const handle = this.client.workflow.getHandle(record.id);
    try {
      const description = await handle.describe();
      if (description.status.name !== 'RUNNING') return { ok: false, reason: 'not_rollbackable', detail: 'window_closed' };
    } catch (error) {
      // NOT_FOUND from the server: no run was ever started, or a closed run was deleted after retention.
      if (error instanceof WorkflowNotFoundError) return { ok: false, reason: 'not_rollbackable', detail: 'window_closed' };
      // The client's answers for an unreachable or misconfigured Temporal (rethrowGrpcError, client 1.25).
      if (error instanceof ServiceError || error instanceof NamespaceNotFoundError) throw new ExecutorUnavailable();
      throw error;
    }
    const request = {
      actor: req.actor,
      ...(req.clientId === undefined ? {} : { clientId: req.clientId }),
      correlationId: req.correlationId,
      requestedAt: this.now(),
    };
    const stored = await this.repository.requestRollback({
      changesetId: record.id,
      request,
      marginMs: ROLLBACK_REQUEST_MARGIN_MS,
      audit: rollbackRequestEvents({ newId: this.newId, changeset: record, request, channel: 'page', count: req.count }),
    });
    if (!stored.ok) {
      return stored.reason === 'not_found' ? { ok: false, reason: 'not_found' } : { ok: false, reason: 'not_rollbackable', detail: stored.reason };
    }
    try {
      await handle.signal(WAKE_SIGNAL);
    } catch (error) {
      // Temporal unreachable now: the stored request stands, and the run's next look after its window
      // timer finds it.
      if (error instanceof ServiceError) return { ok: true, status: 'rolling_back' };
      if (!(error instanceof WorkflowNotFoundError)) throw error;
      const errorCode = 'rollback_workflow_closed';
      const failed = await this.repository.transition(
        record.id,
        ['rolling_back'],
        'failed',
        changesetTransitionEvent({
          id: this.newId(),
          actor: 'system',
          changeset: stored.changeset,
          from: 'rolling_back',
          to: 'failed',
          correlationId: req.correlationId,
          details: { errorCode },
        }),
        { errorCode },
      );
      if (failed !== undefined) return { ok: true, status: 'failed' };
      // A lost compare-and-set: the run took the request on and finished the rollback itself before it closed.
      const current = await this.repository.get(record.id);
      return { ok: true, status: current?.status === 'failed' ? 'failed' : 'rolling_back' };
    }
    return { ok: true, status: 'rolling_back' };
  }

  async progress(changesetId: string): Promise<ExecutionProgress | undefined> {
    const record = await this.repository.get(changesetId);
    if (record === undefined) return undefined;
    if (record.status === 'executing') {
      try {
        const p = await this.client.workflow.getHandle(changesetId).query<WorkflowProgress>(PROGRESS_QUERY);
        return { status: p.status, total: p.total, done: p.done, failed: p.failed, skipped: p.skipped };
      } catch {
        // No workflow or worker answering: the stored counts are the truth, if not the latest.
      }
    }
    return storedProgress(record);
  }

  /** Resolves when the change-set's workflow has closed (immediately when it has none). */
  async settled(changesetId: string): Promise<void> {
    try {
      await this.client.workflow.getHandle(changesetId).result();
    } catch (error) {
      if (error instanceof WorkflowNotFoundError) return;
      throw error;
    }
  }

  /** Best effort: the workflow also re-reads the status at its next turn or at expiry. */
  async wake(changesetId: string): Promise<void> {
    try {
      await this.client.workflow.getHandle(changesetId).signal(WAKE_SIGNAL);
    } catch {
      // No workflow (never started or closed) or Temporal unreachable: the stored state decides.
    }
  }
}

function storedProgress(record: ChangeSetRecord): ExecutionProgress {
  return {
    status: record.status,
    total: record.stats.included,
    done: record.stats.written,
    failed: record.stats.failed,
    skipped: record.stats.skipped,
  };
}
