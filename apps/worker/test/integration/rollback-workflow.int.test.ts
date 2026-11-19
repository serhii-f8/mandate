/**
 * The rollback window and compensation of `changesetWorkflow` (EXE-8, ADR 0042) on a real Temporal
 * test server and PostgreSQL: after a finished status the workflow keeps a window open, a stored
 * request plus a wake runs the rollback in fenced batches, and the window timer closes it. Until
 * Task 10 the executor's request is stood in for by `repository.requestRollback` plus `wake`.
 */
import { randomUUID } from 'node:crypto';
import { createOpenApiAdapter } from '@aiops/adapters';
import type { LoadedConfiguration } from '@aiops/config';
import { createChangeSet, ROLLBACK_REQUEST_MARGIN_MS, type BatchContext, type ChangeItemRecord, type ChangeSetRecord, type ItemOutcome } from '@aiops/core';
import { CHANGESET_WORKFLOW, WAKE_SIGNAL } from '@aiops/temporal';
import { installFakeMagentoCatalog, ScriptedWriter, startFakeUpstream, type FakeMagentoCatalog, type FakeUpstream } from '@aiops/testing';
import { createUpstreamReader } from '@aiops/upstream';
import type { WorkflowHandle } from '@temporalio/client';
import { NativeConnection } from '@temporalio/worker';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { changesetWorkflow } from '../../src/workflows/changeset.js';
import { createRollbackWriterFor, createWriterFor } from '../../src/writers.js';
import { createPrepared, targetIds } from '../support/changesets.js';
import { startInfrastructure, startTestWorker, type Infra, type TestWorker } from '../support/harness.js';
import { loadMagentoPreset, MAGENTO_BASE_PATH, vaultWithToken } from '../support/magento.js';

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

/** A window of one hour: the workflow waits for a request unless a case says otherwise. */
const WINDOW = { rollbackWindowHours: 1 };

function signalWithStart(taskQueue: string, changesetId: string): Promise<WorkflowHandle<typeof changesetWorkflow>> {
  return infra.client.workflow.signalWithStart<typeof changesetWorkflow>(CHANGESET_WORKFLOW, {
    workflowId: changesetId,
    taskQueue,
    args: [{ changesetId }],
    signal: WAKE_SIGNAL,
    signalArgs: [],
  });
}

async function load(changesetId: string): Promise<ChangeSetRecord> {
  const cs = await infra.repository.get(changesetId);
  if (cs === undefined) throw new Error('change-set not found');
  return cs;
}

/** Waits until execution has finished with `status` and the window is open (observable state). */
async function windowOpen(changesetId: string, status = 'completed'): Promise<void> {
  await expect
    .poll(async () => {
      const cs = await load(changesetId);
      return [cs.status, cs.rollbackUntil !== undefined];
    }, { timeout: 30_000 })
    .toEqual([status, true]);
}

/** Stores a rollback request and wakes the workflow, as the executor's request will (Task 10). */
async function requestRollback(worker: TestWorker, changesetId: string): Promise<void> {
  const requested = await infra.repository.requestRollback({
    changesetId,
    request: { actor: 'alice', correlationId: `corr-rollback-${randomUUID()}`, requestedAt: new Date() },
    marginMs: ROLLBACK_REQUEST_MARGIN_MS,
    audit: [],
  });
  expect(requested.ok).toBe(true);
  await worker.executor.wake(changesetId);
}

async function itemsOf(changesetId: string): Promise<readonly ChangeItemRecord[]> {
  return infra.repository.itemsPage(changesetId, { limit: 500 });
}

/** A scripted writer that also keeps every item it was given. */
class RecordingWriter extends ScriptedWriter {
  readonly seen: ChangeItemRecord[] = [];

  override async writeBatch(input: { changeset: ChangeSetRecord; items: readonly ChangeItemRecord[]; batch: BatchContext }): Promise<readonly ItemOutcome[]> {
    this.seen.push(...input.items);
    return super.writeBatch(input);
  }
}

/** How often each target was submitted across the given writers. */
function submissions(...writers: ScriptedWriter[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const target of writers.flatMap((w) => w.batches.flat())) counts.set(target, (counts.get(target) ?? 0) + 1);
  return counts;
}

describe('EXE-8 changesetWorkflow rollback window and compensation', () => {
  it('EXE-8 a completed change-set rolled back restores every written item and ends rolled_back', async () => {
    const rollbackWriter = new RecordingWriter();
    const cs = await createPrepared(infra.repository, 4, { execute: {} });
    const worker = await startTestWorker(infra, { rollbackWriter, settings: WINDOW });
    try {
      const handle = await signalWithStart(worker.taskQueue, cs.id);
      await windowOpen(cs.id);
      await requestRollback(worker, cs.id);
      await expect(handle.result()).resolves.toEqual({ status: 'rolled_back' });
    } finally {
      await worker.stop();
    }
    const record = await load(cs.id);
    expect(record.status).toBe('rolled_back');
    expect(record.stats.rollback).toEqual({ restored: 4, skipped: 0, failed: 0 });
    const items = await itemsOf(cs.id);
    expect(items.map((i) => [i.targetId, i.rollbackStatus])).toEqual(targetIds(4).map((t) => [t, 'restored']));
    // The rollback writer got the stored items with their stored before and after.
    const stored = items.map((i) => ({ targetId: i.targetId, before: i.before, after: i.after }));
    expect(rollbackWriter.seen.map((i) => ({ targetId: i.targetId, before: i.before, after: i.after }))).toEqual(stored);
    expect(stored[0]).toEqual({ targetId: 't-0001', before: { name: 'old t-0001' }, after: { name: 'new' } });
  });

  it('EXE-8 EXE-7 a cancelled run rolls back the items it wrote', async () => {
    const writer = new ScriptedWriter();
    const paused = writer.pauseAt(0);
    const rollbackWriter = new ScriptedWriter();
    const cs = await createPrepared(infra.repository, 4, { execute: {} });
    const worker = await startTestWorker(infra, { writer, rollbackWriter, settings: WINDOW });
    try {
      const handle = await signalWithStart(worker.taskQueue, cs.id);
      await paused.reached;
      const stored = await infra.repository.requestCancel(cs.id, { actor: 'bob', correlationId: 'corr-cancel', requestedAt: new Date() });
      expect(stored.ok).toBe(true);
      paused.release();
      await windowOpen(cs.id, 'cancelled');
      await requestRollback(worker, cs.id);
      await expect(handle.result()).resolves.toEqual({ status: 'rolled_back' });
    } finally {
      paused.release();
      await worker.stop();
    }
    expect(rollbackWriter.batches).toEqual([['t-0001', 't-0002']]);
    expect((await itemsOf(cs.id)).map((i) => [i.targetId, i.status, i.rollbackStatus])).toEqual([
      ['t-0001', 'written', 'restored'],
      ['t-0002', 'written', 'restored'],
      ['t-0003', 'pending', undefined],
      ['t-0004', 'pending', undefined],
    ]);
    expect((await load(cs.id)).stats.rollback).toEqual({ restored: 2, skipped: 0, failed: 0 });
  });

  it('EXE-8 the window timer closes the workflow without a rollback', async () => {
    const cs = await createPrepared(infra.repository, 2, { execute: {} });
    const worker = await startTestWorker(infra, { settings: { rollbackWindowHours: 15 / 3600 } });
    try {
      const handle = await signalWithStart(worker.taskQueue, cs.id);
      await expect(handle.result()).resolves.toEqual({ status: 'completed' });
      expect((await handle.describe()).status.name).toBe('COMPLETED');
    } finally {
      await worker.stop();
    }
    const record = await load(cs.id);
    expect(record.status).toBe('completed');
    expect(record.rollbackUntil?.getTime()).toBeLessThanOrEqual(Date.now());
    // Secondary: the request path refuses once the window is closed (with a 15 s window it always does).
    await expect(
      infra.repository.requestRollback({
        changesetId: cs.id,
        request: { actor: 'alice', correlationId: 'corr-late', requestedAt: new Date() },
        marginMs: ROLLBACK_REQUEST_MARGIN_MS,
        audit: [],
      }),
    ).resolves.toEqual({ ok: false, reason: 'window_closed' });
  }, 60_000);

  it('EXE-8 a window of 0 hours closes the workflow at once', async () => {
    const cs = await createPrepared(infra.repository, 2, { execute: {} });
    const worker = await startTestWorker(infra, { settings: { rollbackWindowHours: 0 } });
    try {
      const handle = await signalWithStart(worker.taskQueue, cs.id);
      await expect(handle.result()).resolves.toEqual({ status: 'completed' });
    } finally {
      await worker.stop();
    }
    expect((await load(cs.id)).rollbackUntil).toBeUndefined();
  });

  it('EXE-8 NFR-2 a rollback batch failing every attempt ends failed with rollback_writer_error', async () => {
    const rollbackWriter = new ScriptedWriter();
    rollbackWriter.throwAt(0);
    const cs = await createPrepared(infra.repository, 2, { execute: {} });
    const worker = await startTestWorker(infra, { rollbackWriter, settings: WINDOW });
    try {
      const handle = await signalWithStart(worker.taskQueue, cs.id);
      await windowOpen(cs.id);
      await requestRollback(worker, cs.id);
      await expect(handle.result()).resolves.toEqual({ status: 'failed' });
    } finally {
      await worker.stop();
    }
    const record = await load(cs.id);
    expect([record.status, record.errorCode]).toEqual(['failed', 'rollback_writer_error']);
    // Every one of the three attempts (FAST_TUNING.batchMaxAttempts) reached the writer.
    expect(rollbackWriter.calls).toBe(3);
    expect((await itemsOf(cs.id)).map((i) => i.rollbackStatus)).toEqual([undefined, undefined]);
  });

  it('EXE-8 EXE-9 NFR-7 a rollback continues as new after itemsPerRun items', async () => {
    const rollbackWriter = new ScriptedWriter();
    const activities: string[] = [];
    const cs = await createPrepared(infra.repository, 6, { execute: {} });
    const worker = await startTestWorker(infra, {
      rollbackWriter,
      settings: { ...WINDOW, batchSize: 2, itemsPerRun: 4 },
      spy: (a) => activities.push(a),
    });
    try {
      const handle = await signalWithStart(worker.taskQueue, cs.id);
      await windowOpen(cs.id);
      await requestRollback(worker, cs.id);
      await expect(handle.result()).resolves.toEqual({ status: 'rolled_back' });
    } finally {
      await worker.stop();
    }
    // Two rollback batches in the first rollback run, then a new run resumes at batch 3.
    const rollback = activities.slice(activities.indexOf('beginRollback'));
    expect(rollback).toEqual(['beginRollback', 'rollbackBatch', 'rollbackBatch', 'inspect', 'beginRollback', 'rollbackBatch', 'finishRollback']);
    // The latest run is the second rollback run: its first activities are inspect, beginRollback.
    const events = (await infra.client.workflow.getHandle(cs.id).fetchHistory()).events ?? [];
    const scheduled = events.flatMap((e) => {
      const name = e.activityTaskScheduledEventAttributes?.activityType?.name;
      return name === undefined || name === null ? [] : [name];
    });
    expect(scheduled).toEqual(['inspect', 'beginRollback', 'rollbackBatch', 'finishRollback']);
    expect(rollbackWriter.batches).toEqual([
      ['t-0001', 't-0002'],
      ['t-0003', 't-0004'],
      ['t-0005', 't-0006'],
    ]);
    const counts = submissions(rollbackWriter);
    expect([...counts.values()].every((n) => n === 1)).toBe(true);
    expect((await load(cs.id)).stats.rollback).toEqual({ restored: 6, skipped: 0, failed: 0 });
  }, 60_000);

  it('EXE-8 NFR-1 a worker stopped during a rollback batch resumes without a second upstream submit', async () => {
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
    const a = await startTestWorker(infra, {
      rollbackWriter: lateWriterA,
      settings: WINDOW,
      shutdownForceTime: '1s',
      connection: await ownConnection(),
    });
    let b: TestWorker | undefined;
    try {
      const handle = await signalWithStart(a.taskQueue, cs.id);
      await windowOpen(cs.id);
      await requestRollback(a, cs.id);
      // Rollback batch 2's submission is recorded and its writer call is held open.
      await paused.reached;
      // As in durability.int.test.ts: the held activity keeps the Core worker, so stop() rejects.
      await expect(a.stop()).rejects.toThrow(/Worker still in use/);

      const writerB = new ScriptedWriter();
      b = await startTestWorker(infra, { rollbackWriter: writerB, settings: WINDOW, taskQueue: a.taskQueue });
      await expect(handle.result()).resolves.toEqual({ status: 'rolled_back' });

      // One submit per batch across both workers; B resumed batch 2 from the stored submission.
      expect(writerA.batches).toEqual([
        ['t-0001', 't-0002'],
        ['t-0003', 't-0004'],
      ]);
      expect(writerB.batches).toEqual([['t-0005', 't-0006']]);
      expect(writerB.calls).toBe(2);
      const counts = submissions(writerA, writerB);
      expect([...counts.keys()].sort()).toEqual(targetIds(6));
      expect([...counts.values()].every((n) => n === 1)).toBe(true);
      const restored = (await itemsOf(cs.id)).map((i) => i.rollbackStatus);
      expect(restored).toEqual(Array(6).fill('restored'));

      // A's stale attempt finally returns: fenced by B's attempt, it changes nothing.
      paused.release();
      await lateCallSettled;
      expect((await itemsOf(cs.id)).map((i) => i.rollbackStatus)).toEqual(restored);
      expect((await load(cs.id)).status).toBe('rolled_back');
    } finally {
      paused.release();
      // Already stopped (rejected) on the happy path; stops it when the case failed earlier.
      await a.stop().catch(() => undefined);
      await b?.stop();
    }
  }, 60_000);

  it('EXE-8 a wake while the window is open re-inspects and keeps waiting', async () => {
    let inspects = 0;
    const cs = await createPrepared(infra.repository, 2, { execute: {} });
    const worker = await startTestWorker(infra, {
      settings: WINDOW,
      spy: (a) => {
        if (a === 'inspect') inspects += 1;
      },
    });
    try {
      const handle = await signalWithStart(worker.taskQueue, cs.id);
      await windowOpen(cs.id);
      const before = inspects;
      await worker.executor.wake(cs.id);
      await expect.poll(() => inspects, { timeout: 10_000 }).toBeGreaterThan(before);
      expect((await handle.describe()).status.name).toBe('RUNNING');
      expect((await load(cs.id)).status).toBe('completed');
      await handle.terminate('test cleanup');
    } finally {
      await worker.stop();
    }
  });
});

/** A connection of its own, as another worker process has (Core allows one worker per queue per connection). */
async function ownConnection(): Promise<NativeConnection> {
  const connection = await NativeConnection.connect({ address: infra.env.address });
  connections.push(connection);
  return connection;
}

const OPERATION = 'catalog.update_content';
const EDITOR_GROUP = 'editors';
const FAKE_TOKEN = 'rollback-workflow-test-only-token';
const ROLES = `version: 1
roles:
  - id: editor
    grants:
      - operation: catalog.update_content
        scope: { brand: [acme] }
    approval: { required: never }
role_mapping:
  - group: editors
    roles: [editor]
`;

describe('EXE-8 CS-7 rollback through the production writers', () => {
  let up: FakeUpstream;
  let catalog: FakeMagentoCatalog;
  let configuration: LoadedConfiguration;
  let worker: TestWorker;

  beforeEach(async () => {
    up = await startFakeUpstream();
    catalog = installFakeMagentoCatalog(up, {
      basePath: MAGENTO_BASE_PATH,
      products: ['ACME-001', 'ACME-002', 'ACME-003'].map((sku) => ({ sku, name: `Product ${sku}`, status: 1, brand: 'acme', description: 'old' })),
    });
    configuration = await loadMagentoPreset(`${up.url}${MAGENTO_BASE_PATH}`, [{ file: 'roles.yaml', text: ROLES }]);
    const vault = await vaultWithToken(FAKE_TOKEN);
    const adapter = createOpenApiAdapter();
    worker = await startTestWorker(infra, {
      configuration,
      writerFor: createWriterFor({ vault, adapter }),
      rollbackWriterFor: createRollbackWriterFor({ vault, adapter }),
      readerFor: (current, correlationId) => createUpstreamReader({ configuration: current, vault, adapter, correlationId }),
      settings: { ...WINDOW, batchSize: 100 },
    });
  });

  afterEach(async () => {
    await worker.stop();
    await up.close();
  });

  it('EXE-8 CS-7 drifted items are skipped and already_applied items are untouched', async () => {
    const operation = configuration.policy.operations.find((o) => o.id === OPERATION);
    const manifest = operation?.manifest;
    if (operation === undefined || manifest === undefined) throw new Error('preset operation missing');
    const created = await createChangeSet(
      { repository: infra.repository, newId: randomUUID, now: () => new Date() },
      {
        operation: { ...operation, manifest },
        args: { brand: 'acme', skus: ['ACME-001', 'ACME-002', 'ACME-003'], changes: { description: 'new' } },
        caller: { subject: 'alice', groups: [EDITOR_GROUP] },
        correlationId: `corr-create-${randomUUID()}`,
        configHash: configuration.hash,
        expireAfterHours: 1,
      },
    );
    if (!created.ok) throw new Error(`change-set not created: ${created.code}`);
    const { id } = created.changeset;
    await worker.starter.start(id);
    await expect.poll(async () => (await load(id)).status, { timeout: 30_000 }).toBe('prepared');
    const hash = (await load(id)).hash;
    if (hash === undefined) throw new Error('prepared change-set has no hash');

    catalog.set('ACME-002', { description: 'new' }); // already at `after` before execution
    expect(
      await worker.executor.start({ changesetId: id, expectedHash: hash, actor: 'alice', groups: [EDITOR_GROUP], correlationId: `corr-exec-${randomUUID()}` }),
    ).toEqual({ ok: true });
    await windowOpen(id);
    expect((await itemsOf(id)).map((i) => [i.targetId, i.status, i.error])).toEqual([
      ['ACME-001', 'written', undefined],
      ['ACME-002', 'written', 'already_applied'],
      ['ACME-003', 'written', undefined],
    ]);

    catalog.set('ACME-003', { description: 'edited elsewhere' }); // changed upstream after execution
    await requestRollback(worker, id);
    await expect(infra.client.workflow.getHandle(id).result()).resolves.toEqual({ status: 'rolled_back' });

    expect(catalog.product('ACME-001')).toMatchObject({ description: 'old' });
    expect(catalog.product('ACME-002')).toMatchObject({ description: 'new' });
    expect(catalog.product('ACME-003')).toMatchObject({ description: 'edited elsewhere' });
    expect((await itemsOf(id)).map((i) => [i.targetId, i.rollbackStatus, i.rollbackError])).toEqual([
      ['ACME-001', 'restored', undefined],
      ['ACME-002', undefined, undefined],
      ['ACME-003', 'skipped', 'drift'],
    ]);
    // The rollback submitted only the item it restores.
    expect(catalog.submissions.map((s) => s.skus)).toEqual([['ACME-001', 'ACME-003'], ['ACME-001']]);
    expect((await load(id)).stats.rollback).toEqual({ restored: 1, skipped: 1, failed: 0 });
  }, 60_000);
});
