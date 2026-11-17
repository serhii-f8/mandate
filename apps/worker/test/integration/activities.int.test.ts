import { randomUUID } from 'node:crypto';
import type { LoadedConfiguration } from '@aiops/config';
import type { BatchContext, ChangeItemRecord, ChangeWriter, ExecutionGuard, ItemOutcome, ReadPage, UpstreamReader } from '@aiops/core';
import { PostgresChangeSetRepository } from '@aiops/db';
import { DEFAULT_TUNING, PREPARE_MAX_ATTEMPTS, type ChangesetActivities } from '@aiops/temporal';
import { allowAllGuard, ScriptedWriter } from '@aiops/testing';
import { MockActivityEnvironment } from '@temporalio/testing';
import { DefaultLogger } from '@temporalio/worker';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createActivities } from '../../src/activities/index.js';
import { createPrepared, createPreparing } from '../support/changesets.js';
import { READ_OPERATION, testConfiguration } from '../support/configuration.js';
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
  readonly reader?: UpstreamReader;
  readonly guard?: ExecutionGuard;
}

function activities(fixture: Fixture = {}): ChangesetActivities {
  return createActivities({
    repository,
    configuration: () => configuration,
    writerFor: () => fixture.writer ?? new ScriptedWriter(),
    readerFor: () => fixture.reader ?? new CatalogReader(),
    guardFor: () => fixture.guard ?? allowAllGuard,
    tuning: DEFAULT_TUNING,
    newId: randomUUID,
    now: () => new Date(),
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
});
