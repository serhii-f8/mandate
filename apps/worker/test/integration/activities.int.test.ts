import { randomUUID } from 'node:crypto';
import type { LoadedConfiguration } from '@aiops/config';
import type { ChangeWriter, ExecutionGuard, ReadPage, UpstreamReader } from '@aiops/core';
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
    // Batch size 2: two read chunks, each after a heartbeat.
    expect(reader.calls.map((c) => [c.operationId, c.args.skus])).toEqual([
      [READ_OPERATION, ['t-0001', 't-0002']],
      [READ_OPERATION, ['t-0003']],
    ]);
    expect(heartbeats).toBe(2);
    const prepared = await repository.get(cs.id);
    expect(prepared).toMatchObject({ status: 'prepared', stats: { included: 3 } });
    expect(prepared?.hash).toMatch(/^sha256:[0-9a-f]{64}$/);
    // A retry after success changes nothing (NFR-2).
    await expect(attempt(2, () => a.prepare(cs.id))).resolves.toEqual({ status: 'prepared' });
    expect(reader.calls).toHaveLength(2);
  });

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
