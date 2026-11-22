// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Mandate Authors
/**
 * The verify-after stage of `changesetWorkflow` (EXE-12, ADR 0073) on a real Temporal test server
 * and PostgreSQL: after the last batch the workflow begins verification, waits on workflow timers
 * between looks, ends on nothing pending, the deadline or a cancel (EXE-7), survives a worker
 * restart, and continues as new after `MAX_LOOKS_PER_RUN` looks. The waits are real workflow timers
 * of the local test server (as the rollback-window and expiry tests); the tests wait on observable
 * state, never on the wall clock.
 */
import { randomUUID } from 'node:crypto';
import { PostgresNotificationOutbox } from '@mandate/db';
import { CHANGESET_WORKFLOW, WAKE_SIGNAL, type ChangesetWorkflowInput } from '@mandate/temporal';
import { ScriptedWriter } from '@mandate/testing';
import type { WorkflowHandle, WorkflowHandleWithSignaledRunId } from '@temporalio/client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { changesetWorkflow } from '../../src/workflows/changeset.js';
import { createPrepared } from '../support/changesets.js';
import { startInfrastructure, startTestWorker, type Infra, type TestWorker, type TestWorkerOptions } from '../support/harness.js';
import { auditEventsOf } from '../support/postgres.js';
import { LiveFromReader, VERIFY_CODE, withVerifyAfter, type VerifyTiming } from '../support/verification.js';

let infra: Infra;

beforeAll(async () => {
  infra = await startInfrastructure();
});

afterAll(async () => {
  await infra.close();
});

type History = Awaited<ReturnType<WorkflowHandle['fetchHistory']>>;

const VERIFY_PATCH = 'changeset-workflow-verify-after-20261122';
const VERIFICATION_ACTIVITIES = ['beginVerification', 'verifyBatch', 'finishVerification'];
/** Looks at 0, 10, ... 60 s: the deadline closes what is still pending. */
const TIMING: VerifyTiming = { afterSeconds: 0, everySeconds: 10, timeoutSeconds: 60 };
const submission = { actor: 'alice', groups: ['editors'], correlationId: 'corr-submit', at: new Date(), role: 'editor', rule: 'role:editor/grant:all' };

function signalWithStart(worker: TestWorker, changesetId: string): Promise<WorkflowHandleWithSignaledRunId<typeof changesetWorkflow>> {
  return infra.client.workflow.signalWithStart<typeof changesetWorkflow>(CHANGESET_WORKFLOW, {
    workflowId: changesetId,
    taskQueue: worker.taskQueue,
    args: [{ changesetId }],
    signal: WAKE_SIGNAL,
    signalArgs: [],
  });
}

async function withWorker<T>(opts: TestWorkerOptions, fn: (worker: TestWorker) => Promise<T>): Promise<T> {
  const worker = await startTestWorker(infra, opts);
  try {
    return await fn(worker);
  } finally {
    await worker.stop();
  }
}

async function load(changesetId: string) {
  const cs = await infra.repository.get(changesetId);
  if (cs === undefined) throw new Error('change-set not found');
  return cs;
}

async function verificationOf(changesetId: string) {
  return (await infra.repository.itemsPage(changesetId, { limit: 500 })).map((i) => [i.targetId, i.status, i.verificationStatus, i.verificationCode]);
}

const verifying = (timing: VerifyTiming, opts: { batchSize?: number } = {}) => withVerifyAfter(infra.configuration, timing, opts);

/** The activity types the history scheduled, in order. */
function activities(history: History): string[] {
  return (history.events ?? []).flatMap((e) => {
    const name = e.activityTaskScheduledEventAttributes?.activityType?.name;
    return name === undefined || name === null ? [] : [name];
  });
}

/** The patch IDs of the history's patch markers. */
function patchIds(history: History): string[] {
  return (history.events ?? []).flatMap((e) => {
    const data = e.markerRecordedEventAttributes?.details?.['patch-data']?.payloads?.[0]?.data;
    if (data === undefined || data === null) return [];
    return [(JSON.parse(Buffer.from(data).toString('utf8')) as { id: string }).id];
  });
}

/** True when the history's last event starts a timer after at least `looks` verifyBatch calls: parked in a wait. */
function waitingAfter(history: History, looks: number): boolean {
  return history.events?.at(-1)?.timerStartedEventAttributes != null && activities(history).filter((a) => a === 'verifyBatch').length >= looks;
}

async function parkedInWait(handle: WorkflowHandle, looks: number): Promise<void> {
  await expect.poll(async () => waitingAfter(await handle.fetchHistory(), looks), { timeout: 30_000 }).toBe(true);
}

describe('EXE-12 verify-after in changesetWorkflow', () => {
  it('EXE-12 EXE-6 a lookup that confirms from the second look on keeps the change-set executing, then completed', async () => {
    const reader = new LiveFromReader(2);
    const cs = await createPrepared(infra.repository, 2, { execute: {} });
    await withWorker({ reader, configuration: verifying(TIMING) }, async (worker) => {
      const handle = await signalWithStart(worker, cs.id);
      // After the last batch and the first look: still executing, both items pending with the check's code.
      await parkedInWait(handle, 1);
      const waiting = await load(cs.id);
      expect([waiting.status, waiting.stats.verification]).toEqual(['executing', { pending: 2, confirmed: 0, unconfirmed: 0 }]);
      await expect(handle.result()).resolves.toEqual({ status: 'completed' });
      expect(patchIds(await handle.fetchHistory())).toContain(VERIFY_PATCH);
    });
    expect(reader.reads).toBe(2);
    const done = await load(cs.id);
    expect(done.status).toBe('completed');
    expect(done.stats.verification).toEqual({ pending: 0, confirmed: 2, unconfirmed: 0 });
    const events = (await auditEventsOf(infra.database, cs.id)).filter((e) => e.action === 'changeset.verification');
    expect(events.map((e) => e.details)).toEqual([{ end: 'done', pending: 0, confirmed: 2, unconfirmed: 0, operation: cs.operation }]);
  }, 60_000);

  it('EXE-12 NTF-1 EXE-8 never confirmed: completed_with_errors at the deadline, notified once, rollback window open', async () => {
    const reader = new LiveFromReader(Infinity);
    const configuration = { ...verifying(TIMING), notify: new Map([['editor', { approvalRequests: [], results: ['chat'] }]]) };
    const cs = await createPrepared(infra.repository, 2, { execute: { submission } });
    await withWorker({ reader, configuration, settings: { rollbackWindowHours: 1 } }, async (worker) => {
      const handle = await signalWithStart(worker, cs.id);
      await expect
        .poll(async () => {
          const r = await load(cs.id);
          return [r.status, r.rollbackUntil !== undefined];
        }, { timeout: 100_000, interval: 1_000 })
        .toEqual(['completed_with_errors', true]);
      // Parked in the rollback window (its timer started); the case is over.
      await expect
        .poll(async () => {
          const history = await handle.fetchHistory();
          return activities(history).includes('openRollbackWindow') && history.events?.at(-1)?.timerStartedEventAttributes != null;
        }, { timeout: 30_000 })
        .toBe(true);
      await handle.terminate('test over');
    });
    expect(await verificationOf(cs.id)).toEqual([
      ['t-0001', 'written', 'unconfirmed', VERIFY_CODE],
      ['t-0002', 'written', 'unconfirmed', VERIFY_CODE],
    ]);
    // Looks at 0, 10, ... 60 s: seven, one read each (two items, one chunk).
    expect(reader.reads).toBe(7);
    const queued = await new PostgresNotificationOutbox(infra.database.db).listFor(cs.id);
    expect(queued.map((n) => [n.kind, n.target])).toEqual([['execution_finished', 'chat']]);
  }, 120_000);

  it('EXE-12 EXE-7 a cancel during the wait stops verification at the next look; the items give the status', async () => {
    const reader = new LiveFromReader(1);
    const writer = new ScriptedWriter();
    const cs = await createPrepared(infra.repository, 2, { execute: {} });
    // A ten-minute wait before the first look: only the wake can end it within the test.
    await withWorker({ reader, writer, configuration: verifying({ afterSeconds: 600, everySeconds: 10, timeoutSeconds: 600 }) }, async (worker) => {
      const handle = await signalWithStart(worker, cs.id);
      await parkedInWait(handle, 0);
      const cancelled = await worker.executor.cancel({ changesetId: cs.id, actor: 'bob', correlationId: 'corr-cancel' });
      expect(cancelled).toEqual({ ok: true, status: 'executing' });
      await expect(handle.result()).resolves.toEqual({ status: 'completed_with_errors' });
      expect(activities(await handle.fetchHistory()).filter((a) => a === 'verifyBatch')).toHaveLength(1);
    });
    expect(reader.reads).toBe(0);
    // Every write happened and stays: nothing un-written, nothing rolled back.
    expect(writer.batches).toEqual([['t-0001', 't-0002']]);
    expect(await verificationOf(cs.id)).toEqual([
      ['t-0001', 'written', 'unconfirmed', 'verify_cancelled'],
      ['t-0002', 'written', 'unconfirmed', 'verify_cancelled'],
    ]);
    const events = (await auditEventsOf(infra.database, cs.id)).filter((e) => e.action === 'changeset.verification');
    expect(events.map((e) => [e.actor, e.correlationId, e.details.end])).toEqual([['bob', 'corr-cancel', 'cancelled']]);
  }, 60_000);

  it('EXE-12 NFR-1 a worker shut down during the wait: a new worker finishes, deadline and look count unchanged', async () => {
    const reader = new LiveFromReader(2);
    const taskQueue = `test-${randomUUID()}`;
    const configuration = verifying(TIMING);
    const cs = await createPrepared(infra.repository, 2, { execute: {} });
    const first = await startTestWorker(infra, { reader, configuration, taskQueue });
    let handle: WorkflowHandle<typeof changesetWorkflow>;
    try {
      handle = await signalWithStart(first, cs.id);
      await parkedInWait(handle, 1);
    } finally {
      await first.stop();
    }
    const until = (await load(cs.id)).verificationUntil;
    expect(until).toBeDefined();
    const calls: string[] = [];
    await withWorker({ reader, configuration, taskQueue, spy: (a) => calls.push(a) }, async () => {
      await expect(handle.result()).resolves.toEqual({ status: 'completed' });
    });
    // One look before the restart, one after: what a single run makes.
    expect(reader.reads).toBe(2);
    expect(calls.filter((a) => a === 'verifyBatch')).toEqual(['verifyBatch']);
    const done = await load(cs.id);
    expect(done.verificationUntil).toEqual(until);
    expect(done.stats.verification).toEqual({ pending: 0, confirmed: 2, unconfirmed: 0 });
  }, 60_000);

  it('EXE-12 EXE-9 after MAX_LOOKS_PER_RUN looks the run continues as new and the next run finishes', async () => {
    const reader = new LiveFromReader(1);
    // Chunks of one item: 60 looks in the first round, 50 per run.
    const cs = await createPrepared(infra.repository, 60, { execute: {} });
    await withWorker({ reader, configuration: verifying(TIMING, { batchSize: 1 }) }, async (worker) => {
      const handle = await signalWithStart(worker, cs.id);
      await expect(handle.result()).resolves.toEqual({ status: 'completed' });
      const run1 = await infra.client.workflow.getHandle(cs.id, handle.signaledRunId).fetchHistory();
      const next = run1.events?.at(-1)?.workflowExecutionContinuedAsNewEventAttributes;
      expect(next?.newExecutionRunId).toBeTruthy();
      expect(activities(run1).filter((a) => a === 'verifyBatch')).toHaveLength(50);
      const run2 = await infra.client.workflow.getHandle(cs.id, next?.newExecutionRunId ?? undefined).fetchHistory();
      expect(run2.events?.at(-1)?.workflowExecutionCompletedEventAttributes).toBeTruthy();
      expect(activities(run2).filter((a) => a === 'verifyBatch')).toHaveLength(10);
    });
    expect(reader.reads).toBe(60);
    expect((await load(cs.id)).stats.verification).toEqual({ pending: 0, confirmed: 60, unconfirmed: 0 });
  }, 120_000);

  it('EXE-12 EXE-10 an operation without verify_after records no verify marker and no verification activity', async () => {
    const cs = await createPrepared(infra.repository, 3, { execute: {} });
    await withWorker({}, async (worker) => {
      const handle = await signalWithStart(worker, cs.id);
      await expect(handle.result()).resolves.toEqual({ status: 'completed' });
      const history = await handle.fetchHistory();
      expect(patchIds(history)).not.toContain(VERIFY_PATCH);
      expect(activities(history).filter((a) => VERIFICATION_ACTIVITIES.includes(a))).toEqual([]);
    });
    expect((await load(cs.id)).stats.verification).toBeUndefined();
  });

  describe('a continued run (resume.verificationRound) after verification began', () => {
    /** Runs to the first wait of verification, then ends that run as a continue-as-new would. */
    async function begunThenStopped(timing: VerifyTiming, looks: number): Promise<string> {
      const cs = await createPrepared(infra.repository, 2, { execute: {} });
      await withWorker({ reader: new LiveFromReader(Infinity), configuration: verifying(timing) }, async (worker) => {
        const handle = await signalWithStart(worker, cs.id);
        await parkedInWait(handle, looks);
        await handle.terminate('replaced by a continued run');
      });
      return cs.id;
    }

    function continued(worker: TestWorker, changesetId: string, verificationRound: number): Promise<WorkflowHandle<typeof changesetWorkflow>> {
      const input: ChangesetWorkflowInput = {
        changesetId,
        resume: { nextBatch: 1, counts: { done: 2, failed: 0, skipped: 0 }, verified: true, verificationRound },
      };
      return infra.client.workflow.start<typeof changesetWorkflow>(CHANGESET_WORKFLOW, { workflowId: changesetId, taskQueue: worker.taskQueue, args: [input] });
    }

    it('EXE-12 EXE-7 a cancel stored before the continued run still ends with the status the items give, not cancelled', async () => {
      const id = await begunThenStopped({ afterSeconds: 600, everySeconds: 10, timeoutSeconds: 600 }, 0);
      await infra.repository.requestCancel(id, { actor: 'bob', correlationId: 'corr-cancel', requestedAt: new Date() });
      await withWorker({ configuration: verifying(TIMING) }, async (worker) => {
        const handle = await continued(worker, id, 1);
        await expect(handle.result()).resolves.toEqual({ status: 'completed_with_errors' });
      });
      expect(await verificationOf(id)).toEqual([
        ['t-0001', 'written', 'unconfirmed', 'verify_cancelled'],
        ['t-0002', 'written', 'unconfirmed', 'verify_cancelled'],
      ]);
    }, 60_000);

    it('EXE-12 a verification that began is finished at its stored deadline after the operation lost verify_after', async () => {
      const id = await begunThenStopped({ afterSeconds: 0, everySeconds: 10, timeoutSeconds: 10 }, 1);
      const until = (await load(id)).verificationUntil;
      const reader = new LiveFromReader(1);
      await withWorker({ reader, configuration: infra.configuration }, async (worker) => {
        const handle = await continued(worker, id, 2);
        await expect(handle.result()).resolves.toEqual({ status: 'completed_with_errors' });
        expect(activities(await handle.fetchHistory())).toContain('finishVerification');
      });
      // Read nothing without the manifest's lookups; closed by the stored deadline.
      expect(reader.reads).toBe(0);
      expect((await load(id)).verificationUntil).toEqual(until);
      expect(await verificationOf(id)).toEqual([
        ['t-0001', 'written', 'unconfirmed', 'verify_read_failed'],
        ['t-0002', 'written', 'unconfirmed', 'verify_read_failed'],
      ]);
    }, 60_000);
  });
});
