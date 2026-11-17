/**
 * Shared harness for worker integration tests (NFR-15): one Temporal test environment and one
 * migrated PostgreSQL database per test file, one worker and task queue per case. Payloads are
 * encrypted on both sides with the fixed test key (SEC-4).
 */
import { randomUUID } from 'node:crypto';
import type { LoadedConfiguration } from '@aiops/config';
import type { ChangeWriter, ExecutionGuard, UpstreamReader } from '@aiops/core';
import { DrizzleAuditLog, PostgresChangeSetRepository, type Database } from '@aiops/db';
import {
  clientDataConverter,
  parseTemporalKeys,
  TemporalExecutor,
  TemporalWorkflowStarter,
  workerDataConverter,
  type ActivityTuning,
  type ChangesetActivities,
} from '@aiops/temporal';
import { ScriptedWriter } from '@aiops/testing';
import { Client } from '@temporalio/client';
import type { Duration } from '@temporalio/common';
import { TestWorkflowEnvironment } from '@temporalio/testing';
import { DefaultLogger, Runtime, type NativeConnection, type Worker } from '@temporalio/worker';
import { createActivities, createExecutionGuard, echo, type ExecutionSettings } from '../../src/activities/index.js';
import { createWorker } from '../../src/worker.js';
import { testConfiguration } from './configuration.js';
import { TEST_TEMPORAL_KEYS } from './keys.js';
import { startTestPostgres } from './postgres.js';

export interface Infra {
  readonly env: TestWorkflowEnvironment;
  /** A client with the encrypting data converter and the test key. */
  readonly client: Client;
  readonly database: Database;
  readonly repository: PostgresChangeSetRepository;
  readonly audit: DrizzleAuditLog;
  readonly configuration: LoadedConfiguration;
  close(): Promise<void>;
}

/**
 * The SDK logs every bundle and worker state change at INFO; tests keep WARN and above. The
 * runtime is a per-process singleton that must be installed before the first worker or
 * connection, and its options are remembered when it is re-created.
 */
export function quietTemporalLogs(): void {
  if (Runtime._instance === undefined) Runtime.install({ logger: new DefaultLogger('WARN') });
}

export interface InfraOptions {
  /** The client's Temporal identity. Default: the SDK's (`<pid>@<hostname>`). */
  readonly identity?: string;
}

export async function startInfrastructure(opts: InfraOptions = {}): Promise<Infra> {
  quietTemporalLogs();
  const postgres = await startTestPostgres();
  let env: TestWorkflowEnvironment | undefined;
  try {
    env = await TestWorkflowEnvironment.createLocal();
    const started = env;
    const client = new Client({
      connection: started.connection,
      namespace: 'default',
      dataConverter: clientDataConverter(parseTemporalKeys(TEST_TEMPORAL_KEYS)),
      ...(opts.identity === undefined ? {} : { identity: opts.identity }),
    });
    return {
      env: started,
      client,
      database: postgres.database,
      repository: new PostgresChangeSetRepository(postgres.database.db),
      audit: new DrizzleAuditLog(postgres.database.db),
      configuration: await testConfiguration(),
      async close() {
        try {
          await started.teardown();
        } finally {
          await postgres.stop();
        }
      },
    };
  } catch (error) {
    await env?.teardown();
    await postgres.stop();
    throw error;
  }
}

/** Short timeouts and retries, so failure paths finish within seconds. */
export const FAST_TUNING: ActivityTuning = {
  batchHeartbeatMs: 2_000,
  batchTimeoutMs: 30_000,
  batchMaxAttempts: 3,
  retryInitialMs: 100,
  retryMaxMs: 200,
};

export const TEST_SETTINGS: ExecutionSettings = { batchSize: 2, failureThreshold: 0.5, itemsPerRun: 2000 };

export interface TestWorkerOptions {
  readonly writer?: ChangeWriter;
  readonly reader?: UpstreamReader;
  /** Replaces the reader factory, e.g. to fail every preparation before any read (an infrastructure failure). */
  readonly readerFor?: () => UpstreamReader;
  /** The activities' clock (default: the real one), e.g. to put the worker behind workflow time. */
  readonly now?: () => Date;
  /** Default: the production guard over the test configuration. */
  readonly guard?: ExecutionGuard;
  readonly settings?: Partial<ExecutionSettings>;
  readonly tuning?: Partial<ActivityTuning>;
  readonly taskQueue?: string;
  readonly shutdownForceTime?: Duration;
  /**
   * Default: the environment's connection. Core allows one worker per namespace and task queue
   * on a connection, so a second worker on the same queue (another worker process in production)
   * needs a connection of its own.
   */
  readonly connection?: NativeConnection;
  /** Default: the SDK's. 0 sends every workflow task through the shared queue instead of a sticky one. */
  readonly maxCachedWorkflows?: number;
  /** The worker's Temporal identity. Default: the SDK's (`<pid>@<hostname>`). */
  readonly identity?: string;
  /** Called with the activity name before every activity invocation. */
  readonly spy?: (activity: string) => void;
}

export interface TestWorker {
  readonly taskQueue: string;
  readonly worker: Worker;
  /** The Temporal executor on this worker's task queue, with the infrastructure's client and repository. */
  readonly executor: TemporalExecutor;
  /** The workflow starter on this worker's task queue. */
  readonly starter: TemporalWorkflowStarter;
  /** Shuts the worker down and waits until it has stopped. */
  stop(): Promise<void>;
}

const noReads: UpstreamReader = {
  read: () => Promise.reject(new Error('no reader configured for this test')),
};

function spied(a: ChangesetActivities, spy: ((activity: string) => void) | undefined): ChangesetActivities {
  if (spy === undefined) return a;
  return {
    inspect: (id) => (spy('inspect'), a.inspect(id)),
    prepare: (id) => (spy('prepare'), a.prepare(id)),
    expire: (id) => (spy('expire'), a.expire(id)),
    beginExecution: (id, options) => (spy('beginExecution'), a.beginExecution(id, options)),
    executeBatch: (id, batchNo) => (spy('executeBatch'), a.executeBatch(id, batchNo)),
    finishExecution: (id, outcome) => (spy('finishExecution'), a.finishExecution(id, outcome)),
  };
}

/** Starts a polling worker with the change-set activities bound to the infrastructure's stores. */
export async function startTestWorker(infra: Infra, opts: TestWorkerOptions = {}): Promise<TestWorker> {
  const taskQueue = opts.taskQueue ?? `test-${randomUUID()}`;
  const settings: ExecutionSettings = { ...TEST_SETTINGS, ...opts.settings };
  const writer = opts.writer ?? new ScriptedWriter();
  const reader = opts.reader ?? noReads;
  const { guard } = opts;
  const guardFor = guard === undefined ? createExecutionGuard({ repository: infra.repository, audit: infra.audit, newId: randomUUID }) : () => guard;
  const activities = createActivities({
    repository: infra.repository,
    configuration: () => infra.configuration,
    writerFor: () => writer,
    readerFor: opts.readerFor ?? (() => reader),
    guardFor,
    settingsFor: () => settings,
    tuning: { ...FAST_TUNING, ...opts.tuning },
    newId: randomUUID,
    now: opts.now ?? (() => new Date()),
  });
  const worker = await createWorker({
    connection: opts.connection ?? infra.env.nativeConnection,
    namespace: 'default',
    taskQueue,
    activities: { echo, ...spied(activities, opts.spy) },
    dataConverter: workerDataConverter(parseTemporalKeys(TEST_TEMPORAL_KEYS)),
    ...(opts.shutdownForceTime === undefined ? {} : { shutdownForceTime: opts.shutdownForceTime }),
    ...(opts.maxCachedWorkflows === undefined ? {} : { maxCachedWorkflows: opts.maxCachedWorkflows }),
    ...(opts.identity === undefined ? {} : { identity: opts.identity }),
  });
  const running = worker.run();
  // A failed run is reported by stop(); until then it must not count as an unhandled rejection.
  running.catch(() => undefined);
  return {
    taskQueue,
    worker,
    executor: new TemporalExecutor({
      client: infra.client,
      taskQueue,
      repository: infra.repository,
      newId: randomUUID,
      now: () => new Date(),
    }),
    starter: new TemporalWorkflowStarter({ client: infra.client, taskQueue }),
    async stop() {
      if (worker.getState() === 'RUNNING') worker.shutdown();
      await running;
    },
  };
}
