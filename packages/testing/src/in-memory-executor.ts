import { randomUUID } from 'node:crypto';
import {
  BatchFenced,
  CANCELLABLE,
  changesetBatchEvent,
  changesetTransitionEvent,
  coverBatch,
  executionTerminal,
  failureThresholdExceeded,
  startEventFactory,
  type BatchContext,
  type ChangeItemRecord,
  type ChangeSetExecutor,
  type ChangeSetRecord,
  type ChangeSetRepository,
  type ChangeSetStatus,
  type ChangeWriter,
  type ExecutionProgress,
  type FinishOutcome,
  type ItemOutcome,
  type StartOutcome,
  type StartRequest,
} from '@aiops/core';

export interface InMemoryExecutorDeps {
  readonly repository: ChangeSetRepository;
  readonly writer: ChangeWriter;
  readonly batchSizeOf: (operation: string) => number;
  /** Stop remaining batches when failed / processed exceeds this (EXE-5). Default 0.5. */
  readonly failureThreshold?: number;
  readonly now?: () => Date;
  readonly newId?: () => string;
}

/** The in-memory executor runs each batch once, so every claim and write uses attempt 1. */
const ATTEMPT = 1;

/**
 * In-process executor (EXE-11) on the same repository port as the durable one: the start checks
 * and limits run in `startExecution` (POL-4, POL-6), batches are claimed and completed through the
 * fenced batch rows (EXE-3), a stored cancel request ends the run after the current batch (EXE-7),
 * and the failure threshold stops remaining batches (EXE-5).
 */
export class InMemoryExecutor implements ChangeSetExecutor {
  private readonly runs = new Map<string, Promise<void>>();
  private readonly repository: ChangeSetRepository;
  private readonly writer: ChangeWriter;
  private readonly batchSizeOf: (operation: string) => number;
  private readonly failureThreshold: number;
  private readonly now: () => Date;
  private readonly newId: () => string;

  constructor(deps: InMemoryExecutorDeps) {
    this.repository = deps.repository;
    this.writer = deps.writer;
    this.batchSizeOf = deps.batchSizeOf;
    this.failureThreshold = deps.failureThreshold ?? 0.5;
    this.now = deps.now ?? (() => new Date());
    this.newId = deps.newId ?? randomUUID;
  }

  /** Resolves when the run of the change-set has ended (immediately when none is active). */
  async settled(changesetId: string): Promise<void> {
    await this.runs.get(changesetId);
  }

  async start(req: StartRequest): Promise<StartOutcome> {
    const groups = req.groups ?? [];
    const clientId = req.clientId === undefined ? {} : { clientId: req.clientId };
    const started = await this.repository.startExecution({
      changesetId: req.changesetId,
      expectedHash: req.expectedHash,
      request: { actor: req.actor, groups, ...clientId, correlationId: req.correlationId },
      ...(req.limits === undefined ? {} : { limits: req.limits }),
      now: this.now(),
      event: startEventFactory({
        newId: this.newId,
        actor: req.actor,
        ...clientId,
        groups,
        correlationId: req.correlationId,
      }),
    });
    if (!started.ok) return started;
    const id = started.changeset.id;
    // Registered before the run's first await, so `settled` right after start finds it.
    this.runs.set(
      id,
      this.run(started.changeset, req.correlationId).finally(() => this.runs.delete(id)),
    );
    return { ok: true };
  }

  private async run(changeset: ChangeSetRecord, correlationId: string): Promise<void> {
    try {
      const size = this.batchSizeOf(changeset.operation);
      if (!Number.isInteger(size) || size < 1) throw new Error('invalid batch size');
      const outcome = await this.runBatches(changeset.id, size, correlationId);
      await this.finish(changeset.id, outcome, correlationId);
    } catch {
      // Unexpected error: best effort to leave a terminal state; the run has no caller to report to.
      try {
        await this.finish(changeset.id, 'executor_error', correlationId);
      } catch {
        // Nothing more can be done; the change-set stays `executing` for inspection.
      }
    }
  }

  /** Runs batches until none is left, a cancel is stored or the failure threshold is exceeded. */
  private async runBatches(changesetId: string, size: number, correlationId: string): Promise<FinishOutcome> {
    for (let batchNo = 0; ; batchNo++) {
      const current = await this.repository.get(changesetId);
      if (current === undefined) throw new Error('change-set vanished');
      if (current.cancelRequest !== undefined) return 'cancelled';
      if (failureThresholdExceeded(current.stats, this.failureThreshold)) return 'failure_threshold';
      const claim = await this.repository.claimBatch(changesetId, batchNo, ATTEMPT, size);
      if (claim.kind === 'empty') return 'done';
      if (claim.kind === 'done') continue;
      if (claim.kind === 'fenced') throw new Error('batch fenced');
      const batch: BatchContext = {
        key: `${changesetId}:${String(batchNo)}`,
        ...(claim.batch.submission === undefined ? {} : { submission: claim.batch.submission }),
        recordSubmission: async (submission) => {
          if (!(await this.repository.recordSubmission(changesetId, batchNo, ATTEMPT, submission))) {
            throw new BatchFenced();
          }
        },
        heartbeat: () => undefined,
      };
      let outcomes: readonly ItemOutcome[];
      try {
        outcomes = await this.writer.writeBatch({ changeset: current, items: claim.items, batch });
      } catch {
        return 'writer_error';
      }
      const covered = coverBatch(claim.items, outcomes);
      // Claimed items are pending, so these are exactly the counts completeBatch applies.
      const counts = { written: 0, failed: 0, skipped: 0 };
      for (const o of covered) counts[o.status] += 1;
      const completed = await this.repository.completeBatch(
        changesetId,
        batchNo,
        ATTEMPT,
        covered,
        changesetBatchEvent({ id: this.newId(), changeset: current, batchNo, counts, correlationId }),
      );
      if (!completed.ok) throw new Error('batch fenced');
    }
  }

  /** Terminal transition (EXE-6); a cancel carries the stored request's actor and correlation ID (EXE-7). */
  private async finish(changesetId: string, outcome: FinishOutcome, correlationId: string): Promise<void> {
    const record = await this.repository.get(changesetId);
    if (record === undefined) return;
    if (outcome === 'cancelled' && record.cancelRequest !== undefined) {
      const { actor, correlationId: cancelCorrelation } = record.cancelRequest;
      await this.repository.transition(
        changesetId,
        ['executing'],
        'cancelled',
        this.transitionEvent(record, 'cancelled', actor, cancelCorrelation),
      );
      return;
    }
    // `cancelled` without a stored request cannot happen (runBatches returns it only with one); fail closed.
    const terminal = executionTerminal(
      await this.repository.stats(changesetId),
      outcome === 'cancelled' ? 'executor_error' : outcome,
    );
    await this.repository.transition(
      changesetId,
      ['executing'],
      terminal.status,
      this.transitionEvent(record, terminal.status, 'system', correlationId),
      terminal.errorCode === undefined ? undefined : { errorCode: terminal.errorCode },
    );
  }

  private transitionEvent(changeset: ChangeSetRecord, to: ChangeSetStatus, actor: string, correlationId: string) {
    return changesetTransitionEvent({ id: this.newId(), actor, changeset, from: 'executing', to, correlationId });
  }

  async cancel(req: {
    changesetId: string;
    actor: string;
    correlationId: string;
  }): Promise<{ ok: true; status: ChangeSetStatus } | { ok: false; reason: 'not_found' | 'not_cancellable' }> {
    const record = await this.repository.get(req.changesetId);
    if (record === undefined) return { ok: false, reason: 'not_found' };
    if (record.status === 'executing') {
      // Stored, not audited on its own: the run's final `executing → cancelled` carries the request (EXE-7).
      const stored = await this.repository.requestCancel(record.id, {
        actor: req.actor,
        correlationId: req.correlationId,
        requestedAt: this.now(),
      });
      return stored.ok ? { ok: true, status: 'executing' } : { ok: false, reason: 'not_cancellable' };
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
    return cancelled === undefined ? { ok: false, reason: 'not_cancellable' } : { ok: true, status: 'cancelled' };
  }

  async progress(changesetId: string): Promise<ExecutionProgress | undefined> {
    const record = await this.repository.get(changesetId);
    if (record === undefined) return undefined;
    return {
      status: record.status,
      total: record.stats.included,
      done: record.stats.written,
      failed: record.stats.failed,
      skipped: record.stats.skipped,
    };
  }
}

type ScriptedStatus = 'written' | 'failed' | 'skipped';

export interface ScriptedWriterOptions {
  readonly outcomes?: Readonly<Record<string, ScriptedStatus>>;
  /** Zero-based index of the batch (by distinct first target) whose every call throws. */
  readonly throwOnBatch?: number;
  /** Targets for which the writer returns no outcome. */
  readonly dropOutcomes?: readonly string[];
}

/**
 * Writer with per-target outcomes, a throwing batch and pausable batches. A batch is identified by
 * its first target, so a retry of the same batch is the same batch (NFR-2): `throwAt` fails every
 * attempt, `pauseAt` holds only the first call, and a call that resumes a recorded submission polls
 * only: it is not counted in `batches` and records nothing.
 */
export class ScriptedWriter implements ChangeWriter {
  /** Target IDs of every batch submitted (resumed calls excluded). */
  readonly batches: string[][] = [];
  /** Every invocation, resumed calls and throwing calls included. */
  calls = 0;
  private readonly outcomes = new Map<string, ScriptedStatus>();
  private throwOnBatch: number | undefined;
  private readonly dropped = new Set<string>();
  /** Distinct first targets in the order seen; the index is the batch index. */
  private readonly firstTargets: string[] = [];
  /** Appended to every batch's outcomes (to test that strangers and duplicates are ignored). */
  extraOutcomes: ItemOutcome[] = [];
  private readonly pauses = new Map<number, { reached: () => void; gate: Promise<void> }>();

  constructor(options: ScriptedWriterOptions = {}) {
    for (const [target, status] of Object.entries(options.outcomes ?? {})) this.outcomes.set(target, status);
    this.throwOnBatch = options.throwOnBatch;
    for (const target of options.dropOutcomes ?? []) this.dropped.add(target);
  }

  /** Makes the writer return no outcome for this target. */
  dropOutcome(targetId: string): void {
    this.dropped.add(targetId);
  }

  setOutcome(targetId: string, status: ScriptedStatus): void {
    this.outcomes.set(targetId, status);
  }

  /** Makes every call of the batch with this zero-based index throw. */
  throwAt(batchIndex: number): void {
    this.throwOnBatch = batchIndex;
  }

  /** Holds the next call of the batch with this zero-based index open until `release()`. */
  pauseAt(batchIndex: number): { reached: Promise<void>; release(): void } {
    let release: () => void = () => undefined; // replaced synchronously by the Promise executor
    let reach: () => void = () => undefined; // replaced synchronously by the Promise executor
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const reached = new Promise<void>((resolve) => {
      reach = resolve;
    });
    this.pauses.set(batchIndex, { reached: reach, gate });
    return { reached, release };
  }

  private batchIndex(items: readonly ChangeItemRecord[]): number {
    const first = items[0]?.targetId ?? '';
    const known = this.firstTargets.indexOf(first);
    if (known >= 0) return known;
    this.firstTargets.push(first);
    return this.firstTargets.length - 1;
  }

  async writeBatch(input: {
    changeset: ChangeSetRecord;
    items: readonly ChangeItemRecord[];
    batch: BatchContext;
  }): Promise<readonly ItemOutcome[]> {
    this.calls += 1;
    const index = this.batchIndex(input.items);
    if (input.batch.submission === undefined) {
      this.batches.push(input.items.map((i) => i.targetId));
      // A BatchFenced from here propagates: a superseded attempt stops before writing anything more.
      await input.batch.recordSubmission({
        upstreamBatchId: input.batch.key,
        plan: input.items.map((i) => ({ targetId: i.targetId, action: 'write' as const })),
      });
    }
    const pause = this.pauses.get(index);
    if (pause !== undefined) {
      this.pauses.delete(index);
      pause.reached();
      await pause.gate;
    }
    if (this.throwOnBatch === index) throw new Error('scripted writer failure');
    const own = input.items
      .filter((i) => !this.dropped.has(i.targetId))
      .map((i): ItemOutcome => ({ targetId: i.targetId, status: this.outcomes.get(i.targetId) ?? 'written' }));
    return [...own, ...this.extraOutcomes];
  }
}
