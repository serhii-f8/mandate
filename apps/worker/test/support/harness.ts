// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Mandate Authors
/**
 * Shared harness for worker integration tests (NFR-15): one Temporal test environment and one
 * migrated PostgreSQL database per test file, one worker and task queue per case. Payloads are
 * encrypted on both sides with the fixed test key (SEC-4).
 */
import { randomUUID } from 'node:crypto';
import type { LoadedConfiguration } from '@mandate/config';
import type { ChangeWriter, ExecutionGuard, UpstreamReader } from '@mandate/core';
import { DrizzleAuditLog, PostgresChangeSetRepository, type Database } from '@mandate/db';
import {
  clientDataConverter,
  parseTemporalKeys,
  TemporalExecutor,
  TemporalWorkflowStarter,
  workerDataConverter,
  type ActivityTuning,
  type ChangesetActivities,
} from '@mandate/temporal';
import { ScriptedWriter } from '@mandate/testing';
import { Client, type ClientInterceptors } from '@temporalio/client';
import type { Duration } from '@temporalio/common';
import { TestWorkflowEnvironment } from '@temporalio/testing';
import { DefaultLogger, Runtime, type NativeConnection, type Worker, type WorkerPlugin } from '@temporalio/worker';
import { createActivities, createExecutionGuard, echo, type ActivityDeps, type ExecutionSettings } from '../../src/activities/index.js';
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
  /** The client's interceptors, e.g. the OpenTelemetry client interceptor (NFR-11). */
  readonly clientInterceptors?: ClientInterceptors;
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
      ...(opts.clientInterceptors === undefined ? {} : { interceptors: opts.clientInterceptors }),
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
  prepareTimeoutMs: 60_000,
  batchHeartbeatMs: 2_000,
  batchTimeoutMs: 30_000,
  batchMaxAttempts: 3,
  retryInitialMs: 100,
  retryMaxMs: 200,
};

/** `rollbackWindowHours: 0` (ruling R7): no window opens, so a test awaiting the workflow result still sees it close. */
export const TEST_SETTINGS: ExecutionSettings = { batchSize: 2, failureThreshold: 0.5, itemsPerRun: 2000, rollbackWindowHours: 0 };

export interface TestWorkerOptions {
  readonly writer?: ChangeWriter;
  /** Replaces the writer factory (default: `writer` for every operation), e.g. the production `createWriterFor`. */
  readonly writerFor?: ActivityDeps['writerFor'];
  /** The rollback writer for every operation (default: `writer`). */
  readonly rollbackWriter?: ChangeWriter;
  /** Replaces the rollback writer factory, e.g. the production `createRollbackWriterFor` or one answering undefined. */
  readonly rollbackWriterFor?: ActivityDeps['rollbackWriterFor'];
  readonly reader?: UpstreamReader;
  /**
   * Replaces the reader factory, e.g. to fail every preparation before any read (an infrastructure
   * failure), or the production `createUpstreamReader` against a fake upstream.
   */
  readonly readerFor?: ActivityDeps['readerFor'];
  /** The worker's configuration (default: the infrastructure's). */
  readonly configuration?: LoadedConfiguration;
  /** The activities' clock (default: the real one), e.g. to put the worker behind workflow time. */
  readonly now?: () => Date;
  /** Default: the production guard over the test configuration. */
  readonly guard?: ExecutionGuard;
  readonly settings?: Partial<ExecutionSettings>;
  /**
   * Replaces the settings factory (default: `settings` over `TEST_SETTINGS` for every operation),
   * e.g. the production `executionSettings` for a production-path case.
   */
  readonly settingsFor?: ActivityDeps['settingsFor'];
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
  /** Called with the activity name before every activity invocation; the activity waits for a returned promise. */
  readonly spy?: (activity: string) => unknown;
  /** Worker plugins, e.g. the tracing plugin (NFR-11). */
  readonly plugins?: readonly WorkerPlugin[];
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

function spied(a: ChangesetActivities, spy: ((activity: string) => unknown) | undefined): ChangesetActivities {
  if (spy === undefined) return a;
  const before = async (activity: string): Promise<void> => {
    await Promise.resolve(spy(activity));
  };
  return {
    inspect: async (id) => (await before('inspect'), a.inspect(id)),
    prepare: async (id) => (await before('prepare'), a.prepare(id)),
    expire: async (id) => (await before('expire'), a.expire(id)),
    beginExecution: async (id, options) => (await before('beginExecution'), a.beginExecution(id, options)),
    executeBatch: async (id, batchNo) => (await before('executeBatch'), a.executeBatch(id, batchNo)),
    finishExecution: async (id, outcome) => (await before('finishExecution'), a.finishExecution(id, outcome)),
    openRollbackWindow: async (id) => (await before('openRollbackWindow'), a.openRollbackWindow(id)),
    beginRollback: async (id) => (await before('beginRollback'), a.beginRollback(id)),
    rollbackBatch: async (id, batchNo) => (await before('rollbackBatch'), a.rollbackBatch(id, batchNo)),
    finishRollback: async (id, outcome) => (await before('finishRollback'), a.finishRollback(id, outcome)),
  };
}

/** Starts a polling worker with the change-set activities bound to the infrastructure's stores. */
export async function startTestWorker(infra: Infra, opts: TestWorkerOptions = {}): Promise<TestWorker> {
  const taskQueue = opts.taskQueue ?? `test-${randomUUID()}`;
  const settings: ExecutionSettings = { ...TEST_SETTINGS, ...opts.settings };
  const writer = opts.writer ?? new ScriptedWriter();
  const rollbackWriter = opts.rollbackWriter ?? writer;
  const reader = opts.reader ?? noReads;
  const { guard } = opts;
  const guardFor = guard === undefined ? createExecutionGuard({ repository: infra.repository, audit: infra.audit, newId: randomUUID }) : () => guard;
  const configuration = opts.configuration ?? infra.configuration;
  const activities = createActivities({
    repository: infra.repository,
    configuration: () => configuration,
    writerFor: opts.writerFor ?? (() => writer),
    rollbackWriterFor: opts.rollbackWriterFor ?? (() => rollbackWriter),
    readerFor: opts.readerFor ?? (() => reader),
    guardFor,
    settingsFor: opts.settingsFor ?? (() => settings),
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
    ...(opts.plugins === undefined ? {} : { plugins: opts.plugins }),
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
