/**
 * Records `changesetWorkflow` history fixtures for the replay gate (ADR 0006, EXE-10):
 *   pnpm --filter @aiops/worker record-history <scenario>
 * Runs the scenario with the CURRENT code on the Temporal test server and a Testcontainers
 * PostgreSQL (the integration harness), with payloads encrypted under the fixed test key
 * (TEST_TEMPORAL_KEYS, never a real key), and writes
 * test/workflow-histories/changesetWorkflow/<name>.json. Existing files are never overwritten:
 * fixtures are not regenerated to make a replay pass (`--force` only when a patch is removed).
 * smokeWorkflow's plaintext fixture predates the codec and is never re-recorded.
 */
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  BatchFenced,
  type ChangeSetRecord,
  type ExecutionGuard,
  type ItemOutcome,
  type ReadPage,
  type UpstreamReader,
} from '@aiops/core';
import { CHANGESET_WORKFLOW, PROGRESS_QUERY, WAKE_SIGNAL, type WorkflowProgress } from '@aiops/temporal';
import { recordApproval, ScriptedWriter, submitChangeSet } from '@aiops/testing';
import type { WorkflowHandle, WorkflowHandleWithSignaledRunId } from '@temporalio/client';
import { historyToJSON } from '@temporalio/common/lib/proto-utils';
import type { changesetWorkflow } from '../src/workflows/changeset.js';
import { createPrepared } from '../test/support/changesets.js';
import { APPROVING_GROUP, EDITOR_GROUP, REVIEWER_GROUP } from '../test/support/configuration.js';
import { created, preparedByWorkflow, statusOf, waitFor, waitForWorkflowStatus } from '../test/support/prepared-by-workflow.js';
import { startInfrastructure, startTestWorker, type Infra, type TestWorker, type TestWorkerOptions } from '../test/support/harness.js';

type History = Awaited<ReturnType<WorkflowHandle['fetchHistory']>>;
type Recorded = Readonly<Record<string, History>>;

interface Scenario {
  /** Fixture names this scenario writes (without `.json`). */
  readonly files: readonly string[];
  run(infra: Infra): Promise<Recorded>;
}

const outDir = fileURLToPath(new URL('../test/workflow-histories/changesetWorkflow/', import.meta.url));

/** Reads answer every requested SKU with brand `acme`. */
const catalogReader: UpstreamReader = {
  read(_operationId, args): Promise<ReadPage> {
    const skus = Array.isArray(args.skus) ? args.skus.filter((s): s is string => typeof s === 'string') : [];
    return Promise.resolve({ ok: true, items: skus.map((sku) => ({ sku, brand: 'acme', name: `old ${sku}` })), truncated: false });
  },
};

/**
 * Temporal identity of the recording client and worker. The SDK default (`<pid>@<hostname>`)
 * would put the recording machine's name into the committed histories (identities and sticky
 * task queue names); identity is not replay-relevant.
 */
const RECORDER_IDENTITY = 'aiops-recorder';

async function withWorker<T>(infra: Infra, opts: TestWorkerOptions, fn: (worker: TestWorker) => Promise<T>): Promise<T> {
  const worker = await startTestWorker(infra, { ...opts, identity: RECORDER_IDENTITY });
  try {
    return await fn(worker);
  } finally {
    await worker.stop();
  }
}

/** Starts (or wakes) the change-set's workflow, as the Temporal executor's start does. */
function signalWithStart(infra: Infra, worker: TestWorker, changesetId: string): Promise<WorkflowHandleWithSignaledRunId<typeof changesetWorkflow>> {
  return infra.client.workflow.signalWithStart<typeof changesetWorkflow>(CHANGESET_WORKFLOW, {
    workflowId: changesetId,
    taskQueue: worker.taskQueue,
    args: [{ changesetId }],
    signal: WAKE_SIGNAL,
    signalArgs: [],
  });
}

/** Submits for the one `reviewer` step of `approving_editor` and wakes the waiting workflow. */
async function submitted(infra: Infra, worker: TestWorker, cs: ChangeSetRecord): Promise<ChangeSetRecord> {
  const pending = await submitChangeSet(infra.repository, cs, { steps: ['reviewer'], groups: [APPROVING_GROUP] });
  await worker.executor.wake(cs.id);
  return pending;
}

async function expectResult(handle: WorkflowHandle<typeof changesetWorkflow>, status: string): Promise<void> {
  const result = await handle.result();
  if (result.status !== status) throw new Error(`expected ${status}, got ${result.status}`);
}

/** Runs an executing change-set to its end and returns its single run's history. */
async function executeToEnd(infra: Infra, opts: TestWorkerOptions, items: number, status: string): Promise<History> {
  const cs = await createPrepared(infra.repository, items, { execute: {} });
  return withWorker(infra, opts, async (worker) => {
    const handle = await signalWithStart(infra, worker, cs.id);
    await expectResult(handle, status);
    return handle.fetchHistory();
  });
}

const SCENARIOS: Readonly<Record<string, Scenario>> = {
  /** Prepared by its workflow, parked at the wake condition (history fetched while it waits). */
  'parked-prepared': {
    files: ['parked-prepared'],
    run: (infra) =>
      withWorker(infra, { reader: catalogReader }, async (worker) => {
        const cs = await preparedByWorkflow(infra, worker, ['t-0001', 't-0002']);
        const history = await infra.client.workflow.getHandle(cs.id).fetchHistory();
        await worker.executor.cancel({ changesetId: cs.id, actor: 'alice', correlationId: 'corr-cleanup' });
        await worker.executor.settled(cs.id);
        return { 'parked-prepared': history };
      }),
  },

  /** The whole lifecycle: prepare, wait, start and wake, two batches, done. */
  completed: {
    files: ['completed'],
    run: (infra) =>
      withWorker(infra, { reader: catalogReader }, async (worker) => {
        const cs = await preparedByWorkflow(infra, worker, ['t-0001', 't-0002', 't-0003']);
        const prepared = await infra.repository.get(cs.id);
        if (prepared?.hash === undefined) throw new Error('prepared change-set has no hash');
        const started = await worker.executor.start({
          changesetId: cs.id,
          expectedHash: prepared.hash,
          actor: 'alice',
          groups: [EDITOR_GROUP],
          correlationId: 'corr-exec',
        });
        if (!started.ok) throw new Error(`start refused: ${started.reason}`);
        const handle = infra.client.workflow.getHandle<typeof changesetWorkflow>(cs.id);
        await expectResult(handle, 'completed');
        return { completed: await handle.fetchHistory() };
      }),
  },

  /** 200 items, batch 50, 100 items per run: two runs, one fixture each (EXE-9). */
  'completed-continued': {
    files: ['completed-continued-run1', 'completed-continued-run2'],
    async run(infra) {
      const cs = await createPrepared(infra.repository, 200, { execute: {} });
      return withWorker(infra, { settings: { batchSize: 50, itemsPerRun: 100 } }, async (worker) => {
        const handle = await signalWithStart(infra, worker, cs.id);
        await expectResult(handle, 'completed');
        // signalWithStart started this workflow, so the signalled run is the first one.
        const run1 = await infra.client.workflow.getHandle(cs.id, handle.signaledRunId).fetchHistory();
        const next = run1.events?.at(-1)?.workflowExecutionContinuedAsNewEventAttributes?.newExecutionRunId;
        if (next === undefined || next === null) throw new Error('first run did not continue as new');
        const run2 = await infra.client.workflow.getHandle(cs.id, next).fetchHistory();
        const last = run2.events?.at(-1);
        if (last?.workflowExecutionCompletedEventAttributes === undefined || last.workflowExecutionCompletedEventAttributes === null) {
          throw new Error('second run did not complete (more than two runs?)');
        }
        return { 'completed-continued-run1': run1, 'completed-continued-run2': run2 };
      });
    },
  },

  /** A cancel stored while batch 0 is in flight ends the run after that batch (EXE-7). */
  'cancelled-during-execution': {
    files: ['cancelled-during-execution'],
    async run(infra) {
      const writer = new ScriptedWriter();
      const paused = writer.pauseAt(0);
      const cs = await createPrepared(infra.repository, 4, { execute: {} });
      return withWorker(infra, { writer }, async (worker) => {
        const handle = await signalWithStart(infra, worker, cs.id);
        await paused.reached;
        const stored = await infra.repository.requestCancel(cs.id, { actor: 'bob', correlationId: 'corr-cancel', requestedAt: new Date() });
        if (!stored.ok) throw new Error('cancel not stored');
        paused.release();
        await expectResult(handle, 'cancelled');
        return { 'cancelled-during-execution': await handle.fetchHistory() };
      });
    },
  },

  /** A prepared change-set cancelled while its workflow waits: the wake ends the run. */
  'cancelled-while-prepared': {
    files: ['cancelled-while-prepared'],
    run: (infra) =>
      withWorker(infra, { reader: catalogReader }, async (worker) => {
        const cs = await preparedByWorkflow(infra, worker, ['t-0001']);
        const cancelled = await worker.executor.cancel({ changesetId: cs.id, actor: 'bob', correlationId: 'corr-cancel' });
        if (!cancelled.ok || cancelled.status !== 'cancelled') throw new Error('cancel refused');
        const handle = infra.client.workflow.getHandle<typeof changesetWorkflow>(cs.id);
        await expectResult(handle, 'cancelled');
        return { 'cancelled-while-prepared': await handle.fetchHistory() };
      }),
  },

  /** Waits for a wake until expiresAt, then expires (EXE-1). */
  expired: {
    files: ['expired'],
    async run(infra) {
      const cs = await createPrepared(infra.repository, 1, { expiresAt: new Date(Date.now() + 3_000) });
      return withWorker(infra, {}, async (worker) => {
        const handle = await signalWithStart(infra, worker, cs.id);
        await expectResult(handle, 'expired');
        return { expired: await handle.fetchHistory() };
      });
    },
  },

  /** The worker's clock is 8 s behind: the first expire changes nothing, the next ones follow the pause. */
  'expire-retry': {
    files: ['expire-retry'],
    async run(infra) {
      const cs = await createPrepared(infra.repository, 1, { expiresAt: new Date(Date.now() + 1_000) });
      const now = (): Date => new Date(Date.now() - 8_000);
      return withWorker(infra, { now }, async (worker) => {
        const handle = await signalWithStart(infra, worker, cs.id);
        await expectResult(handle, 'expired');
        const history = await handle.fetchHistory();
        const timers = history.events?.filter((e) => e.timerStartedEventAttributes != null).length ?? 0;
        if (timers < 2) throw new Error(`expected the wake timeout and at least one expire pause, got ${timers} timers`);
        return { 'expire-retry': history };
      });
    },
  },

  /**
   * Parked in the expire-retry pause: the worker's clock is a minute behind, so the first expire
   * changes nothing and the workflow sleeps the 5 s pause (history taken while it sleeps). A cancel
   * then ends the run after the pause.
   */
  'expire-retry-parked': {
    files: ['expire-retry-parked'],
    async run(infra) {
      const cs = await createPrepared(infra.repository, 1, { expiresAt: new Date(Date.now() + 1_000) });
      const now = (): Date => new Date(Date.now() - 60_000);
      return withWorker(infra, { now }, async (worker) => {
        const handle = await signalWithStart(infra, worker, cs.id);
        const timers = (events: History['events']): { started: number; fired: number } => ({
          started: events?.filter((e) => e.timerStartedEventAttributes != null).length ?? 0,
          fired: events?.filter((e) => e.timerFiredEventAttributes != null).length ?? 0,
        });
        // The wake timeout fired, the expire pause started and has not fired yet.
        await waitFor('the expire-retry pause', async () => {
          const t = timers((await handle.fetchHistory()).events);
          return t.started === 2 && t.fired === 1;
        });
        const parked = await handle.fetchHistory();
        const t = timers(parked.events);
        if (t.started !== 2 || t.fired !== 1) throw new Error(`not parked in the pause: ${JSON.stringify(t)}`);
        const cancelled = await worker.executor.cancel({ changesetId: cs.id, actor: 'alice', correlationId: 'corr-cancel' });
        if (!cancelled.ok) throw new Error('cancel refused');
        await expectResult(handle, 'cancelled');
        return { 'expire-retry-parked': parked };
      });
    },
  },

  /**
   * Submitted for approval and woken: parked at the wake condition in `pending_approval` (history
   * fetched while it waits), then cancelled for cleanup (EXE-1, APR-1).
   */
  'parked-pending-approval': {
    files: ['parked-pending-approval'],
    run: (infra) =>
      withWorker(infra, { reader: catalogReader }, async (worker) => {
        const cs = await preparedByWorkflow(infra, worker, ['t-0001', 't-0002']);
        await submitted(infra, worker, cs);
        await waitForWorkflowStatus(infra, cs.id, 'pending_approval');
        const history = await infra.client.workflow.getHandle(cs.id).fetchHistory();
        await worker.executor.cancel({ changesetId: cs.id, actor: 'alice', correlationId: 'corr-cleanup' });
        await worker.executor.settled(cs.id);
        return { 'parked-pending-approval': history };
      }),
  },

  /** Prepared, submitted, approved, started by the approver for the requester (POL-6): completed. */
  'approved-executed': {
    files: ['approved-executed'],
    run: (infra) =>
      withWorker(infra, { reader: catalogReader }, async (worker) => {
        const cs = await preparedByWorkflow(infra, worker, ['t-0001', 't-0002', 't-0003']);
        const pending = await submitted(infra, worker, cs);
        await waitForWorkflowStatus(infra, cs.id, 'pending_approval');
        const approved = await recordApproval(infra.repository, pending, { approver: 'rita' });
        if (approved.status !== 'approved' || approved.hash === undefined) throw new Error(`not approved: ${approved.status}`);
        const started = await worker.executor.start({
          changesetId: cs.id,
          expectedHash: approved.hash,
          actor: 'rita',
          groups: [REVIEWER_GROUP],
          correlationId: 'corr-exec',
          requester: { subject: 'alice', groups: [APPROVING_GROUP] },
        });
        if (!started.ok) throw new Error(`start refused: ${started.reason}`);
        const handle = infra.client.workflow.getHandle<typeof changesetWorkflow>(cs.id);
        await expectResult(handle, 'completed');
        return { 'approved-executed': await handle.fetchHistory() };
      }),
  },

  /** Rejected while it waits in `pending_approval`: the wake ends the run (APR-4). */
  'rejected-while-pending': {
    files: ['rejected-while-pending'],
    run: (infra) =>
      withWorker(infra, { reader: catalogReader }, async (worker) => {
        const cs = await preparedByWorkflow(infra, worker, ['t-0001']);
        const pending = await submitted(infra, worker, cs);
        await waitForWorkflowStatus(infra, cs.id, 'pending_approval');
        await recordApproval(infra.repository, pending, { approver: 'rita', decision: 'rejected' });
        await worker.executor.wake(cs.id);
        const handle = infra.client.workflow.getHandle<typeof changesetWorkflow>(cs.id);
        await expectResult(handle, 'rejected');
        return { 'rejected-while-pending': await handle.fetchHistory() };
      }),
  },

  /** Returned (round 1), resubmitted (round 2), then left to expire at expiresAt (APR-4, CS-6). */
  'returned-resubmitted-expired': {
    files: ['returned-resubmitted-expired'],
    run: (infra) =>
      withWorker(infra, { reader: catalogReader }, async (worker) => {
        const cs = await preparedByWorkflow(infra, worker, ['t-0001'], { expiresAt: new Date(Date.now() + 3_000) });
        const returned = await recordApproval(infra.repository, await submitted(infra, worker, cs), {
          approver: 'rita',
          decision: 'returned',
          comment: 'fix the name',
        });
        await worker.executor.wake(cs.id);
        const round2 = await submitted(infra, worker, returned);
        if (round2.approvalRound !== 2) throw new Error(`expected round 2, got ${round2.approvalRound}`);
        const handle = infra.client.workflow.getHandle<typeof changesetWorkflow>(cs.id);
        await expectResult(handle, 'expired');
        return { 'returned-resubmitted-expired': await handle.fetchHistory() };
      }),
  },

  /** Waits in `pending_approval` until expiresAt, then expires by the workflow timer (CS-6). */
  'expired-pending-approval': {
    files: ['expired-pending-approval'],
    run: (infra) =>
      withWorker(infra, { reader: catalogReader }, async (worker) => {
        const cs = await preparedByWorkflow(infra, worker, ['t-0001'], { expiresAt: new Date(Date.now() + 3_000) });
        await submitted(infra, worker, cs);
        await waitForWorkflowStatus(infra, cs.id, 'pending_approval');
        const handle = infra.client.workflow.getHandle<typeof changesetWorkflow>(cs.id);
        await expectResult(handle, 'expired');
        return { 'expired-pending-approval': await handle.fetchHistory() };
      }),
  },

  /** The upstream read answers a domain failure: preparation ends failed (no retry). */
  'prepare-failed': {
    files: ['prepare-failed'],
    async run(infra) {
      const reader: UpstreamReader = { read: () => Promise.resolve({ ok: false, code: 'upstream_unavailable' }) };
      const cs = await created(infra, ['t-0001']);
      return withWorker(infra, { reader }, async (worker) => {
        await worker.starter.start(cs.id);
        const handle = infra.client.workflow.getHandle<typeof changesetWorkflow>(cs.id);
        await expectResult(handle, 'failed');
        return { 'prepare-failed': await handle.fetchHistory() };
      });
    },
  },

  /**
   * Every attempt of the first `prepare` fails on infrastructure; the workflow sleeps the retry
   * pause (1 minute), the next `prepare` succeeds, and a cancel ends the waiting run. The history
   * is also taken while the workflow sleeps (parked at the pause).
   */
  'prepare-retry-sleep': {
    files: ['prepare-retry-parked', 'prepare-retry-sleep'],
    async run(infra) {
      let failuresLeft = 5; // PREPARE_MAX_ATTEMPTS: the whole first activity fails
      const readerFor = (): UpstreamReader => {
        if (failuresLeft > 0) {
          failuresLeft -= 1;
          throw new Error('infrastructure unavailable');
        }
        return catalogReader;
      };
      const cs = await created(infra, ['t-0001', 't-0002']);
      return withWorker(infra, { readerFor }, async (worker) => {
        await worker.starter.start(cs.id);
        const handle = infra.client.workflow.getHandle<typeof changesetWorkflow>(cs.id);
        await waitFor('the retry pause', async () => {
          const events = (await handle.fetchHistory()).events ?? [];
          return events.some((e) => e.timerStartedEventAttributes != null);
        });
        const parked = await handle.fetchHistory();
        console.log('waiting out the 1-minute prepare retry pause');
        await waitFor('prepared after the pause', async () => (await statusOf(infra, cs.id)) === 'prepared', 120_000);
        await waitFor('workflow parked in prepared', async () => (await handle.query<WorkflowProgress>(PROGRESS_QUERY)).status === 'prepared');
        const cancelled = await worker.executor.cancel({ changesetId: cs.id, actor: 'alice', correlationId: 'corr-cancel' });
        if (!cancelled.ok) throw new Error('cancel refused');
        await expectResult(handle, 'cancelled');
        return { 'prepare-retry-parked': parked, 'prepare-retry-sleep': await handle.fetchHistory() };
      });
    },
  },

  /** A batch that fails every attempt ends failed/writer_error (NFR-2). */
  'failed-writer-error': {
    files: ['failed-writer-error'],
    async run(infra) {
      const writer = new ScriptedWriter();
      writer.throwAt(1);
      return { 'failed-writer-error': await executeToEnd(infra, { writer }, 4, 'failed') };
    },
  },

  /** Every item of the first batch fails: failed/failure_threshold (EXE-5). */
  'failure-threshold': {
    files: ['failure-threshold'],
    async run(infra) {
      const writer = new ScriptedWriter({ outcomes: { 't-0001': 'failed', 't-0002': 'failed' } });
      return { 'failure-threshold': await executeToEnd(infra, { writer }, 6, 'failed') };
    },
  },

  /** The execution guard denies: failed/policy_denied before any batch (POL-6). */
  'policy-denied': {
    files: ['policy-denied'],
    async run(infra) {
      const guard: ExecutionGuard = { check: () => Promise.resolve({ ok: false, outcome: 'policy_denied' }) };
      return { 'policy-denied': await executeToEnd(infra, { guard }, 2, 'failed') };
    },
  },

  /** A superseded batch (a non-retryable activity failure): failed/executor_error. */
  'executor-error': {
    files: ['executor-error'],
    async run(infra) {
      const writer = { writeBatch: (): Promise<readonly ItemOutcome[]> => Promise.reject(new BatchFenced()) };
      return { 'executor-error': await executeToEnd(infra, { writer }, 2, 'failed') };
    },
  },
};

const args = process.argv.slice(2);
const force = args.includes('--force');
const name = args.find((a) => !a.startsWith('--'));
const scenario = name === undefined ? undefined : SCENARIOS[name];
if (name === undefined || scenario === undefined) {
  console.error(`usage: record-history <scenario> [--force]\nscenarios: ${Object.keys(SCENARIOS).join(' | ')}`);
  process.exit(2);
}

const targets = scenario.files.map((file) => `${outDir}${file}.json`);
const existing = targets.filter((t) => existsSync(t));
if (existing.length > 0 && !force) {
  throw new Error(`${existing.join(', ')} exists; fixtures are not regenerated (pass --force only when a patch is removed)`);
}

const infra = await startInfrastructure({ identity: RECORDER_IDENTITY });
try {
  const recorded = await scenario.run(infra);
  mkdirSync(outDir, { recursive: true });
  for (const file of scenario.files) {
    const history = recorded[file];
    if (history === undefined) throw new Error(`scenario ${name} recorded no ${file}`);
    const target = `${outDir}${file}.json`;
    writeFileSync(target, `${historyToJSON(history)}\n`);
    console.log(`wrote ${target}`);
  }
} finally {
  await infra.close();
}
