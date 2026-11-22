// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Mandate Authors
/**
 * Preparation and start through the Temporal adapters (EXE-1, EXE-11): `TemporalWorkflowStarter`
 * starts one workflow per change-set, which prepares it and waits; `TemporalExecutor.start`
 * wakes the waiting workflow, or marks the change-set failed when Temporal is unreachable.
 */
import { randomUUID } from 'node:crypto';
import { createChangeSet, ExecutorUnavailable, type ChangeSetRecord, type ReadPage, type UpstreamReader } from '@mandate/core';
import { clientDataConverter, parseTemporalKeys, TemporalExecutor } from '@mandate/temporal';
import { ScriptedWriter } from '@mandate/testing';
import { Client, Connection, WorkflowExecutionAlreadyStartedError } from '@temporalio/client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createPrepared } from '../support/changesets.js';
import { EDITOR_GROUP, OPAQUE_OPERATION, WRITE_OPERATION } from '../support/configuration.js';
import { startInfrastructure, startTestWorker, type Infra, type TestWorker } from '../support/harness.js';
import { TEST_TEMPORAL_KEYS } from '../support/keys.js';

let infra: Infra;

beforeAll(async () => {
  infra = await startInfrastructure();
});

afterAll(async () => {
  await infra.close();
});

/** Reads answer every requested SKU with brand `acme`. */
class CatalogReader implements UpstreamReader {
  read(_operationId: string, args: Readonly<Record<string, unknown>>): Promise<ReadPage> {
    const skus = Array.isArray(args.skus) ? (args.skus as string[]) : [];
    return Promise.resolve({ ok: true, items: skus.map((sku) => ({ sku, brand: 'acme', name: `old ${sku}` })), truncated: false });
  }
}

async function withWorker<T>(opts: Parameters<typeof startTestWorker>[1], fn: (worker: TestWorker) => Promise<T>): Promise<T> {
  const worker = await startTestWorker(infra, opts);
  try {
    return await fn(worker);
  } finally {
    await worker.stop();
  }
}

/** Creates a change-set in `preparing` as the api does, under the current configuration's hash. */
async function created(skus: readonly string[]): Promise<ChangeSetRecord> {
  const operation = infra.configuration.policy.operations.find((o) => o.id === WRITE_OPERATION);
  const manifest = operation?.manifest;
  if (operation === undefined || manifest === undefined) throw new Error('test operation missing');
  const result = await createChangeSet(
    { repository: infra.repository, newId: randomUUID, now: () => new Date() },
    {
      operation: { ...operation, manifest },
      args: { brand: 'acme', skus, changes: { name: 'new' } },
      caller: { subject: 'alice', groups: [EDITOR_GROUP] },
      correlationId: 'corr-create',
      configHash: infra.configuration.hash,
      expireAfterHours: 1,
    },
  );
  if (!result.ok) throw new Error(`test change-set not created: ${result.code}`);
  return result.changeset;
}

const statusOf = async (id: string) => (await infra.repository.get(id))?.status;

/** Counts every read; an opaque preparation must make none (CS-1). */
class SpyReader implements UpstreamReader {
  reads = 0;
  read(): Promise<ReadPage> {
    this.reads += 1;
    return Promise.reject(new Error('an opaque preparation reads nothing'));
  }
}

describe('preparation and start on Temporal', () => {
  it('CS-1 the prepare activity stores one call item for an opaque operation and reads nothing', async () => {
    const operation = infra.configuration.policy.operations.find((o) => o.id === OPAQUE_OPERATION);
    if (operation === undefined) throw new Error('test operation missing');
    const result = await createChangeSet(
      { repository: infra.repository, newId: randomUUID, now: () => new Date() },
      {
        operation,
        args: { note: 'restock the blue mugs' },
        caller: { subject: 'alice', groups: [EDITOR_GROUP] },
        correlationId: 'corr-create-opaque',
        configHash: infra.configuration.hash,
        expireAfterHours: 1,
      },
    );
    if (!result.ok) throw new Error(`test change-set not created: ${result.code}`);
    const cs = result.changeset;
    const reader = new SpyReader();
    let readerFactoryCalls = 0;
    await withWorker(
      {
        readerFor: () => {
          readerFactoryCalls += 1;
          return reader;
        },
      },
      async (worker) => {
        await worker.starter.start(cs.id);
        await expect.poll(() => statusOf(cs.id), { timeout: 20_000 }).toBe('prepared');
        await worker.executor.cancel({ changesetId: cs.id, actor: 'alice', correlationId: 'corr-cleanup' });
        await worker.executor.settled(cs.id);
      },
    );
    expect(reader.reads).toBe(0);
    expect(readerFactoryCalls).toBe(0);
    expect(await infra.repository.itemsPage(cs.id, { limit: 10 })).toEqual([
      expect.objectContaining({ targetId: 'call', status: 'pending', before: null, after: { note: 'restock the blue mugs' } }),
    ]);
    const record = await infra.repository.get(cs.id);
    expect(record?.stats).toMatchObject({ total: 1, included: 1 });
    expect(record?.hash).toMatch(/^sha256:[0-9a-f]{64}$/);
  });

  it('EXE-1 a created change-set is prepared by its workflow, which then waits', async () => {
    const cs = await created(['t-0001', 't-0002', 't-0003']);
    await withWorker({ reader: new CatalogReader() }, async (worker) => {
      await worker.starter.start(cs.id);
      await expect.poll(() => statusOf(cs.id), { timeout: 20_000 }).toBe('prepared');
      const description = await infra.client.workflow.getHandle(cs.id).describe();
      expect(description.status.name).toBe('RUNNING');
      await worker.executor.cancel({ changesetId: cs.id, actor: 'alice', correlationId: 'corr-cleanup' });
      await worker.executor.settled(cs.id);
    });
  });

  it('EXE-1 the same change-set ID cannot start a second workflow, also after the first closed', async () => {
    const cs = await created(['t-0001']);
    await withWorker({ reader: new CatalogReader() }, async (worker) => {
      await worker.starter.start(cs.id);
      await expect(worker.starter.start(cs.id)).rejects.toBeInstanceOf(WorkflowExecutionAlreadyStartedError);
      await expect.poll(() => statusOf(cs.id), { timeout: 20_000 }).toBe('prepared');
      expect(await worker.executor.cancel({ changesetId: cs.id, actor: 'bob', correlationId: 'corr-cancel' })).toEqual({
        ok: true,
        status: 'cancelled',
      });
      await worker.executor.settled(cs.id);
      const description = await infra.client.workflow.getHandle(cs.id).describe();
      expect(description.status.name).toBe('COMPLETED');
      await expect(worker.starter.start(cs.id)).rejects.toBeInstanceOf(WorkflowExecutionAlreadyStartedError);
    });
  });

  it('EXE-11 start of a change-set prepared by its workflow signals the waiting workflow and completes', async () => {
    const cs = await created(['t-0001', 't-0002', 't-0003']);
    const writer = new ScriptedWriter();
    await withWorker({ reader: new CatalogReader(), writer }, async (worker) => {
      await worker.starter.start(cs.id);
      await expect.poll(() => statusOf(cs.id), { timeout: 20_000 }).toBe('prepared');
      const prepared = await infra.repository.get(cs.id);
      if (prepared?.hash === undefined) throw new Error('prepared change-set has no hash');
      expect(
        await worker.executor.start({
          changesetId: cs.id,
          expectedHash: prepared.hash,
          actor: 'alice',
          groups: [EDITOR_GROUP],
          correlationId: 'corr-exec',
        }),
      ).toEqual({ ok: true });
      await worker.executor.settled(cs.id);
      // One workflow from preparation to the end: the start signalled it instead of starting another.
      const description = await infra.client.workflow.getHandle(cs.id).describe();
      expect(description.status.name).toBe('COMPLETED');
    });
    expect(await statusOf(cs.id)).toBe('completed');
    expect(writer.batches).toEqual([['t-0001', 't-0002'], ['t-0003']]);
  });

  it('EXE-11 a start without a reachable Temporal marks the change-set failed/executor_unavailable', async () => {
    const cs = await createPrepared(infra.repository, 2);
    if (cs.hash === undefined) throw new Error('prepared change-set has no hash');
    const connection = await Connection.connect({ address: infra.env.address });
    await connection.close();
    const executor = new TemporalExecutor({
      client: new Client({ connection, namespace: 'default', dataConverter: clientDataConverter(parseTemporalKeys(TEST_TEMPORAL_KEYS)) }),
      taskQueue: `test-${randomUUID()}`,
      repository: infra.repository,
      newId: randomUUID,
      now: () => new Date(),
    });
    await expect(
      executor.start({ changesetId: cs.id, expectedHash: cs.hash, actor: 'alice', groups: [EDITOR_GROUP], correlationId: 'corr-exec' }),
    ).rejects.toBeInstanceOf(ExecutorUnavailable);
    const record = await infra.repository.get(cs.id);
    expect(record?.status).toBe('failed');
    expect(record?.errorCode).toBe('executor_unavailable');
  });

  /** A client whose signalWithStart reaches Temporal, optionally waits, and then reports a failure (a lost response). */
  function lostResponseClient(after?: (workflowId: string) => Promise<unknown>): Client {
    const client = new Client({
      connection: infra.env.connection,
      namespace: 'default',
      dataConverter: clientDataConverter(parseTemporalKeys(TEST_TEMPORAL_KEYS)),
    });
    const real = client.workflow.signalWithStart.bind(client.workflow);
    client.workflow.signalWithStart = (async (...args: Parameters<typeof real>) => {
      const handle = await real(...args);
      await after?.(handle.workflowId);
      throw new Error('DEADLINE_EXCEEDED');
    }) as typeof real;
    return client;
  }

  function executorOn(client: Client, worker: TestWorker): TemporalExecutor {
    return new TemporalExecutor({ client, taskQueue: worker.taskQueue, repository: infra.repository, newId: randomUUID, now: () => new Date() });
  }

  it('EXE-11 a start whose signalWithStart response is lost while the run is live answers ok and the run completes', async () => {
    const cs = await createPrepared(infra.repository, 3);
    if (cs.hash === undefined) throw new Error('prepared change-set has no hash');
    const writer = new ScriptedWriter();
    const pause = writer.pauseAt(0);
    await withWorker({ writer }, async (worker) => {
      const executor = executorOn(lostResponseClient(), worker);
      expect(
        await executor.start({ changesetId: cs.id, expectedHash: cs.hash ?? '', actor: 'alice', groups: [EDITOR_GROUP], correlationId: 'corr-exec' }),
      ).toEqual({ ok: true });
      await pause.reached;
      expect(await statusOf(cs.id)).toBe('executing');
      pause.release();
      await executor.settled(cs.id);
    });
    const record = await infra.repository.get(cs.id);
    expect(record?.status).toBe('completed');
    expect(record?.errorCode).toBeUndefined();
  });

  /**
   * Wraps every handle the client hands out: describe() fails when `blind` (Temporal cannot be
   * asked), and the wake signals sent through handles are counted.
   */
  function watchHandles(client: Client, blind: boolean): { signals: () => number } {
    let signals = 0;
    const real = client.workflow.getHandle.bind(client.workflow);
    client.workflow.getHandle = ((...args: Parameters<typeof real>) => {
      const handle = real(...args);
      const signal = handle.signal.bind(handle);
      return Object.assign(Object.create(handle) as typeof handle, {
        describe: blind ? () => Promise.reject(new Error('UNAVAILABLE')) : handle.describe.bind(handle),
        signal: (...signalArgs: Parameters<typeof signal>) => {
          signals += 1;
          return signal(...signalArgs);
        },
      });
    }) as typeof real;
    return { signals: () => signals };
  }

  it('AUD-1 EXE-11 a lost start response with Temporal unable to describe the run does not fail a run that already claimed a batch', async () => {
    const cs = await createPrepared(infra.repository, 3);
    const writer = new ScriptedWriter();
    const pause = writer.pauseAt(0);
    await withWorker({ writer }, async (worker) => {
      // The response is lost only after the run claimed batch 0 and is writing it.
      const client = lostResponseClient(() => pause.reached);
      watchHandles(client, true);
      const executor = executorOn(client, worker);
      let started: unknown;
      try {
        started = await executor.start({ changesetId: cs.id, expectedHash: cs.hash ?? '', actor: 'alice', groups: [EDITOR_GROUP], correlationId: 'corr-exec' });
        expect(await statusOf(cs.id)).toBe('executing');
      } finally {
        pause.release();
      }
      expect(started).toEqual({ ok: true });
      await infra.client.workflow.getHandle(cs.id).result();
    });
    const record = await infra.repository.get(cs.id);
    expect(record?.status).toBe('completed');
    expect(record?.errorCode).toBeUndefined();
    expect(writer.batches).toEqual([['t-0001', 't-0002'], ['t-0003']]);
  });

  it('EXE-11 a lost start response with Temporal unable to describe the run and no batch claimed fails executor_unavailable', async () => {
    const cs = await createPrepared(infra.repository, 2);
    // No worker polls this task queue: the started workflow never runs, so no batch is claimed.
    const client = lostResponseClient();
    watchHandles(client, true);
    const executor = new TemporalExecutor({ client, taskQueue: `idle-${randomUUID()}`, repository: infra.repository, newId: randomUUID, now: () => new Date() });
    await expect(
      executor.start({ changesetId: cs.id, expectedHash: cs.hash ?? '', actor: 'alice', groups: [EDITOR_GROUP], correlationId: 'corr-exec' }),
    ).rejects.toBeInstanceOf(ExecutorUnavailable);
    await infra.client.workflow.getHandle(cs.id).terminate('cleanup');
    expect(await infra.repository.get(cs.id)).toMatchObject({ status: 'failed', errorCode: 'executor_unavailable' });
  });

  it('EXE-11 a start whose signalWithStart response is lost while the run is live sends the wake once more', async () => {
    const cs = await createPrepared(infra.repository, 2);
    const writer = new ScriptedWriter();
    const pause = writer.pauseAt(0);
    await withWorker({ writer }, async (worker) => {
      const client = lostResponseClient();
      const watched = watchHandles(client, false);
      const executor = executorOn(client, worker);
      let started: unknown;
      try {
        started = await executor.start({ changesetId: cs.id, expectedHash: cs.hash ?? '', actor: 'alice', groups: [EDITOR_GROUP], correlationId: 'corr-exec' });
      } finally {
        pause.release();
      }
      expect(started).toEqual({ ok: true });
      expect(watched.signals()).toBe(1);
      await executor.settled(cs.id);
    });
    expect(await statusOf(cs.id)).toBe('completed');
  });

  it('EXE-11 a start whose run already finished when the lost response is noticed answers ok from the record', async () => {
    const cs = await createPrepared(infra.repository, 2);
    await withWorker({}, async (worker) => {
      const waitForRun = (id: string) => infra.client.workflow.getHandle(id).result();
      const executor = executorOn(lostResponseClient(waitForRun), worker);
      expect(
        await executor.start({ changesetId: cs.id, expectedHash: cs.hash ?? '', actor: 'alice', groups: [EDITOR_GROUP], correlationId: 'corr-exec' }),
      ).toEqual({ ok: true });
    });
    const record = await infra.repository.get(cs.id);
    expect(record?.status).toBe('completed');
    expect(record?.errorCode).toBeUndefined();
  });

  it('EXE-1 EXE-11 a start whose workflow ID is already closed marks the change-set failed/workflow_closed', async () => {
    const cs = await createPrepared(infra.repository, 2);
    const writer = new ScriptedWriter();
    await withWorker({ writer }, async (worker) => {
      await worker.starter.start(cs.id);
      const handle = infra.client.workflow.getHandle(cs.id);
      await handle.terminate('test');
      await expect(
        worker.executor.start({ changesetId: cs.id, expectedHash: cs.hash ?? '', actor: 'alice', groups: [EDITOR_GROUP], correlationId: 'corr-exec' }),
      ).rejects.toBeInstanceOf(ExecutorUnavailable);
    });
    const record = await infra.repository.get(cs.id);
    expect(record?.status).toBe('failed');
    expect(record?.errorCode).toBe('workflow_closed');
    expect(writer.calls).toBe(0);
  });
});
