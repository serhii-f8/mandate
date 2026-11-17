import { randomUUID } from 'node:crypto';
import {
  CANCELLABLE,
  changesetTransitionEvent,
  isExpiryDue,
  type AuditEventInput,
  type ChangeItemRecord,
  type ChangeSetExecutor,
  type ChangeSetRecord,
  type ChangeSetRepository,
  type ChangeSetStatus,
  type ChangeWriter,
  type ExecutionProgress,
  type ItemOutcome,
  type StartRefusal,
} from '@aiops/core';

export interface InMemoryExecutorDeps {
  readonly repository: ChangeSetRepository;
  readonly writer: ChangeWriter;
  readonly batchSizeOf: (operation: string) => number;
  readonly now?: () => Date;
  readonly newId?: () => string;
}

interface Run {
  cancel?: { actor: string; correlationId: string };
  done: Promise<void>;
}

/**
 * In-process executor (EXE-11): streams pending items in batches, honours cancel after the
 * current batch. Phase 5 runs the same contract against the Temporal implementation.
 */
export class InMemoryExecutor implements ChangeSetExecutor {
  private readonly runs = new Map<string, Run>();
  private readonly repository: ChangeSetRepository;
  private readonly writer: ChangeWriter;
  private readonly batchSizeOf: (operation: string) => number;
  private readonly now: () => Date;
  private readonly newId: () => string;

  constructor(deps: InMemoryExecutorDeps) {
    this.repository = deps.repository;
    this.writer = deps.writer;
    this.batchSizeOf = deps.batchSizeOf;
    this.now = deps.now ?? (() => new Date());
    this.newId = deps.newId ?? randomUUID;
  }

  /** Resolves when the run of the change-set has ended (immediately when none is active). */
  async settled(changesetId: string): Promise<void> {
    await this.runs.get(changesetId)?.done;
  }

  private audit(
    changeset: ChangeSetRecord,
    from: ChangeSetStatus,
    to: ChangeSetStatus,
    actor: string,
    correlationId: string,
  ): AuditEventInput {
    return changesetTransitionEvent({ id: this.newId(), actor, changeset, from, to, correlationId });
  }

  async start(req: {
    changesetId: string;
    expectedHash: string;
    actor: string;
    correlationId: string;
  }): Promise<{ ok: true } | { ok: false; reason: StartRefusal }> {
    let record = await this.repository.get(req.changesetId);
    if (record === undefined) return { ok: false, reason: 'not_found' };
    const now = this.now();
    if (isExpiryDue(record, now)) {
      const expired = await this.repository.transition(
        record.id,
        [record.status],
        'expired',
        this.audit(record, record.status, 'expired', 'system', req.correlationId),
        { expiredBefore: now },
      );
      if (expired !== undefined) return { ok: false, reason: 'expired' };
      // Lost a race with another writer: continue with the normal checks on the current state.
      record = await this.repository.get(req.changesetId);
      if (record === undefined) return { ok: false, reason: 'not_found' };
    }
    if (record.hash === undefined || record.hash !== req.expectedHash) return { ok: false, reason: 'hash_mismatch' };
    const executing = await this.repository.transition(
      record.id,
      ['prepared', 'approved'],
      'executing',
      this.audit(record, record.status, 'executing', req.actor, req.correlationId),
    );
    if (executing === undefined) return { ok: false, reason: 'not_executable' };
    const run: Run = { done: Promise.resolve() };
    // Registered before the run's first await, so a cancel right after start finds it.
    this.runs.set(record.id, run);
    run.done = this.run(executing, run, req.correlationId).finally(() => this.runs.delete(record.id));
    return { ok: true };
  }

  private async run(record: ChangeSetRecord, run: Run, correlationId: string): Promise<void> {
    let writerFailed = false;
    try {
      const size = this.batchSizeOf(record.operation);
      if (!Number.isInteger(size) || size < 1) throw new Error('invalid batch size');
      for (;;) {
        if (run.cancel !== undefined) {
          await this.repository.transition(
            record.id,
            ['executing'],
            'cancelled',
            this.audit(record, 'executing', 'cancelled', run.cancel.actor, run.cancel.correlationId),
          );
          return;
        }
        const items = await this.nextBatch(record.id, size);
        if (items.length === 0) break;
        let outcomes: readonly ItemOutcome[];
        try {
          outcomes = await this.writer.writeBatch({ changeset: record, items });
        } catch {
          writerFailed = true;
          break;
        }
        await this.repository.recordItemOutcomes(record.id, coverBatch(items, outcomes));
      }
      const stats = await this.repository.stats(record.id);
      let to: ChangeSetStatus;
      if (writerFailed || (stats.included > 0 && stats.failed === stats.included)) to = 'failed';
      else if (stats.failed > 0) to = 'completed_with_errors';
      else to = 'completed';
      await this.repository.transition(
        record.id,
        ['executing'],
        to,
        this.audit(record, 'executing', to, 'system', correlationId),
        writerFailed ? { errorCode: 'writer_error' } : undefined,
      );
    } catch {
      // Unexpected error: best effort to leave a terminal state; the run has no caller to report to.
      try {
        await this.repository.transition(
          record.id,
          ['executing'],
          'failed',
          this.audit(record, 'executing', 'failed', 'system', correlationId),
          { errorCode: 'executor_error' },
        );
      } catch {
        // Nothing more can be done; the change-set stays `executing` for inspection.
      }
    }
  }

  /** Next pending items, up to `size`, read in pages of at most 500 (the repository limit). */
  private async nextBatch(changesetId: string, size: number): Promise<ChangeItemRecord[]> {
    const items: ChangeItemRecord[] = [];
    let after: string | undefined;
    while (items.length < size) {
      const page = await this.repository.itemsPage(changesetId, {
        status: 'pending',
        limit: Math.min(500, size - items.length),
        ...(after === undefined ? {} : { after }),
      });
      items.push(...page);
      const last = page[page.length - 1];
      if (last === undefined) break;
      after = last.targetId;
    }
    return items;
  }

  async cancel(req: {
    changesetId: string;
    actor: string;
    correlationId: string;
  }): Promise<{ ok: true; status: ChangeSetStatus } | { ok: false; reason: 'not_found' | 'not_cancellable' }> {
    // The run registry is consulted before any await, so an active run sees the request at once.
    const run = this.runs.get(req.changesetId);
    if (run !== undefined) {
      run.cancel ??= { actor: req.actor, correlationId: req.correlationId };
      await run.done;
      const after = await this.repository.get(req.changesetId);
      return after?.status === 'cancelled'
        ? { ok: true, status: 'cancelled' }
        : { ok: false, reason: 'not_cancellable' };
    }
    const record = await this.repository.get(req.changesetId);
    if (record === undefined) return { ok: false, reason: 'not_found' };
    if (record.status === 'executing') return { ok: false, reason: 'not_cancellable' };
    if (!CANCELLABLE.includes(record.status)) return { ok: false, reason: 'not_cancellable' };
    const cancelled = await this.repository.transition(
      record.id,
      [record.status],
      'cancelled',
      this.audit(record, record.status, 'cancelled', req.actor, req.correlationId),
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

/** Outcomes for exactly the batch: first outcome per target wins, strangers are ignored, gaps fail. */
function coverBatch(items: readonly ChangeItemRecord[], outcomes: readonly ItemOutcome[]): ItemOutcome[] {
  const byTarget = new Map<string, ItemOutcome>();
  for (const o of outcomes) if (!byTarget.has(o.targetId)) byTarget.set(o.targetId, o);
  return items.map((i) => byTarget.get(i.targetId) ?? { targetId: i.targetId, status: 'failed', error: 'no_outcome' });
}

type ScriptedStatus = 'written' | 'failed' | 'skipped';

export interface ScriptedWriterOptions {
  readonly outcomes?: Readonly<Record<string, ScriptedStatus>>;
  /** Zero-based index of the batch whose call throws. */
  readonly throwOnBatch?: number;
  /** Targets for which the writer returns no outcome. */
  readonly dropOutcomes?: readonly string[];
}

/** Writer with per-target outcomes, an optional throwing batch and pausable batches. */
export class ScriptedWriter implements ChangeWriter {
  readonly batches: string[][] = [];
  private readonly outcomes = new Map<string, ScriptedStatus>();
  private throwOnBatch: number | undefined;
  private readonly dropped = new Set<string>();
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

  /** Makes the batch with this zero-based index throw. */
  throwAt(batchIndex: number): void {
    this.throwOnBatch = batchIndex;
  }

  /** Holds the batch with this zero-based index open until `release()`. */
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

  async writeBatch(input: {
    changeset: ChangeSetRecord;
    items: readonly ChangeItemRecord[];
  }): Promise<readonly ItemOutcome[]> {
    const index = this.batches.length;
    this.batches.push(input.items.map((i) => i.targetId));
    const pause = this.pauses.get(index);
    if (pause !== undefined) {
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
