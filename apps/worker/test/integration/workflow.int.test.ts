import { BatchFenced, type ChangeWriter, type ExecutionGuard, type ItemOutcome } from '@aiops/core';
import { CHANGESET_WORKFLOW, PROGRESS_QUERY, WAKE_SIGNAL, type WorkflowProgress } from '@aiops/temporal';
import { ScriptedWriter } from '@aiops/testing';
import type { WorkflowHandle } from '@temporalio/client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { changesetWorkflow } from '../../src/workflows/changeset.js';
import { createPrepared, createPreparing, startExecutionOf } from '../support/changesets.js';
import { startInfrastructure, startTestWorker, type Infra, type TestWorker } from '../support/harness.js';
import { auditEventsOf } from '../support/postgres.js';

let infra: Infra;

beforeAll(async () => {
  infra = await startInfrastructure();
});

afterAll(async () => {
  await infra.close();
});

/** Starts (or wakes) the change-set's workflow, as the Temporal executor's start does. */
function signalWithStart(worker: TestWorker, changesetId: string): Promise<WorkflowHandle<typeof changesetWorkflow>> {
  return infra.client.workflow.signalWithStart<typeof changesetWorkflow>(CHANGESET_WORKFLOW, {
    workflowId: changesetId,
    taskQueue: worker.taskQueue,
    args: [{ changesetId }],
    signal: WAKE_SIGNAL,
    signalArgs: [],
  });
}

/** Runs one case on its own worker and task queue, and stops the worker afterwards. */
async function withWorker<T>(opts: Parameters<typeof startTestWorker>[1], fn: (worker: TestWorker) => Promise<T>): Promise<T> {
  const worker = await startTestWorker(infra, opts);
  try {
    return await fn(worker);
  } finally {
    await worker.stop();
  }
}

async function itemStatuses(changesetId: string): Promise<Record<string, string>> {
  const page = await infra.repository.itemsPage(changesetId, { limit: 100 });
  return Object.fromEntries(page.map((i) => [i.targetId, i.status]));
}

async function record(changesetId: string): Promise<{ status: string; errorCode?: string }> {
  const cs = await infra.repository.get(changesetId);
  if (cs === undefined) throw new Error('change-set not found');
  return { status: cs.status, ...(cs.errorCode === undefined ? {} : { errorCode: cs.errorCode }) };
}

describe('changesetWorkflow', () => {
  it('EXE-1 EXE-3 a change-set moved to executing and signalled runs to completed in batches', async () => {
    const writer = new ScriptedWriter();
    const cs = await createPrepared(infra.repository, 3, { execute: {} });
    await withWorker({ writer }, async (worker) => {
      const handle = await signalWithStart(worker, cs.id);
      await expect(handle.result()).resolves.toEqual({ status: 'completed' });
    });
    expect(writer.batches).toEqual([
      ['t-0001', 't-0002'],
      ['t-0003'],
    ]);
    expect(await record(cs.id)).toEqual({ status: 'completed' });
  });

  it('EXE-6 the progress query reports counts while executing', async () => {
    const writer = new ScriptedWriter();
    const paused = writer.pauseAt(1);
    const cs = await createPrepared(infra.repository, 4, { execute: {} });
    await withWorker({ writer }, async (worker) => {
      const handle = await signalWithStart(worker, cs.id);
      await paused.reached;
      const progress: WorkflowProgress = await handle.query<WorkflowProgress>(PROGRESS_QUERY);
      expect(progress).toEqual({ status: 'executing', total: 4, done: 2, failed: 0, skipped: 0 });
      paused.release();
      await expect(handle.result()).resolves.toEqual({ status: 'completed' });
      expect(await handle.query<WorkflowProgress>(PROGRESS_QUERY)).toEqual({
        status: 'completed',
        total: 4,
        done: 4,
        failed: 0,
        skipped: 0,
      });
    });
  });

  it('EXE-7 a cancel request stored during a batch ends the run cancelled after that batch', async () => {
    const writer = new ScriptedWriter();
    const paused = writer.pauseAt(0);
    const cs = await createPrepared(infra.repository, 4, { execute: {} });
    await withWorker({ writer }, async (worker) => {
      const handle = await signalWithStart(worker, cs.id);
      await paused.reached;
      const stored = await infra.repository.requestCancel(cs.id, { actor: 'bob', correlationId: 'corr-cancel', requestedAt: new Date() });
      expect(stored.ok).toBe(true);
      paused.release();
      await expect(handle.result()).resolves.toEqual({ status: 'cancelled' });
    });
    expect(writer.batches).toEqual([['t-0001', 't-0002']]);
    expect(await itemStatuses(cs.id)).toEqual({ 't-0001': 'written', 't-0002': 'written', 't-0003': 'pending', 't-0004': 'pending' });
    const last = (await auditEventsOf(infra.database, cs.id)).at(-1);
    expect(last).toMatchObject({ actor: 'bob', correlationId: 'corr-cancel' });
  });

  it('EXE-5 the failure threshold ends the run failed/failure_threshold', async () => {
    const writer = new ScriptedWriter({ outcomes: { 't-0001': 'failed', 't-0002': 'failed' } });
    const cs = await createPrepared(infra.repository, 6, { execute: {} });
    await withWorker({ writer }, async (worker) => {
      const handle = await signalWithStart(worker, cs.id);
      await expect(handle.result()).resolves.toEqual({ status: 'failed' });
    });
    expect(await record(cs.id)).toEqual({ status: 'failed', errorCode: 'failure_threshold' });
    expect(writer.batches).toHaveLength(1);
    expect(Object.values(await itemStatuses(cs.id)).filter((s) => s === 'pending')).toHaveLength(4);
  });

  it('NFR-2 a batch that fails every attempt ends failed/writer_error with earlier batches kept', async () => {
    const writer = new ScriptedWriter();
    writer.throwAt(1);
    const cs = await createPrepared(infra.repository, 4, { execute: {} });
    await withWorker({ writer }, async (worker) => {
      const handle = await signalWithStart(worker, cs.id);
      await expect(handle.result()).resolves.toEqual({ status: 'failed' });
    });
    expect(await record(cs.id)).toEqual({ status: 'failed', errorCode: 'writer_error' });
    expect(await itemStatuses(cs.id)).toEqual({ 't-0001': 'written', 't-0002': 'written', 't-0003': 'pending', 't-0004': 'pending' });
    // Batch 0 once, then every one of the three attempts of batch 1 (FAST_TUNING.batchMaxAttempts).
    expect(writer.calls).toBe(4);
  });

  it('NFR-2 EXE-3 a superseded batch ends failed/executor_error, not writer_error', async () => {
    const writer: ChangeWriter = {
      writeBatch: (): Promise<readonly ItemOutcome[]> => Promise.reject(new BatchFenced()),
    };
    const cs = await createPrepared(infra.repository, 2, { execute: {} });
    await withWorker({ writer }, async (worker) => {
      const handle = await signalWithStart(worker, cs.id);
      await expect(handle.result()).resolves.toEqual({ status: 'failed' });
    });
    expect(await record(cs.id)).toEqual({ status: 'failed', errorCode: 'executor_error' });
  });

  it('EXE-3 a batch that claims no items while items remain ends failed/executor_error', async () => {
    const writer = new ScriptedWriter();
    const cs = await createPrepared(infra.repository, 2, { execute: {} });
    // Every pending item already belongs to another (never completed) batch row.
    const claim = await infra.repository.claimBatch(cs.id, 5, 1, 2);
    expect(claim.kind).toBe('claimed');
    await withWorker({ writer }, async (worker) => {
      const handle = await signalWithStart(worker, cs.id);
      await expect(handle.result()).resolves.toEqual({ status: 'failed' });
    });
    expect(await record(cs.id)).toEqual({ status: 'failed', errorCode: 'executor_error' });
    expect(writer.calls).toBe(0);
  });

  it('EXE-1 a prepared change-set waits for wake and expires at expiresAt', async () => {
    const cs = await createPrepared(infra.repository, 1, { expiresAt: new Date(Date.now() + 3_000) });
    await withWorker({}, async (worker) => {
      const handle = await signalWithStart(worker, cs.id);
      await expect(handle.result()).resolves.toEqual({ status: 'expired' });
    });
    expect(await record(cs.id)).toEqual({ status: 'expired' });
    const last = (await auditEventsOf(infra.database, cs.id)).at(-1);
    expect(last).toMatchObject({ actor: 'system' });
    expect(last?.details).toMatchObject({ from: 'prepared', to: 'expired' });
  });

  it('EXE-1 a preparation that keeps failing ends expired at expiresAt instead of retrying forever', async () => {
    const cs = await createPreparing(infra.repository, {
      configHash: infra.configuration.hash,
      expiresAt: new Date(Date.now() + 3_000),
    });
    let attempts = 0;
    const readerFor = (): never => {
      attempts += 1;
      throw new Error('infrastructure unavailable');
    };
    await withWorker({ readerFor }, async (worker) => {
      const handle = await signalWithStart(worker, cs.id);
      await expect(handle.result()).resolves.toEqual({ status: 'expired' });
    });
    expect(attempts).toBeGreaterThan(0);
    expect(await record(cs.id)).toEqual({ status: 'expired' });
    const last = (await auditEventsOf(infra.database, cs.id)).at(-1);
    expect(last).toMatchObject({ actor: 'system' });
    expect(last?.details).toMatchObject({ from: 'preparing', to: 'expired' });
  }, 30_000);

  it('EXE-1 an expire that changes nothing (worker clock behind) is retried after a pause, not in a busy loop', async () => {
    const cs = await createPrepared(infra.repository, 1, { expiresAt: new Date(Date.now() + 1_000) });
    let expireCalls = 0;
    const spy = (activity: string): void => {
      if (activity === 'expire') expireCalls += 1;
    };
    // The worker's clock is 8 s behind: its expiry check (expiredBefore = now) holds only ~9 s from now.
    const now = (): Date => new Date(Date.now() - 8_000);
    await withWorker({ spy, now }, async (worker) => {
      const handle = await signalWithStart(worker, cs.id);
      await expect(handle.result()).resolves.toEqual({ status: 'expired' });
    });
    // Expire at ~1 s, ~6 s and ~11 s; a busy loop would call it hundreds of times.
    expect(expireCalls).toBeGreaterThanOrEqual(2);
    expect(expireCalls).toBeLessThanOrEqual(4);
    expect(await record(cs.id)).toEqual({ status: 'expired' });
  }, 30_000);

  it('EXE-1 a waiting workflow runs the change-set once it is started and woken', async () => {
    const writer = new ScriptedWriter();
    const cs = await createPrepared(infra.repository, 2);
    await withWorker({ writer }, async (worker) => {
      const handle = await signalWithStart(worker, cs.id);
      await expect.poll(() => handle.query<WorkflowProgress>(PROGRESS_QUERY).then((p) => p.status)).toBe('prepared');
      await startExecutionOf(infra.repository, cs);
      await handle.signal(WAKE_SIGNAL);
      await expect(handle.result()).resolves.toEqual({ status: 'completed' });
    });
    expect(writer.batches).toEqual([['t-0001', 't-0002']]);
  });

  it('POL-6 a guard denial ends the run failed/policy_denied before any batch', async () => {
    const writer = new ScriptedWriter();
    const guard: ExecutionGuard = { check: () => Promise.resolve({ ok: false, outcome: 'policy_denied' }) };
    const cs = await createPrepared(infra.repository, 2, { execute: {} });
    await withWorker({ writer, guard }, async (worker) => {
      const handle = await signalWithStart(worker, cs.id);
      await expect(handle.result()).resolves.toEqual({ status: 'failed' });
    });
    expect(await record(cs.id)).toEqual({ status: 'failed', errorCode: 'policy_denied' });
    expect(writer.calls).toBe(0);
  });

  it('POL-6 the production guard lets a change-set of an allowed requester run', async () => {
    const writer = new ScriptedWriter();
    const cs = await createPrepared(infra.repository, 1, { execute: {} });
    await withWorker({ writer }, async (worker) => {
      const handle = await signalWithStart(worker, cs.id);
      await expect(handle.result()).resolves.toEqual({ status: 'completed' });
    });
  });
});
