/**
 * Durability of `changesetWorkflow` on a real Temporal test server and PostgreSQL: a worker that
 * dies mid-batch, two workers sharing a queue, and continue-as-new over a large change-set.
 */
import { CHANGESET_WORKFLOW, WAKE_SIGNAL } from '@aiops/temporal';
import { ScriptedWriter } from '@aiops/testing';
import type { WorkflowExecutionInfo, WorkflowHandle } from '@temporalio/client';
import { NativeConnection } from '@temporalio/worker';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { changesetWorkflow } from '../../src/workflows/changeset.js';
import { createPrepared, targetIds } from '../support/changesets.js';
import { startInfrastructure, startTestWorker, type Infra, type TestWorker } from '../support/harness.js';
import { auditEventsOf } from '../support/postgres.js';

let infra: Infra;
/** Connections of second workers, closed after the file. */
const connections: NativeConnection[] = [];

beforeAll(async () => {
  infra = await startInfrastructure();
});

afterAll(async () => {
  try {
    for (const c of connections) await c.close();
  } finally {
    await infra.close();
  }
});

/** A connection of its own, as another worker process has (Core allows one worker per queue per connection). */
async function ownConnection(): Promise<NativeConnection> {
  const connection = await NativeConnection.connect({ address: infra.env.address });
  connections.push(connection);
  return connection;
}

function signalWithStart(taskQueue: string, changesetId: string): Promise<WorkflowHandle<typeof changesetWorkflow>> {
  return infra.client.workflow.signalWithStart<typeof changesetWorkflow>(CHANGESET_WORKFLOW, {
    workflowId: changesetId,
    taskQueue,
    args: [{ changesetId }],
    signal: WAKE_SIGNAL,
    signalArgs: [],
  });
}

async function itemStatuses(changesetId: string): Promise<Record<string, string>> {
  const page = await infra.repository.itemsPage(changesetId, { limit: 500 });
  return Object.fromEntries(page.map((i) => [i.targetId, i.status]));
}

async function batchNumbers(changesetId: string): Promise<unknown[]> {
  const events = await auditEventsOf(infra.database, changesetId);
  return events.filter((e) => e.action === 'changeset.batch').map((e) => e.details.batchNo);
}

/** How often each target was submitted across the given writers. */
function submissions(...writers: ScriptedWriter[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const target of writers.flatMap((w) => w.batches.flat())) counts.set(target, (counts.get(target) ?? 0) + 1);
  return counts;
}

async function until<T>(read: () => Promise<T>, done: (value: T) => boolean, timeoutMs: number): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await read();
    if (done(value) || Date.now() > deadline) return value;
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
}

describe('changesetWorkflow durability', () => {
  it('EXE-3 NFR-2 a worker killed mid-batch: another worker finishes, no target written twice, none missing', async () => {
    const writerA = new ScriptedWriter();
    const paused = writerA.pauseAt(1);
    // Settles once A's held writeBatch call returns after the late release.
    let lateCallSettled: Promise<unknown> = Promise.resolve();
    const lateWriterA = {
      writeBatch: (input: Parameters<ScriptedWriter['writeBatch']>[0]) => {
        const call = writerA.writeBatch(input);
        lateCallSettled = call.catch(() => undefined);
        return call;
      },
    };
    const cs = await createPrepared(infra.repository, 6, { execute: {} });
    const a = await startTestWorker(infra, { writer: lateWriterA, shutdownForceTime: '1s', connection: await ownConnection() });
    let b: TestWorker | undefined;
    try {
      const handle = await signalWithStart(a.taskQueue, cs.id);
      // Batch 1's submission is recorded and its writer call is held open.
      await paused.reached;
      // Grace time 0: the held activity is cancelled at once and ignores it. After shutdownForceTime
      // run() fails with GracefulShutdownPeriodExpiredError (logged as "Worker failed"), and the
      // finalizeShutdown in its finally masks it with IllegalStateError, because the pending
      // activity still holds the Core worker. The activity is left running and never reported.
      const stopping = Date.now();
      await expect(a.stop()).rejects.toThrow(/Worker still in use/);
      expect(Date.now() - stopping).toBeGreaterThanOrEqual(900);

      const writerB = new ScriptedWriter();
      b = await startTestWorker(infra, { writer: writerB, taskQueue: a.taskQueue });
      await expect(handle.result()).resolves.toEqual({ status: 'completed' });

      const counts = submissions(writerA, writerB);
      expect([...counts.keys()].sort()).toEqual(targetIds(6));
      expect([...counts.values()].every((n) => n === 1)).toBe(true);
      // B resumed batch 1 from the stored submission: it submitted batch 2 only.
      expect(writerB.batches).toEqual([['t-0005', 't-0006']]);
      expect(writerB.calls).toBe(2);

      const itemsBefore = await itemStatuses(cs.id);
      expect(Object.values(itemsBefore).every((s) => s === 'written')).toBe(true);
      expect(await batchNumbers(cs.id)).toEqual([0, 1, 2]);

      // A's stale attempt finally returns: fenced by B's attempt, it changes nothing.
      paused.release();
      await lateCallSettled;
      await new Promise((resolve) => setTimeout(resolve, 1_000));
      expect(await itemStatuses(cs.id)).toEqual(itemsBefore);
      expect(await batchNumbers(cs.id)).toEqual([0, 1, 2]);
      expect((await infra.repository.get(cs.id))?.status).toBe('completed');
    } finally {
      paused.release();
      await b?.stop();
    }
  }, 60_000);

  it('NFR-4 two workers on one queue both execute activities and the result is complete', async () => {
    const counts = { first: 0, second: 0 };
    const writer = new ScriptedWriter();
    const cs = await createPrepared(infra.repository, 40, { execute: {} });
    // Eager activity dispatch (the SDK default, kept) hands each activity to the worker that
    // completed the workflow task scheduling it, and a cached workflow keeps its tasks on that
    // worker's sticky queue. Without a cache every workflow task, and so every activity, goes
    // through the shared queue to either worker, and each worker replays the other's history.
    const first = await startTestWorker(infra, { writer, maxCachedWorkflows: 0, spy: () => (counts.first += 1) });
    let second: TestWorker | undefined;
    try {
      second = await startTestWorker(infra, {
        writer,
        taskQueue: first.taskQueue,
        connection: await ownConnection(),
        maxCachedWorkflows: 0,
        spy: () => (counts.second += 1),
      });
      const handle = await signalWithStart(first.taskQueue, cs.id);
      await expect(handle.result()).resolves.toEqual({ status: 'completed' });
    } finally {
      await first.stop();
      await second?.stop();
    }
    expect(counts.first).toBeGreaterThan(0);
    expect(counts.second).toBeGreaterThan(0);
    const record = await infra.repository.get(cs.id);
    expect(record?.status).toBe('completed');
    expect(record?.stats.written).toBe(40);
  }, 60_000);

  it('EXE-9 NFR-7 a 500-item change-set with items_per_workflow_run 100 continues as new and completes', async () => {
    const writer = new ScriptedWriter();
    const cs = await createPrepared(infra.repository, 500, { execute: {} });
    const worker = await startTestWorker(infra, { writer, settings: { batchSize: 50, itemsPerRun: 100 } });
    try {
      const handle = await signalWithStart(worker.taskQueue, cs.id);
      await expect(handle.result()).resolves.toEqual({ status: 'completed' });
    } finally {
      await worker.stop();
    }
    const record = await infra.repository.get(cs.id);
    expect(record?.status).toBe('completed');
    expect(record?.stats.written).toBe(500);
    const counts = submissions(writer);
    expect([...counts.keys()].sort()).toEqual(targetIds(500));
    expect([...counts.values()].every((n) => n === 1)).toBe(true);
    expect(Math.max(...writer.batches.map((b) => b.length))).toBeLessThanOrEqual(50);

    // Visibility is eventually consistent: wait for all five runs to be listed.
    const runs = await until(
      async () => {
        const listed: WorkflowExecutionInfo[] = [];
        for await (const execution of infra.client.workflow.list({ query: `WorkflowId = '${cs.id}'` })) listed.push(execution);
        return listed;
      },
      (listed) => listed.length >= 5,
      10_000,
    );
    expect(runs).toHaveLength(5);
    expect(runs.filter((r) => r.status.name === 'CONTINUED_AS_NEW')).toHaveLength(4);
    expect(runs.filter((r) => r.status.name === 'COMPLETED')).toHaveLength(1);
  }, 120_000);
});
