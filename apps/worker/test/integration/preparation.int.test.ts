/**
 * Preparation and start through the Temporal adapters (EXE-1, EXE-11): `TemporalWorkflowStarter`
 * starts one workflow per change-set, which prepares it and waits; `TemporalExecutor.start`
 * wakes the waiting workflow, or marks the change-set failed when Temporal is unreachable.
 */
import { randomUUID } from 'node:crypto';
import { createChangeSet, ExecutorUnavailable, type ChangeSetRecord, type ReadPage, type UpstreamReader } from '@aiops/core';
import { clientDataConverter, parseTemporalKeys, TemporalExecutor } from '@aiops/temporal';
import { ScriptedWriter } from '@aiops/testing';
import { Client, Connection, WorkflowExecutionAlreadyStartedError } from '@temporalio/client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createPrepared } from '../support/changesets.js';
import { EDITOR_GROUP, WRITE_OPERATION } from '../support/configuration.js';
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

describe('preparation and start on Temporal', () => {
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
