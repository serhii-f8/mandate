import { randomUUID } from 'node:crypto';
import type { LoadedConfiguration } from '@aiops/config';
import {
  changesetTransitionEvent,
  type BatchContext,
  type ChangeItemRecord,
  type ChangeSetRecord,
  type ChangeWriter,
  type ExecutionGuard,
  type ItemOutcome,
  type ReadPage,
  type RollbackStrategy,
  type UpstreamReader,
} from '@aiops/core';
import { PostgresChangeSetRepository, PostgresNotificationOutbox } from '@aiops/db';
import { DEFAULT_TUNING, PREPARE_MAX_ATTEMPTS, type ChangesetActivities } from '@aiops/temporal';
import { allowAllGuard, ScriptedWriter } from '@aiops/testing';
import { MockActivityEnvironment } from '@temporalio/testing';
import { DefaultLogger } from '@temporalio/worker';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createActivities, type ActivityDeps } from '../../src/activities/index.js';
import { createPrepared, createPreparing } from '../support/changesets.js';
import { READ_OPERATION, testConfiguration, WRITE_OPERATION } from '../support/configuration.js';
import { auditEventsOf, startTestPostgres, type TestPostgres } from '../support/postgres.js';

let postgres: TestPostgres;
let repository: PostgresChangeSetRepository;
let configuration: LoadedConfiguration;

beforeAll(async () => {
  postgres = await startTestPostgres();
  repository = new PostgresChangeSetRepository(postgres.database.db);
  configuration = await testConfiguration();
});

afterAll(async () => {
  await postgres.stop();
});

/** Reads answer every requested SKU with brand `acme`. */
class CatalogReader implements UpstreamReader {
  readonly calls: { operationId: string; args: Readonly<Record<string, unknown>> }[] = [];
  read(operationId: string, args: Readonly<Record<string, unknown>>): Promise<ReadPage> {
    this.calls.push({ operationId, args });
    const skus = Array.isArray(args.skus) ? (args.skus as string[]) : [];
    return Promise.resolve({ ok: true, items: skus.map((sku) => ({ sku, brand: 'acme', name: `old ${sku}` })), truncated: false });
  }
}

/** Writes every item; its first call waits at a gate before recording the submission. */
class GatedWriter implements ChangeWriter {
  calls = 0;
  private open: () => void = () => undefined; // replaced synchronously by the Promise executor
  private reach: () => void = () => undefined; // replaced synchronously by the Promise executor
  private readonly gate = new Promise<void>((resolve) => {
    this.open = resolve;
  });
  readonly reached = new Promise<void>((resolve) => {
    this.reach = resolve;
  });

  release(): void {
    this.open();
  }

  async writeBatch(input: { items: readonly ChangeItemRecord[]; batch: BatchContext }): Promise<readonly ItemOutcome[]> {
    this.calls += 1;
    if (this.calls === 1) {
      this.reach();
      await this.gate;
    }
    await input.batch.recordSubmission({
      upstreamBatchId: input.batch.key,
      plan: input.items.map((i) => ({ targetId: i.targetId, action: 'write' as const })),
    });
    return input.items.map((i): ItemOutcome => ({ targetId: i.targetId, status: 'written' }));
  }
}

interface Fixture {
  readonly writer?: ChangeWriter;
  /** Default: a `ScriptedWriter` for every operation. */
  readonly rollbackWriterFor?: ActivityDeps['rollbackWriterFor'];
  readonly reader?: UpstreamReader;
  readonly guard?: ExecutionGuard;
  readonly configuration?: LoadedConfiguration;
  readonly now?: () => Date;
}

function activities(fixture: Fixture = {}): ChangesetActivities {
  return createActivities({
    repository,
    configuration: () => fixture.configuration ?? configuration,
    writerFor: () => fixture.writer ?? new ScriptedWriter(),
    rollbackWriterFor: fixture.rollbackWriterFor ?? (() => new ScriptedWriter()),
    readerFor: () => fixture.reader ?? new CatalogReader(),
    guardFor: () => fixture.guard ?? allowAllGuard,
    tuning: DEFAULT_TUNING,
    newId: randomUUID,
    now: fixture.now ?? (() => new Date()),
  });
}

/** An activity environment of the given Temporal attempt; its expected failures are not logged. */
function environment(n: number): MockActivityEnvironment {
  return new MockActivityEnvironment({ attempt: n }, { logger: new DefaultLogger('ERROR') });
}

/** Runs one activity call as the given Temporal attempt. */
function attempt<R>(n: number, fn: () => Promise<R>): Promise<R> {
  return environment(n).run(fn);
}

async function itemStatuses(changesetId: string): Promise<Record<string, string>> {
  const page = await repository.itemsPage(changesetId, { limit: 100 });
  return Object.fromEntries(page.map((i) => [i.targetId, i.status]));
}

describe('change-set activities', () => {
  it('EXE-1 inspect reports status, counts and tuning; an unknown ID is not retried', async () => {
    const cs = await createPrepared(repository, 3);
    const a = activities();
    await expect(attempt(1, () => a.inspect(cs.id))).resolves.toEqual({
      status: 'prepared',
      expiresAtMs: cs.expiresAt.getTime(),
      total: 3,
      done: 0,
      failed: 0,
      skipped: 0,
      tuning: DEFAULT_TUNING,
    });
    await expect(attempt(1, () => a.inspect(randomUUID()))).rejects.toMatchObject({
      message: 'changeset_not_found',
      nonRetryable: true,
    });
  });

  it('EXE-3 executeBatch writes the next batch, records outcomes and returns remaining', async () => {
    const cs = await createPrepared(repository, 3, { execute: {} });
    const writer = new ScriptedWriter();
    const a = activities({ writer });
    await expect(attempt(1, () => a.executeBatch(cs.id, 0))).resolves.toEqual({
      written: 2,
      failed: 0,
      skipped: 0,
      remaining: 1,
      cancelRequested: false,
      thresholdExceeded: false,
    });
    expect(writer.batches).toEqual([['t-0001', 't-0002']]);
    expect(await itemStatuses(cs.id)).toEqual({ 't-0001': 'written', 't-0002': 'written', 't-0003': 'pending' });

    await expect(attempt(1, () => a.executeBatch(cs.id, 1))).resolves.toMatchObject({ written: 1, remaining: 0 });
    expect(writer.batches).toEqual([['t-0001', 't-0002'], ['t-0003']]);
    // Nothing left to claim: zero counts.
    await expect(attempt(1, () => a.executeBatch(cs.id, 2))).resolves.toMatchObject({ written: 0, failed: 0, skipped: 0, remaining: 0 });
  });

  it('NFR-2 a retry of a recorded batch returns its stored counts and calls the writer no more', async () => {
    const cs = await createPrepared(repository, 3, { execute: {} });
    const writer = new ScriptedWriter({ outcomes: { 't-0002': 'skipped' } });
    const a = activities({ writer });
    const first = await attempt(1, () => a.executeBatch(cs.id, 0));
    const calls = writer.calls;
    const retried = await attempt(2, () => a.executeBatch(cs.id, 0));
    expect(retried).toEqual(first);
    expect(retried).toMatchObject({ written: 1, skipped: 1, remaining: 1 });
    expect(writer.calls).toBe(calls);
  });

  it('NFR-2 EXE-3 a superseded attempt records nothing', async () => {
    const cs = await createPrepared(repository, 2, { execute: {} });
    const writer = new ScriptedWriter();
    const a = activities({ writer });
    const paused = writer.pauseAt(0);
    const first = attempt(1, () => a.executeBatch(cs.id, 0));
    await paused.reached;
    // Attempt 2 takes the batch over, resumes the recorded submission and records its outcomes.
    await expect(attempt(2, () => a.executeBatch(cs.id, 0))).resolves.toMatchObject({ written: 2, remaining: 0 });
    // Attempt 1 would now report a failure; its completion is fenced off.
    writer.setOutcome('t-0001', 'failed');
    paused.release();
    await expect(first).rejects.toMatchObject({ message: 'batch_superseded', nonRetryable: true });
    expect(await itemStatuses(cs.id)).toEqual({ 't-0001': 'written', 't-0002': 'written' });
    expect((await repository.stats(cs.id)).failed).toBe(0);
  });

  it('AUD-1 executeBatch audits changeset.batch with the execution request correlation ID', async () => {
    const cs = await createPrepared(repository, 3, { correlationId: 'corr-prepare', execute: { correlationId: 'corr-exec-request' } });
    const a = activities({ writer: new ScriptedWriter({ outcomes: { 't-0002': 'failed' } }) });
    await attempt(1, () => a.executeBatch(cs.id, 0));
    const batches = (await auditEventsOf(postgres.database, cs.id)).filter((e) => e.action === 'changeset.batch');
    expect(batches).toEqual([
      {
        actor: 'system',
        clientId: null,
        action: 'changeset.batch',
        decision: null,
        outcome: 'ok',
        correlationId: 'corr-exec-request',
        changesetId: cs.id,
        details: { batchNo: 0, written: 1, failed: 1, skipped: 0, operation: cs.operation },
      },
    ]);
  });

  it('EXE-5 executeBatch reports thresholdExceeded from cumulative stats', async () => {
    // Threshold 0.5 (test configuration), batch size 2.
    const cs = await createPrepared(repository, 5, { execute: {} });
    const writer = new ScriptedWriter({ outcomes: { 't-0003': 'failed', 't-0004': 'failed', 't-0005': 'failed' } });
    const a = activities({ writer });
    await expect(attempt(1, () => a.executeBatch(cs.id, 0))).resolves.toMatchObject({ written: 2, thresholdExceeded: false });
    // This batch alone failed entirely, but 2 failed of 4 processed is not above 0.5.
    await expect(attempt(1, () => a.executeBatch(cs.id, 1))).resolves.toMatchObject({ failed: 2, thresholdExceeded: false });
    // 3 failed of 5 processed is.
    await expect(attempt(1, () => a.executeBatch(cs.id, 2))).resolves.toMatchObject({ failed: 1, remaining: 0, thresholdExceeded: true });
  });

  it('EXE-7 executeBatch reports a stored cancel request', async () => {
    const cs = await createPrepared(repository, 5, { execute: {} });
    const a = activities();
    await expect(attempt(1, () => a.executeBatch(cs.id, 0))).resolves.toMatchObject({ cancelRequested: false });
    const stored = await repository.requestCancel(cs.id, { actor: 'bob', correlationId: 'corr-cancel', requestedAt: new Date() });
    expect(stored.ok).toBe(true);
    await expect(attempt(1, () => a.executeBatch(cs.id, 1))).resolves.toMatchObject({ written: 2, remaining: 1, cancelRequested: true });
  });

  it('EXE-1 prepare throws a retryable failure on a configuration hash mismatch and fails config_changed on attempt 5', async () => {
    const cs = await createPreparing(repository, { configHash: 'an-older-configuration' });
    const reader = new CatalogReader();
    const a = activities({ reader });
    for (let n = 1; n < PREPARE_MAX_ATTEMPTS; n++) {
      await expect(attempt(n, () => a.prepare(cs.id))).rejects.toMatchObject({ message: 'config_not_current', nonRetryable: false });
      expect((await repository.get(cs.id))?.status).toBe('preparing');
    }
    await expect(attempt(PREPARE_MAX_ATTEMPTS, () => a.prepare(cs.id))).resolves.toEqual({ status: 'failed' });
    expect(await repository.get(cs.id)).toMatchObject({ status: 'failed', errorCode: 'config_changed' });
    expect(reader.calls).toEqual([]);
    const failed = (await auditEventsOf(postgres.database, cs.id)).at(-1);
    expect(failed).toMatchObject({ action: 'changeset.transition', actor: cs.requester, details: { from: 'preparing', to: 'failed', errorCode: 'config_changed' } });
  });

  it('EXE-1 prepare prepares a created change-set through the reader', async () => {
    const cs = await createPreparing(repository, {
      configHash: configuration.hash,
      args: { brand: 'acme', skus: ['t-0001', 't-0002', 't-0003'], changes: { name: 'new' } },
    });
    const reader = new CatalogReader();
    const a = activities({ reader });
    const first = environment(1);
    let heartbeats = 0;
    first.on('heartbeat', () => {
      heartbeats += 1;
    });
    await expect(first.run(() => a.prepare(cs.id))).resolves.toEqual({ status: 'prepared' });
    // Batch size 2: two read chunks, each after a heartbeat, plus the one at the start.
    expect(reader.calls.map((c) => [c.operationId, c.args.skus])).toEqual([
      [READ_OPERATION, ['t-0001', 't-0002']],
      [READ_OPERATION, ['t-0003']],
    ]);
    expect(heartbeats).toBe(3);
    const prepared = await repository.get(cs.id);
    expect(prepared).toMatchObject({ status: 'prepared', stats: { included: 3 } });
    expect(prepared?.hash).toMatch(/^sha256:[0-9a-f]{64}$/);
    // A retry after success changes nothing (NFR-2).
    await expect(attempt(2, () => a.prepare(cs.id))).resolves.toEqual({ status: 'prepared' });
    expect(reader.calls).toHaveLength(2);
  });

  it('EXE-4 NFR-2 prepare and executeBatch heartbeat at the start and on a timer while a slow read or write runs', async () => {
    const slowRead: UpstreamReader = {
      async read(operationId, args) {
        await new Promise((resolve) => setTimeout(resolve, 2_500));
        return new CatalogReader().read(operationId, args);
      },
    };
    const slowWrite: ChangeWriter = {
      async writeBatch({ items }) {
        await new Promise((resolve) => setTimeout(resolve, 2_500));
        return items.map((i): ItemOutcome => ({ targetId: i.targetId, status: 'written' }));
      },
    };
    const a = activities({ reader: slowRead, writer: slowWrite });
    // Heartbeat timeout 3 s: the timer beats every second (a third of it).
    const timed = (): { env: MockActivityEnvironment; beats: () => number } => {
      const env = new MockActivityEnvironment({ attempt: 1, heartbeatTimeoutMs: 3_000 }, { logger: new DefaultLogger('ERROR') });
      let beats = 0;
      env.on('heartbeat', () => {
        beats += 1;
      });
      return { env, beats: () => beats };
    };

    const preparing = await createPreparing(repository, {
      configHash: configuration.hash,
      args: { brand: 'acme', skus: ['t-0001'], changes: { name: 'new' } },
    });
    const p = timed();
    await expect(p.env.run(() => a.prepare(preparing.id))).resolves.toEqual({ status: 'prepared' });
    // One at the start, one before the read chunk, at least two from the timer during the 2.5 s read.
    expect(p.beats()).toBeGreaterThanOrEqual(4);

    const executing = await createPrepared(repository, 2, { execute: {} });
    const w = timed();
    await expect(w.env.run(() => a.executeBatch(executing.id, 0))).resolves.toMatchObject({ written: 2 });
    // One at the start, at least two from the timer during the 2.5 s write.
    expect(w.beats()).toBeGreaterThanOrEqual(3);
    // The timers are cleared: nothing beats after the activity returned.
    const after = [p.beats(), w.beats()];
    await new Promise((resolve) => setTimeout(resolve, 1_500));
    expect([p.beats(), w.beats()]).toEqual(after);
  }, 20_000);

  it('EXE-6 finishExecution done computes the terminal status and is idempotent', async () => {
    const cs = await createPrepared(repository, 2, { execute: { correlationId: 'corr-exec-finish' } });
    const a = activities({ writer: new ScriptedWriter({ outcomes: { 't-0002': 'failed' } }) });
    await attempt(1, () => a.executeBatch(cs.id, 0));
    await expect(attempt(1, () => a.finishExecution(cs.id, 'done'))).resolves.toEqual({ status: 'completed_with_errors' });
    await expect(attempt(2, () => a.finishExecution(cs.id, 'done'))).resolves.toEqual({ status: 'completed_with_errors' });
    const terminal = (await auditEventsOf(postgres.database, cs.id)).filter((e) => e.details.from === 'executing');
    expect(terminal).toHaveLength(1);
    expect(terminal[0]).toMatchObject({ actor: 'system', correlationId: 'corr-exec-finish', details: { to: 'completed_with_errors' } });
  });

  it('EXE-6 finishExecution with a failure outcome fails with that outcome as error code', async () => {
    const cs = await createPrepared(repository, 2, { execute: {} });
    await expect(attempt(1, () => activities().finishExecution(cs.id, 'writer_error'))).resolves.toEqual({ status: 'failed' });
    expect(await repository.get(cs.id)).toMatchObject({ status: 'failed', errorCode: 'writer_error' });
  });

  it('NFR-2 SEC-3 a throwing writer fails the attempt as retryable writer_failed without its message', async () => {
    const cs = await createPrepared(repository, 2, { execute: {} });
    const writer: ChangeWriter = { writeBatch: () => Promise.reject(new Error('upstream said secret-upstream-text')) };
    let error: unknown;
    try {
      await attempt(1, () => activities({ writer }).executeBatch(cs.id, 0));
    } catch (e) {
      error = e;
    }
    expect(error).toMatchObject({ message: 'writer_failed', nonRetryable: false });
    expect((error as Error).cause).toBeUndefined();
    expect(`${String((error as Error).stack)} ${JSON.stringify(error)}`).not.toContain('secret-upstream-text');
    expect(await itemStatuses(cs.id)).toEqual({ 't-0001': 'pending', 't-0002': 'pending' });
  });

  it('SEC-3 a throwing writer is logged at warn with the change-set, the batch and the error class, never its message', async () => {
    const cs = await createPrepared(repository, 2, { execute: {} });
    const writer: ChangeWriter = { writeBatch: () => Promise.reject(new TypeError('upstream said secret-upstream-text')) };
    const entries: { level: string; message: string; meta?: Record<string, unknown> }[] = [];
    const env = new MockActivityEnvironment(
      { attempt: 1 },
      { logger: new DefaultLogger('WARN', (entry) => entries.push({ level: entry.level, message: entry.message, ...(entry.meta === undefined ? {} : { meta: entry.meta }) })) },
    );
    await expect(env.run(() => activities({ writer }).executeBatch(cs.id, 0))).rejects.toMatchObject({ message: 'writer_failed' });
    // The SDK logs the failed activity on its own (as `writer_failed`); this is the activity's entry.
    const warned = entries.filter((e) => e.message === 'change-set batch write failed');
    expect(warned).toHaveLength(1);
    expect(warned[0]).toMatchObject({
      level: 'WARN',
      message: 'change-set batch write failed',
      meta: { changesetId: cs.id, batchNo: 0, errorClass: 'TypeError' },
    });
    expect(JSON.stringify(entries)).not.toContain('secret-upstream-text');
  });

  it('NFR-2 EXE-3 a claim by an older attempt than the batch owner is superseded and not retried', async () => {
    const cs = await createPrepared(repository, 2, { execute: {} });
    const writer = new ScriptedWriter();
    const a = activities({ writer });
    const paused = writer.pauseAt(0);
    const owner = attempt(2, () => a.executeBatch(cs.id, 0));
    await paused.reached;
    await expect(attempt(1, () => a.executeBatch(cs.id, 0))).rejects.toMatchObject({ message: 'batch_superseded', nonRetryable: true });
    expect(writer.calls).toBe(1);
    paused.release();
    await expect(owner).resolves.toMatchObject({ written: 2, remaining: 0 });
  });

  it('NFR-2 EXE-3 a writer whose submission is fenced off is superseded and records nothing', async () => {
    const cs = await createPrepared(repository, 2, { execute: {} });
    const writer = new GatedWriter();
    const a = activities({ writer });
    const first = attempt(1, () => a.executeBatch(cs.id, 0));
    await writer.reached;
    await expect(attempt(2, () => a.executeBatch(cs.id, 0))).resolves.toMatchObject({ written: 2, remaining: 0 });
    writer.release();
    await expect(first).rejects.toMatchObject({ message: 'batch_superseded', nonRetryable: true });
    expect((await repository.stats(cs.id)).written).toBe(2);
  });

  it('EXE-1 prepare fails operation_unavailable when the operation has no manifest in the configuration', async () => {
    const cs = await createPreparing(repository, { operation: READ_OPERATION, configHash: configuration.hash });
    const reader = new CatalogReader();
    await expect(attempt(1, () => activities({ reader }).prepare(cs.id))).resolves.toEqual({ status: 'failed' });
    expect(await repository.get(cs.id)).toMatchObject({ status: 'failed', errorCode: 'operation_unavailable' });
    expect(reader.calls).toEqual([]);
  });

  it('EXE-7 finishExecution cancelled without a stored cancel request fails closed with executor_error', async () => {
    const cs = await createPrepared(repository, 2, { execute: {} });
    await expect(attempt(1, () => activities().finishExecution(cs.id, 'cancelled'))).resolves.toEqual({ status: 'failed' });
    expect(await repository.get(cs.id)).toMatchObject({ status: 'failed', errorCode: 'executor_error' });
    const last = (await auditEventsOf(postgres.database, cs.id)).at(-1);
    expect(last).toMatchObject({ actor: 'system', details: { from: 'executing', to: 'failed' } });
  });

  it('EXE-7 finishExecution cancelled uses the stored cancel actor', async () => {
    const cs = await createPrepared(repository, 2, { execute: {} });
    await repository.requestCancel(cs.id, { actor: 'bob', correlationId: 'corr-cancel', requestedAt: new Date() });
    await expect(attempt(1, () => activities().finishExecution(cs.id, 'cancelled'))).resolves.toEqual({ status: 'cancelled' });
    const last = (await auditEventsOf(postgres.database, cs.id)).at(-1);
    expect(last).toMatchObject({ actor: 'bob', correlationId: 'corr-cancel', details: { from: 'executing', to: 'cancelled' } });
  });

  describe('NTF-1 finishExecution notifications', () => {
    const notifying = () => ({ ...configuration, notify: new Map([['editor', { approvalRequests: [], results: ['chat'] }]]) });
    const submission = { actor: 'alice', groups: ['editors'], correlationId: 'corr-submit', at: new Date(), role: 'editor', rule: 'role:editor/grant:all' };
    const queued = async (changesetId: string) =>
      (await new PostgresNotificationOutbox(postgres.database.db).listFor(changesetId)).map(({ kind, round, step, target, state }) => ({
        kind,
        round,
        step,
        target,
        state,
      }));

    it("NTF-1 finishExecution queues execution_finished for the requester role's results", async () => {
      const cs = await createPrepared(repository, 1, { execute: { submission } });
      const a = activities({ configuration: notifying() });
      await attempt(1, () => a.executeBatch(cs.id, 0));
      await expect(attempt(1, () => a.finishExecution(cs.id, 'done'))).resolves.toEqual({ status: 'completed' });
      expect(await queued(cs.id)).toEqual([{ kind: 'execution_finished', round: 0, step: 0, target: 'chat', state: 'pending' }]);
    });

    it('NTF-3 a retried finishExecution queues one row', async () => {
      const cs = await createPrepared(repository, 1, { execute: { submission } });
      const a = activities({ configuration: notifying() });
      await attempt(1, () => a.finishExecution(cs.id, 'writer_error'));
      await attempt(2, () => a.finishExecution(cs.id, 'writer_error'));
      expect(await queued(cs.id)).toHaveLength(1);
    });

    it('NTF-1 finishExecution without a submission queues nothing', async () => {
      const cs = await createPrepared(repository, 1, { execute: {} });
      await attempt(1, () => activities({ configuration: notifying() }).finishExecution(cs.id, 'writer_error'));
      expect(await queued(cs.id)).toEqual([]);
    });

    it('NTF-1 a cancelled execution also notifies', async () => {
      const cs = await createPrepared(repository, 1, { execute: { submission } });
      await repository.requestCancel(cs.id, { actor: 'bob', correlationId: 'corr-cancel', requestedAt: new Date() });
      await expect(attempt(1, () => activities({ configuration: notifying() }).finishExecution(cs.id, 'cancelled'))).resolves.toEqual({
        status: 'cancelled',
      });
      expect(await queued(cs.id)).toEqual([{ kind: 'execution_finished', round: 0, step: 0, target: 'chat', state: 'pending' }]);
    });
  });

  it('EXE-1 expire moves a due prepared change-set to expired with actor system', async () => {
    const due = await createPrepared(repository, 1, { expiresAt: new Date(Date.now() - 1_000) });
    const notDue = await createPrepared(repository, 1);
    const a = activities();
    await attempt(1, () => a.expire(due.id));
    await attempt(1, () => a.expire(notDue.id));
    expect((await repository.get(due.id))?.status).toBe('expired');
    expect((await repository.get(notDue.id))?.status).toBe('prepared');
    const last = (await auditEventsOf(postgres.database, due.id)).at(-1);
    expect(last).toMatchObject({ actor: 'system', correlationId: due.correlationId, details: { from: 'prepared', to: 'expired' } });
    // Again: a no-op (NFR-2).
    await expect(attempt(2, () => a.expire(due.id))).resolves.toBeUndefined();
  });

  it('POL-6 beginExecution runs the guard unless verified and reports settings and counts', async () => {
    const cs = await createPrepared(repository, 3, { execute: {} });
    const denying: ExecutionGuard = { check: () => Promise.resolve({ ok: false, outcome: 'policy_denied' }) };
    const a = activities({ guard: denying });
    await expect(attempt(1, () => a.beginExecution(cs.id, { verified: false }))).resolves.toEqual({ ok: false, outcome: 'policy_denied' });
    await expect(attempt(1, () => a.beginExecution(cs.id, { verified: true }))).resolves.toEqual({
      ok: true,
      total: 3,
      done: 0,
      failed: 0,
      skipped: 0,
      batchSize: 2,
      itemsPerRun: 100,
      cancelRequested: false,
    });
  });

  describe('EXE-8 rollback activities', () => {
    const HOUR_MS = 3_600_000;
    const submission = { actor: 'alice', groups: ['editors'], correlationId: 'corr-submit', at: new Date(), role: 'editor', rule: 'role:editor/grant:all' };

    /** The test configuration with the write operation's manifest changed, or the operation removed (`undefined`). */
    const reconfigured = (change: { rollback?: RollbackStrategy; hours?: number; drop?: boolean }): LoadedConfiguration => {
      const operations = configuration.policy.operations
        .filter((o) => change.drop !== true || o.id !== WRITE_OPERATION)
        .map((o) =>
          o.id === WRITE_OPERATION && o.manifest !== undefined && change.rollback !== undefined
            ? { ...o, manifest: { ...o.manifest, rollback: change.rollback } }
            : o,
        );
      return {
        ...configuration,
        policy: { ...configuration.policy, operations },
        changesets: { ...configuration.changesets, rollbackWindowHours: change.hours ?? configuration.changesets.rollbackWindowHours },
      };
    };

    /** Executes every item with `writer` (default: all written) and finishes the run `done`. */
    const executed = async (items: number, writer: ChangeWriter = new ScriptedWriter(), opts: { hash?: string } = {}): Promise<ChangeSetRecord> => {
      const cs = await createPrepared(repository, items, {
        ...(opts.hash === undefined ? {} : { hash: opts.hash }),
        execute: { correlationId: 'corr-exec', submission },
      });
      const a = activities({ writer });
      for (let batchNo = 0; ; batchNo++) {
        if ((await attempt(1, () => a.executeBatch(cs.id, batchNo))).remaining === 0) break;
      }
      await attempt(1, () => a.finishExecution(cs.id, 'done'));
      return cs;
    };

    /** Opens the window and stores a rollback request, as the api's request path does. */
    const rollingBack = async (cs: ChangeSetRecord): Promise<ChangeSetRecord> => {
      await attempt(1, () => activities().openRollbackWindow(cs.id));
      const requested = await repository.requestRollback({
        changesetId: cs.id,
        request: { actor: 'alice', correlationId: 'corr-rollback', requestedAt: new Date() },
        marginMs: 60_000,
        audit: [],
      });
      if (!requested.ok) throw new Error(`test rollback not requested: ${requested.reason}`);
      return requested.changeset;
    };

    /** Rollback outcomes scripted per target (default: restored), with an optional error. */
    class RestoringWriter implements ChangeWriter {
      calls = 0;
      readonly keys: string[] = [];
      constructor(private readonly outcomes: Readonly<Record<string, Omit<ItemOutcome, 'targetId'>>> = {}) {}
      async writeBatch(input: { items: readonly ChangeItemRecord[]; batch: BatchContext }): Promise<readonly ItemOutcome[]> {
        this.calls += 1;
        this.keys.push(input.batch.key);
        // The plan holds an internal outcome; the activity must take the returned outcomes, not this.
        await input.batch.recordSubmission({
          upstreamBatchId: input.batch.key,
          plan: input.items.map((i) => ({ targetId: i.targetId, action: 'outcome' as const, status: 'written' as const, error: 'already_applied' })),
        });
        return input.items.map((i): ItemOutcome => ({ targetId: i.targetId, ...(this.outcomes[i.targetId] ?? { status: 'written' }) }));
      }
    }

    const rollbackOf = async (changesetId: string) =>
      (await repository.itemsPage(changesetId, { limit: 100 })).map((i) => [i.targetId, i.rollbackStatus, i.rollbackError]);

    it('EXE-8 openRollbackWindow opens once for an executed change-set and answers the stored end', async () => {
      const cs = await executed(3);
      const before = Date.now();
      const opened = await attempt(1, () => activities().openRollbackWindow(cs.id));
      const after = Date.now();
      const hours = configuration.changesets.rollbackWindowHours;
      expect(hours).toBeGreaterThan(0);
      expect(opened.untilMs).toBeGreaterThanOrEqual(before + hours * HOUR_MS);
      expect(opened.untilMs).toBeLessThanOrEqual(after + hours * HOUR_MS);
      expect((await repository.get(cs.id))?.rollbackUntil?.getTime()).toBe(opened.untilMs);
      // Later, and under a configuration that would open no window: the stored end (write-once, NFR-2).
      const later = activities({ now: () => new Date(Date.now() + 5 * HOUR_MS), configuration: reconfigured({ hours: 0 }) });
      await expect(attempt(2, () => later.openRollbackWindow(cs.id))).resolves.toEqual(opened);
    });

    it('EXE-8 openRollbackWindow answers null for hours 0, strategy none, nothing written, a run that never started', async () => {
      const none = { untilMs: null };
      const hoursZero = await executed(2);
      await expect(attempt(1, () => activities({ configuration: reconfigured({ hours: 0 }) }).openRollbackWindow(hoursZero.id))).resolves.toEqual(none);
      const strategyNone = await executed(2);
      await expect(
        attempt(1, () => activities({ configuration: reconfigured({ rollback: { strategy: 'none' } }) }).openRollbackWindow(strategyNone.id)),
      ).resolves.toEqual(none);
      // An operation gone from the configuration answers null as well, never operation_unavailable.
      const unknown = await executed(2);
      await expect(attempt(1, () => activities({ configuration: reconfigured({ drop: true }) }).openRollbackWindow(unknown.id))).resolves.toEqual(none);
      const nothingWritten = await executed(2, new ScriptedWriter({ outcomes: { 't-0001': 'failed', 't-0002': 'skipped' } }));
      await expect(attempt(1, () => activities().openRollbackWindow(nothingWritten.id))).resolves.toEqual(none);
      const prepared = await createPrepared(repository, 2);
      const neverStarted = await repository.transition(
        prepared.id,
        ['prepared'],
        'cancelled',
        changesetTransitionEvent({ id: randomUUID(), actor: 'alice', changeset: prepared, from: 'prepared', to: 'cancelled', correlationId: 'corr-cancel' }),
      );
      expect(neverStarted?.status).toBe('cancelled');
      await expect(attempt(1, () => activities().openRollbackWindow(prepared.id))).resolves.toEqual(none);
      for (const cs of [hoursZero, strategyNone, unknown, nothingWritten, prepared]) {
        expect((await repository.get(cs.id))?.rollbackUntil).toBeUndefined();
      }
    });

    it('EXE-8 beginRollback checks the status, the hash and the writer', async () => {
      const a = activities();
      const completed = await executed(3);
      await expect(attempt(1, () => a.beginRollback(completed.id))).resolves.toEqual({ ok: false, outcome: 'executor_error' });

      const tampered = await rollingBack(await executed(2, new ScriptedWriter(), { hash: `sha256:${'0'.repeat(64)}` }));
      await expect(attempt(1, () => a.beginRollback(tampered.id))).resolves.toEqual({ ok: false, outcome: 'hash_mismatch' });

      const withoutWriter = activities({ rollbackWriterFor: () => undefined });
      const unwritable = await rollingBack(await executed(2));
      await expect(attempt(1, () => withoutWriter.beginRollback(unwritable.id))).resolves.toEqual({ ok: false, outcome: 'executor_error' });
      // A batch of an operation without a rollback writer is not retried.
      await expect(attempt(1, () => withoutWriter.rollbackBatch(unwritable.id, 1))).rejects.toMatchObject({
        message: 'operation_unavailable',
        nonRetryable: true,
      });

      const ready = await rollingBack(await executed(3));
      const env = environment(1);
      let heartbeats = 0;
      env.on('heartbeat', () => {
        heartbeats += 1;
      });
      await expect(env.run(() => a.beginRollback(ready.id))).resolves.toEqual({ ok: true, nextBatch: 1, itemsPerRun: 100 });
      // One per stored-items page while hashing.
      expect(heartbeats).toBeGreaterThanOrEqual(1);
    });

    it('EXE-8 rollbackBatch restores claimed items and a done batch answers from storage without writing', async () => {
      const cs = await rollingBack(await executed(3));
      const writer = new RestoringWriter({
        't-0002': { status: 'written', error: 'already_restored' },
        't-0003': { status: 'skipped', error: 'drift' },
      });
      const a = activities({ rollbackWriterFor: () => writer });

      const first = await attempt(1, () => a.rollbackBatch(cs.id, 1));
      expect(first).toEqual({ restored: 2, skipped: 0, failed: 0, remaining: 1, empty: false });
      await expect(attempt(1, () => a.rollbackBatch(cs.id, 2))).resolves.toEqual({ restored: 0, skipped: 1, failed: 0, remaining: 0, empty: false });
      await expect(attempt(1, () => a.rollbackBatch(cs.id, 3))).resolves.toEqual({ restored: 0, skipped: 0, failed: 0, remaining: 0, empty: true });
      expect(writer.keys).toEqual([`${cs.id}:rollback:1`, `${cs.id}:rollback:2`]);
      expect(await rollbackOf(cs.id)).toEqual([
        ['t-0001', 'restored', undefined],
        ['t-0002', 'restored', 'already_restored'],
        ['t-0003', 'skipped', 'drift'],
      ]);
      expect((await repository.get(cs.id))?.stats.rollback).toEqual({ restored: 2, skipped: 1, failed: 0 });

      // A retry of a done batch answers its stored counts (and what is left now) and calls the writer no more (NFR-2).
      await expect(attempt(2, () => a.rollbackBatch(cs.id, 1))).resolves.toEqual({ ...first, remaining: 0 });
      expect(writer.calls).toBe(2);

      // AUD-1: one changeset.batch row per rollback batch, phase rollback, under the rollback request's correlation ID.
      const audited = (await auditEventsOf(postgres.database, cs.id)).filter((e) => e.action === 'changeset.batch' && e.details.phase === 'rollback');
      expect(audited.map((e) => [e.actor, e.correlationId, e.details])).toEqual([
        ['system', 'corr-rollback', { phase: 'rollback', batchNo: 1, restored: 2, skipped: 0, failed: 0 }],
        ['system', 'corr-rollback', { phase: 'rollback', batchNo: 2, restored: 0, skipped: 1, failed: 0 }],
      ]);
    });

    it('NFR-2 a rollbackBatch retry after a recorded submission polls instead of resubmitting', async () => {
      const cs = await rollingBack(await executed(2));
      const seen: (string | undefined)[] = [];
      let recorded = 0;
      const writer: ChangeWriter = {
        async writeBatch({ items, batch }) {
          seen.push(batch.submission?.upstreamBatchId);
          if (batch.submission === undefined) {
            await batch.recordSubmission({ upstreamBatchId: 'upstream-rollback-1', plan: items.map((i) => ({ targetId: i.targetId, action: 'write' as const })) });
            recorded += 1;
            // The worker is lost after the submission was recorded; the message must not leak (SEC-3).
            throw new Error('upstream said secret-upstream-text');
          }
          return items.map((i): ItemOutcome => ({ targetId: i.targetId, status: 'written' }));
        },
      };
      const a = activities({ rollbackWriterFor: () => writer });
      let error: unknown;
      try {
        await attempt(1, () => a.rollbackBatch(cs.id, 1));
      } catch (e) {
        error = e;
      }
      expect(error).toMatchObject({ message: 'writer_failed', nonRetryable: false });
      expect(`${String((error as Error).stack)} ${JSON.stringify(error)}`).not.toContain('secret-upstream-text');
      expect(await rollbackOf(cs.id)).toEqual([
        ['t-0001', undefined, undefined],
        ['t-0002', undefined, undefined],
      ]);

      await expect(attempt(2, () => a.rollbackBatch(cs.id, 1))).resolves.toEqual({ restored: 2, skipped: 0, failed: 0, remaining: 0, empty: false });
      expect(seen).toEqual([undefined, 'upstream-rollback-1']);
      expect(recorded).toBe(1);
    });

    it('EXE-8 NTF-1 finishRollback ends rolled_back or failed with the rollback code and queues rollback_result once', async () => {
      const notifying = activities({ configuration: { ...configuration, notify: new Map([['editor', { approvalRequests: [], results: ['chat'] }]]) } });
      const queued = async (changesetId: string) =>
        (await new PostgresNotificationOutbox(postgres.database.db).listFor(changesetId)).map(({ kind, round, step, target }) => ({ kind, round, step, target }));
      const fromRollingBack = async (changesetId: string) =>
        (await auditEventsOf(postgres.database, changesetId)).filter((e) => e.action === 'changeset.transition' && e.details.from === 'rolling_back');

      const done = await rollingBack(await executed(2));
      await attempt(1, () => notifying.rollbackBatch(done.id, 1));
      await expect(attempt(1, () => notifying.finishRollback(done.id, 'done'))).resolves.toEqual({ status: 'rolled_back' });
      // A retry after success loses the compare-and-set and answers the current status (NFR-2, NTF-3).
      await expect(attempt(2, () => notifying.finishRollback(done.id, 'done'))).resolves.toEqual({ status: 'rolled_back' });
      expect((await repository.get(done.id))?.errorCode).toBeUndefined();
      expect((await fromRollingBack(done.id)).map((e) => [e.actor, e.correlationId, e.details.to])).toEqual([['system', 'corr-rollback', 'rolled_back']]);
      expect(await queued(done.id)).toEqual([{ kind: 'rollback_result', round: 0, step: 0, target: 'chat' }]);

      const broken = await rollingBack(await executed(2));
      await expect(attempt(1, () => notifying.finishRollback(broken.id, 'writer_error'))).resolves.toEqual({ status: 'failed' });
      await expect(attempt(2, () => notifying.finishRollback(broken.id, 'writer_error'))).resolves.toEqual({ status: 'failed' });
      expect(await repository.get(broken.id)).toMatchObject({ status: 'failed', errorCode: 'rollback_writer_error' });
      expect((await fromRollingBack(broken.id)).map((e) => [e.actor, e.correlationId, e.details.to])).toEqual([['system', 'corr-rollback', 'failed']]);
      expect(await queued(broken.id)).toEqual([{ kind: 'rollback_result', round: 0, step: 0, target: 'chat' }]);
    });
  });
});
