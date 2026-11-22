// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Mandate Authors
/**
 * The automatic start of the next plan step (EXE-13, ADR 0074) on a real Temporal test server and
 * PostgreSQL: a step whose workflow ends `completed` starts the next step when that one is
 * `approved`, through the same executor start the approver uses, with actor `system` and the next
 * step's requester identity; anything else leaves the next step waiting. Behind
 * `patched('changeset-workflow-plan-advance-20261122')`, reached only by a change-set in a plan
 * (EXE-10). The tests wait on observable state (history, database), never on the wall clock.
 */
import { CHANGESET_WORKFLOW, WAKE_SIGNAL } from '@mandate/temporal';
import { ScriptedWriter } from '@mandate/testing';
import type { WorkflowHandle } from '@temporalio/client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { changesetWorkflow } from '../../src/workflows/changeset.js';
import { createPrepared } from '../support/changesets.js';
import { APPROVING_GROUP } from '../support/configuration.js';
import { startInfrastructure, startTestWorker, type Infra, type TestWorker, type TestWorkerOptions } from '../support/harness.js';
import { approved, approvedPlan, approverStart, PLAN_REQUESTER } from '../support/plans.js';
import { auditEventsOf } from '../support/postgres.js';
import { LiveFromReader, withVerifyAfter } from '../support/verification.js';

let infra: Infra;

beforeAll(async () => {
  infra = await startInfrastructure();
});

afterAll(async () => {
  await infra.close();
});

type History = Awaited<ReturnType<WorkflowHandle['fetchHistory']>>;

const PLAN_PATCH = 'changeset-workflow-plan-advance-20261122';

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

function handleOf(changesetId: string): WorkflowHandle<typeof changesetWorkflow> {
  return infra.client.workflow.getHandle<typeof changesetWorkflow>(changesetId);
}

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

async function statusEventually(changesetId: string, status: string, timeout = 30_000): Promise<void> {
  await expect.poll(async () => (await load(changesetId)).status, { timeout }).toBe(status);
}

describe('EXE-13 plan advance', () => {
  it('EXE-13 EXE-10 POL-6 a completed step starts the approved next one as system with the requester identity; both completed', async () => {
    const { steps } = await approvedPlan(infra.repository, [2, 3]);
    const [first, second] = steps;
    if (first === undefined || second === undefined) throw new Error('two steps expected');
    await withWorker({}, async (worker) => {
      await expect(worker.executor.start(approverStart(first, 'corr-plan-exec'))).resolves.toEqual({ ok: true });
      await expect(handleOf(first.id).result()).resolves.toEqual({ status: 'completed' });
      await statusEventually(second.id, 'completed');
      await expect(handleOf(second.id).result()).resolves.toEqual({ status: 'completed' });
      const history = await handleOf(first.id).fetchHistory();
      expect(patchIds(history)).toContain(PLAN_PATCH);
      expect(activities(history)).toEqual(['inspect', 'beginExecution', 'executeBatch', 'finishExecution', 'advancePlan', 'openRollbackWindow']);
      // The last step advances to nothing: the marker and the activity, no start.
      expect(activities(await handleOf(second.id).fetchHistory())).toContain('advancePlan');
    });
    const next = await load(second.id);
    expect(next.executionRequest).toMatchObject({ actor: PLAN_REQUESTER.subject, groups: [APPROVING_GROUP], correlationId: 'corr-plan-exec' });
    expect(next.stats.written).toBe(3);
    const started = (await auditEventsOf(infra.database, second.id)).filter(
      (e) => e.action === 'changeset.transition' && e.details.to === 'executing',
    );
    expect(started.map((e) => [e.actor, e.details.from, e.correlationId])).toEqual([['system', 'approved', 'corr-plan-exec']]);
  }, 60_000);

  it('EXE-13 a step that ends completed_with_errors leaves the next step approved and calls no advancePlan', async () => {
    const writer = new ScriptedWriter({ outcomes: { 't-0001': 'failed' } });
    const { steps } = await approvedPlan(infra.repository, [4, 1]);
    const [first, second] = steps;
    if (first === undefined || second === undefined) throw new Error('two steps expected');
    await withWorker({ writer }, async (worker) => {
      await expect(worker.executor.start(approverStart(first))).resolves.toEqual({ ok: true });
      await expect(handleOf(first.id).result()).resolves.toEqual({ status: 'completed_with_errors' });
      const history = await handleOf(first.id).fetchHistory();
      expect(activities(history)).not.toContain('advancePlan');
      expect(patchIds(history)).not.toContain(PLAN_PATCH);
    });
    expect((await load(second.id)).status).toBe('approved');
  }, 60_000);

  it('EXE-13 a next step that is only prepared is not started; approved afterwards, the approver start runs it', async () => {
    const { steps } = await approvedPlan(infra.repository, [1, 2], [true, false]);
    const [first, second] = steps;
    if (first === undefined || second === undefined) throw new Error('two steps expected');
    await withWorker({}, async (worker) => {
      await expect(worker.executor.start(approverStart(first))).resolves.toEqual({ ok: true });
      await expect(handleOf(first.id).result()).resolves.toEqual({ status: 'completed' });
      expect(activities(await handleOf(first.id).fetchHistory())).toContain('advancePlan');
      expect((await load(second.id)).status).toBe('prepared');
      const decided = await approved(infra.repository, await load(second.id));
      await expect(worker.executor.start(approverStart(decided, 'corr-later'))).resolves.toEqual({ ok: true });
      await expect(handleOf(second.id).result()).resolves.toEqual({ status: 'completed' });
    });
    const started = (await auditEventsOf(infra.database, second.id)).filter(
      (e) => e.action === 'changeset.transition' && e.details.to === 'executing',
    );
    expect(started.map((e) => [e.actor, e.correlationId])).toEqual([['rita', 'corr-later']]);
  }, 60_000);

  it('EXE-13 POL-4 a next step over its role limit stays approved with one limit denial; the finished step settles normally', async () => {
    // submitChangeSet stores the role `writer`; its limit allows one record, the next step has two.
    const configuration = { ...infra.configuration, limits: new Map([['writer', { records_per_operation: 1 }]]) };
    const { steps } = await approvedPlan(infra.repository, [1, 2]);
    const [first, second] = steps;
    if (first === undefined || second === undefined) throw new Error('two steps expected');
    await withWorker({ configuration, settings: { rollbackWindowHours: 15 / 3600 } }, async (worker) => {
      await expect(worker.executor.start(approverStart(first))).resolves.toEqual({ ok: true });
      await expect(handleOf(first.id).result()).resolves.toEqual({ status: 'completed' });
      const history = await handleOf(first.id).fetchHistory();
      // After the advance, the rollback window opened and its timer closed the run.
      expect(activities(history).slice(-3)).toEqual(['advancePlan', 'openRollbackWindow', 'inspect']);
      expect(history.events?.some((e) => e.timerFiredEventAttributes != null)).toBe(true);
    });
    expect((await load(second.id)).status).toBe('approved');
    const denials = (await auditEventsOf(infra.database, second.id)).filter((e) => e.action === 'policy.decision');
    expect(denials.map((e) => [e.actor, e.decision, e.details.reason, e.details.rule])).toEqual([
      [PLAN_REQUESTER.subject, 'deny', 'limit_exceeded', 'role:writer/limit:records_per_operation'],
    ]);
  }, 60_000);

  it('EXE-13 an advancePlan that fails every attempt does not fail the step: it settles completed, the next step stays approved', async () => {
    let attempts = 0;
    const advanceExecutor = {
      start: () => {
        attempts += 1;
        return Promise.reject(new Error('start broke'));
      },
    };
    const { steps } = await approvedPlan(infra.repository, [1, 1]);
    const [first, second] = steps;
    if (first === undefined || second === undefined) throw new Error('two steps expected');
    await withWorker({ advanceExecutor }, async (worker) => {
      await expect(worker.executor.start(approverStart(first))).resolves.toEqual({ ok: true });
      await expect(handleOf(first.id).result()).resolves.toEqual({ status: 'completed' });
      const history = await handleOf(first.id).fetchHistory();
      expect(history.events?.some((e) => e.activityTaskFailedEventAttributes != null)).toBe(true);
      expect(activities(history).slice(-2)).toEqual(['advancePlan', 'openRollbackWindow']);
    });
    // The slow activities' bounded retries (PREPARE_MAX_ATTEMPTS).
    expect(attempts).toBe(5);
    expect((await load(second.id)).status).toBe('approved');
  }, 60_000);

  it('EXE-13 EXE-12 with verify_after on the step, the next step starts only after verification confirmed', async () => {
    // Confirmed at the second look, 10 s after the first; the next step's own look then confirms at once.
    const reader = new LiveFromReader(2);
    const configuration = withVerifyAfter(infra.configuration, { afterSeconds: 0, everySeconds: 10, timeoutSeconds: 60 });
    const { steps } = await approvedPlan(infra.repository, [1, 1]);
    const [first, second] = steps;
    if (first === undefined || second === undefined) throw new Error('two steps expected');
    await withWorker({ reader, configuration }, async (worker) => {
      await expect(worker.executor.start(approverStart(first))).resolves.toEqual({ ok: true });
      // Parked in the wait after the first look: written, not yet verified; the next step waits.
      await expect
        .poll(async () => {
          const history = await handleOf(first.id).fetchHistory();
          return history.events?.at(-1)?.timerStartedEventAttributes != null && activities(history).includes('verifyBatch');
        }, { timeout: 30_000 })
        .toBe(true);
      expect((await load(first.id)).status).toBe('executing');
      expect((await load(second.id)).status).toBe('approved');
      await expect(handleOf(first.id).result()).resolves.toEqual({ status: 'completed' });
      await statusEventually(second.id, 'completed');
    });
    const firstEvents = await auditEventsOf(infra.database, first.id);
    expect(firstEvents.filter((e) => e.action === 'changeset.verification').map((e) => e.details.end)).toEqual(['done']);
  }, 60_000);

  it('EXE-13 EXE-10 a change-set outside a plan records no plan marker and calls no advancePlan', async () => {
    const cs = await createPrepared(infra.repository, 2, { execute: {} });
    await withWorker({}, async (worker) => {
      const handle = await infra.client.workflow.signalWithStart<typeof changesetWorkflow>(CHANGESET_WORKFLOW, {
        workflowId: cs.id,
        taskQueue: worker.taskQueue,
        args: [{ changesetId: cs.id }],
        signal: WAKE_SIGNAL,
        signalArgs: [],
      });
      await expect(handle.result()).resolves.toEqual({ status: 'completed' });
      const history = await handle.fetchHistory();
      expect(patchIds(history)).not.toContain(PLAN_PATCH);
      expect(activities(history)).not.toContain('advancePlan');
    });
  }, 60_000);
});
