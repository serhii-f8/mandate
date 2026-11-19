/**
 * The executor contract (EXE-11) against `TemporalExecutor`: the same cases as the in-memory
 * executor, run through `changesetWorkflow` on a real worker. The contract's change-sets carry a
 * fixed hash and no configuration, so the worker uses the allow-all guard (ADR 0027). The rollback
 * request's full path needs a configured operation and a real hash, so it is a TemporalExecutor-only
 * case below (ruling T10/F1).
 */
import { randomUUID } from 'node:crypto';
import { createServer } from 'node:net';
import { EMPTY_STATS, ExecutorUnavailable, type AuditEventInput, type ChangeSetRecord } from '@aiops/core';
import { clientDataConverter, parseTemporalKeys, TemporalExecutor } from '@aiops/temporal';
import { allowAllGuard, describeExecutorContract, EXECUTOR_CONTRACT_HASH, ScriptedWriter } from '@aiops/testing';
import { Client, Connection } from '@temporalio/client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createPrepared, targetIds } from '../support/changesets.js';
import { startInfrastructure, startTestWorker, TEST_SETTINGS, type Infra, type TestWorker } from '../support/harness.js';
import { TEST_TEMPORAL_KEYS } from '../support/keys.js';

let infra: Infra;

beforeAll(async () => {
  infra = await startInfrastructure();
});

afterAll(async () => {
  await infra.close();
});

interface AuditRow {
  readonly id: string;
  readonly actor: string;
  readonly clientId: string | null;
  readonly action: AuditEventInput['action'];
  readonly subject: string | null;
  readonly outcome: AuditEventInput['outcome'];
  readonly correlationId: string;
  readonly changesetId: string | null;
  readonly details: AuditEventInput['details'];
}

async function allAuditEvents(): Promise<AuditEventInput[]> {
  const result = await infra.database.pool.query<AuditRow>(
    `SELECT id, actor, client_id AS "clientId", action, subject, outcome, correlation_id AS "correlationId",
            changeset_id AS "changesetId", details
       FROM audit_event ORDER BY seq`,
  );
  return result.rows.map((r) => ({
    id: r.id,
    actor: r.actor,
    ...(r.clientId === null ? {} : { clientId: r.clientId }),
    action: r.action,
    ...(r.subject === null ? {} : { subject: r.subject }),
    outcome: r.outcome,
    correlationId: r.correlationId,
    ...(r.changesetId === null ? {} : { changesetId: r.changesetId }),
    details: r.details,
  }));
}

function event(changesetId: string, details: AuditEventInput['details'] = {}): AuditEventInput {
  return {
    id: randomUUID(),
    actor: 'system',
    action: 'changeset.transition',
    outcome: 'ok',
    correlationId: 'corr-prep',
    changesetId,
    details,
  };
}

// One database and Temporal environment for the file; one worker, task queue and writer per case.
describeExecutorContract('temporal', async () => {
  const { repository } = infra;
  const writer = new ScriptedWriter();
  const settings = { batchSize: 2, failureThreshold: 0.5, itemsPerRun: TEST_SETTINGS.itemsPerRun };
  const worker = await startTestWorker(infra, { writer, guard: allowAllGuard, settings });
  const prepared = async (items: number, opts: { expiresAt?: Date; requester?: string } = {}): Promise<ChangeSetRecord> => {
    const id = randomUUID();
    const now = new Date();
    await repository.create(
      {
        id,
        operation: 'catalog.update',
        connection: 'shop',
        requester: opts.requester ?? 'alice',
        args: {},
        configHash: 'cfg',
        correlationId: 'corr-prep',
        createdAt: now,
        expiresAt: opts.expiresAt ?? new Date(now.getTime() + 86_400_000),
      },
      event(id),
    );
    await repository.appendItems(
      id,
      Array.from({ length: items }, (_, i) => ({
        targetId: `t-${String(i + 1).padStart(4, '0')}`,
        status: 'pending' as const,
        before: { v: 1 },
        after: { v: 2 },
      })),
    );
    const stats = { ...EMPTY_STATS, ...(await repository.stats(id)) };
    const record = await repository.completePreparation(
      id,
      { status: 'prepared', hash: EXECUTOR_CONTRACT_HASH, stats, preparedAt: now },
      event(id, { from: 'preparing', to: 'prepared' }),
    );
    if (record === undefined) throw new Error('preparation failed');
    return record;
  };
  return {
    executor: worker.executor,
    repository,
    writer,
    batchSize: settings.batchSize,
    failureThreshold: settings.failureThreshold,
    prepared,
    auditEvents: allAuditEvents,
    close: () => worker.stop(),
  };
});

describe('EXE-8 TemporalExecutor rollback request', () => {
  /** A window of one hour: the workflow waits for a request after execution. */
  const WINDOW = { rollbackWindowHours: 1 };
  const request = (executor: TemporalExecutor, changesetId: string, count: number) =>
    executor.requestRollback({ changesetId, actor: 'alice', clientId: 'cl-alice', correlationId: 'corr-rollback', count });
  const auditOf = async (changesetId: string) => (await allAuditEvents()).filter((e) => e.changesetId === changesetId);

  /** A change-set of the configured write operation (real hash), executed to `completed` through the worker. */
  async function executed(worker: TestWorker, items: number, windowOpens: boolean): Promise<ChangeSetRecord> {
    const cs = await createPrepared(infra.repository, items);
    if (cs.hash === undefined) throw new Error('test change-set has no hash');
    expect(await worker.executor.start({ changesetId: cs.id, expectedHash: cs.hash, actor: 'alice', correlationId: 'corr-exec' })).toEqual({
      ok: true,
    });
    // Waits on stored state, never on `settled`: with a window the workflow stays open for an hour.
    await expect
      .poll(async () => {
        const record = await infra.repository.get(cs.id);
        return [record?.status, record?.rollbackUntil !== undefined];
      }, { timeout: 30_000 })
      .toEqual(['completed', windowOpens]);
    return cs;
  }

  /** A port nothing listens on. */
  async function closedPort(): Promise<number> {
    const server = createServer();
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    await new Promise<void>((resolve) => server.close(() => {
      resolve();
    }));
    if (address === null || typeof address === 'string') throw new Error('no port');
    return address.port;
  }

  it('EXE-8 EXE-11 a request on a completed change-set ends rolled_back with every written item restored', async () => {
    const rollbackWriter = new ScriptedWriter();
    const worker = await startTestWorker(infra, { rollbackWriter, guard: allowAllGuard, settings: WINDOW });
    try {
      const cs = await executed(worker, 3, true);
      expect(await request(worker.executor, cs.id, 3)).toEqual({ ok: true, status: 'rolling_back' });
      await expect.poll(async () => (await infra.repository.get(cs.id))?.status, { timeout: 30_000 }).toBe('rolled_back');
      await worker.executor.settled(cs.id);
      const record = await infra.repository.get(cs.id);
      expect(record?.stats.rollback).toEqual({ restored: 3, skipped: 0, failed: 0 });
      expect(record?.rollbackRequest).toMatchObject({ actor: 'alice', clientId: 'cl-alice', correlationId: 'corr-rollback' });
      const items = await infra.repository.itemsPage(cs.id, { limit: 10 });
      expect(items.map((i) => [i.targetId, i.rollbackStatus])).toEqual(targetIds(3).map((t) => [t, 'restored']));
      expect(rollbackWriter.batches.flat()).toEqual(targetIds(3));
      const requested = (await auditOf(cs.id)).filter((e) => e.action === 'changeset.rollback' || e.details.to === 'rolling_back');
      expect(requested.map((e) => [e.action, e.actor, e.correlationId])).toEqual([
        ['changeset.transition', 'alice', 'corr-rollback'],
        ['changeset.rollback', 'alice', 'corr-rollback'],
      ]);
      expect(requested[1]?.details).toEqual({ channel: 'page', count: 3 });
    } finally {
      await worker.stop();
    }
  });

  it('EXE-8 an unreachable Temporal throws ExecutorUnavailable before any state change', async () => {
    const worker = await startTestWorker(infra, { guard: allowAllGuard, settings: WINDOW });
    // No retry interceptor: the connection error surfaces at once instead of after the default retries.
    const unreachable = new Client({
      connection: Connection.lazy({ address: `127.0.0.1:${String(await closedPort())}`, interceptors: [] }),
      namespace: 'default',
      dataConverter: clientDataConverter(parseTemporalKeys(TEST_TEMPORAL_KEYS)),
    });
    const executor = new TemporalExecutor({
      client: unreachable,
      taskQueue: worker.taskQueue,
      repository: infra.repository,
      newId: randomUUID,
      now: () => new Date(),
    });
    try {
      const cs = await executed(worker, 2, true);
      const before = await auditOf(cs.id);
      await expect(request(executor, cs.id, 2)).rejects.toBeInstanceOf(ExecutorUnavailable);
      const record = await infra.repository.get(cs.id);
      expect(record?.status).toBe('completed');
      expect(record?.rollbackRequest).toBeUndefined();
      expect(await auditOf(cs.id)).toHaveLength(before.length);
      // Nothing was stored, so the same request through a reachable Temporal still succeeds.
      expect(await request(worker.executor, cs.id, 2)).toEqual({ ok: true, status: 'rolling_back' });
      await expect.poll(async () => (await infra.repository.get(cs.id))?.status, { timeout: 30_000 }).toBe('rolled_back');
    } finally {
      await unreachable.connection.close();
      await worker.stop();
    }
  });

  it('EXE-8 a signal that finds the workflow closed fails the rollback with rollback_workflow_closed', async () => {
    // The run closes between describe and signal: the client's describe answers the real RUNNING description,
    // then terminates the run before the executor goes on.
    const worker = await startTestWorker(infra, { guard: allowAllGuard, settings: WINDOW });
    const racing = new Client({
      connection: infra.env.connection,
      namespace: 'default',
      dataConverter: clientDataConverter(parseTemporalKeys(TEST_TEMPORAL_KEYS)),
      interceptors: {
        workflow: [
          {
            async describe(input, next) {
              const raw = await next(input);
              await infra.client.workflow.getHandle(input.workflowExecution.workflowId).terminate('test: closes before the wake');
              return raw;
            },
          },
        ],
      },
    });
    const executor = new TemporalExecutor({ client: racing, taskQueue: worker.taskQueue, repository: infra.repository, newId: randomUUID, now: () => new Date() });
    try {
      const cs = await executed(worker, 2, true);
      expect(await request(executor, cs.id, 2)).toEqual({ ok: true, status: 'failed' });
      expect((await infra.client.workflow.getHandle(cs.id).describe()).status.name).toBe('TERMINATED');
      const record = await infra.repository.get(cs.id);
      expect(record?.status).toBe('failed');
      expect(record?.errorCode).toBe('rollback_workflow_closed');
      // The request stays stored: a failed rollback is never retried.
      expect(record?.rollbackRequest).toBeDefined();
      const transitions = (await auditOf(cs.id))
        .filter((e) => e.action === 'changeset.transition')
        .map((e) => [e.actor, e.details.from, e.details.to, e.details.errorCode]);
      expect(transitions.slice(-2)).toEqual([
        ['alice', 'completed', 'rolling_back', undefined],
        ['system', 'rolling_back', 'failed', 'rollback_workflow_closed'],
      ]);
    } finally {
      await worker.stop();
    }
  });
});
