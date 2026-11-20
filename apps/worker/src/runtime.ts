import { randomUUID } from 'node:crypto';
import { createAdapters, type OpenApiAdapter, type UpstreamAdapters } from '@aiops/adapters';
import {
  ConfigurationError,
  ConfigurationHolder,
  configurationProbe,
  formatIssue,
  probeWithin,
  startConfigurationSync,
  type ConfigurationStateSource,
  type ConfigurationSync,
  type ReadinessReport,
  type WorkerEnv,
} from '@aiops/config';
import {
  assertMigrated,
  countChangeSetsByStatus,
  createDb,
  DrizzleAuditLog,
  parseMasterKeys,
  PostgresChangeSetRepository,
  PostgresConfigRevisionStore,
  PostgresCredentialVault,
  PostgresNotificationOutbox,
  PostgresRateCounter,
  runAuditRetention,
  sealAuditChain,
  type Database,
} from '@aiops/db';
import { parseTemporalKeys, workerDataConverter, type ActivityTuning } from '@aiops/temporal';
import {
  assertFullyChecked,
  configurationLoadOptions,
  connectionCredential,
  createUpstreamInstrumentation,
  createUpstreamReader,
  vaultToolLister,
  type UpstreamCallLog,
} from '@aiops/upstream';
import type { McpToolAdapter } from '@aiops/connector-sdk';
import { heartbeat } from '@temporalio/activity';
import { NativeConnection, type Worker } from '@temporalio/worker';
import type { Logger } from 'pino';
import { createActivities, createExecutionGuard, echo, type WorkerActivities } from './activities/index.js';
import { createAuditJobs } from './audit-jobs.js';
import { startWorkerHttpServer } from './http-server.js';
import { createNotificationDispatcher } from './notifications/dispatcher.js';
import { createSmtpSender } from './notifications/email.js';
import { createWebhookSender } from './notifications/webhook.js';
import { registerChangeSetGauge, timeBatchActivities } from './telemetry/metrics.js';
import { startWorkerTelemetry, type WorkerTelemetry } from './telemetry/telemetry.js';
import { createTracingPlugin } from './telemetry/tracing.js';
import { createWorker } from './worker.js';
import { createRollbackWriterFor, createWriterFor } from './writers.js';

export interface WorkerRuntime {
  /**
   * Polls the task queue until SIGINT/SIGTERM (`Worker.run` installs those handlers); dispatches
   * notifications (NTF-3), seals the audit chain (AUD-3) and runs audit retention (AUD-7) meanwhile.
   */
  run(): Promise<void>;
  /**
   * Closes the HTTP server, the configuration sync, the SMTP transport, the Temporal connection
   * and the database pool, then the telemetry when the runtime started its own.
   */
  close(): Promise<void>;
  /** The configuration state (CFG-4); the worker's `/readyz` reads it. */
  readonly configuration: ConfigurationStateSource;
  /** The port of `/healthz`, `/readyz` and `/metrics` (NFR-10, NFR-12); the bound one when configured as 0. */
  readonly httpPort: number;
}

const READINESS_PROBE_MS = 2000;

/** What the activities are bound to. */
interface RuntimeStores {
  readonly configuration: ConfigurationHolder;
  readonly adapter: UpstreamAdapters;
  readonly repository: PostgresChangeSetRepository;
  readonly audit: DrizzleAuditLog;
  readonly vault: PostgresCredentialVault;
  readonly tuning: ActivityTuning;
  readonly logger: Logger;
}

/**
 * Activities registered on the worker: `echo` and the change-set activities bound to the stores,
 * the current configuration (it changes on SIGHUP) and the tuning from the environment. Writes
 * go through `createWriterFor` (an opaque operation sends its one call, after a fresh pin check for
 * an MCP tool; a bulk, per-record or code binding writes (OPS-5, OPS-6); anything else fails every
 * item with `write_mode_unsupported`),
 * rollbacks through `createRollbackWriterFor` (EXE-8, OPS-3); reads run the shared upstream read path.
 */
function activitiesFor(stores: RuntimeStores): WorkerActivities {
  const { configuration, repository, vault, adapter, logger } = stores;
  const log = (record: UpstreamCallLog): void => {
    logger.info(record, 'upstream call completed');
  };
  return {
    echo,
    ...createActivities({
      repository,
      configuration: () => configuration.current,
      // The tool list behind the pin check opens the connection's credential only inside the adapter (SEC-2, CONN-4).
      writerFor: createWriterFor({ vault, adapter, toolLister: vaultToolLister(adapter, vault), log }),
      rollbackWriterFor: createRollbackWriterFor({ vault, adapter, log }),
      readerFor: (current, correlationId) => createUpstreamReader({ configuration: current, vault, adapter, correlationId, log }),
      guardFor: createExecutionGuard({
        repository,
        audit: stores.audit,
        newId: randomUUID,
        heartbeat: () => {
          heartbeat();
        },
      }),
      tuning: stores.tuning,
      newId: randomUUID,
      now: () => new Date(),
    }),
  };
}

/**
 * The configuration part of the start (CFG-3, CFG-4): a holder backed by the stored revisions
 * (an empty table is bootstrapped from AIOPS_CONFIG_DIR) and the sync that keeps it current
 * through SIGHUP, NOTIFY and the poll. Its `config.load` rows are written by `system:worker`
 * (AUD-1) through an audit log without sensitive keys (F5): they come from the active
 * configuration, which may not exist yet. SIGHUP is installed before this resolves.
 */
export async function startRuntimeConfiguration(input: {
  env: WorkerEnv;
  database: Database;
  /** Typed structurally (ruling F5): the MCP methods are optional, so an OpenAPI-only adapter still loads. */
  adapter: OpenApiAdapter & Partial<McpToolAdapter>;
  logger: Logger;
  signals: Pick<NodeJS.EventEmitter, 'on' | 'off'>;
}): Promise<{ readonly holder: ConfigurationHolder; readonly sync: ConfigurationSync }> {
  const { env, database, adapter, logger, signals } = input;
  const store = new PostgresConfigRevisionStore(database.db, { databaseUrl: env.databaseUrl });
  let holder: ConfigurationHolder;
  try {
    holder = await ConfigurationHolder.fromRevisions({
      store,
      fallbackDir: env.configDir,
      load: configurationLoadOptions(adapter, env),
      audit: new DrizzleAuditLog(database.db),
      service: 'worker',
      newId: randomUUID,
      logger,
    });
  } catch (error) {
    if (error instanceof ConfigurationError) {
      for (const issue of error.issues) logger.fatal({ issue: formatIssue(issue) }, 'invalid configuration');
    }
    throw error;
  }
  const sync = await startConfigurationSync({ holder, store, signals, logger });
  return { holder, sync };
}

/**
 * Worker start-up (NFR-4): refuses an unmigrated schema (migrations are `api`'s job), starts the
 * HTTP server (NFR-10; not ready until the worker polls), loads the
 * active configuration revision exactly as `api` does (specs resolved, presets loaded) and keeps
 * it current (CFG-3), waits while no revision is loadable, binds the activities to the
 * database and connects to Temporal with the encrypting data converter (SEC-4). SIGHUP is
 * installed before the connect, so an early one refreshes instead of ending the process.
 * `signals` is the process (a test passes its own emitter). `telemetry` is main's (registered
 * globally, NFR-11); without it the runtime starts an unregistered one for its metrics (NFR-12) and
 * shuts it down on close.
 */
export async function startWorkerRuntime(
  env: WorkerEnv,
  logger: Logger,
  signals: Pick<NodeJS.EventEmitter, 'on' | 'off'> = process,
  telemetry?: WorkerTelemetry,
): Promise<WorkerRuntime> {
  await assertMigrated(env.databaseUrl);
  // Parsed before the pool and the listener so a malformed key set stops the start; messages name no key material.
  const masterKeys = parseMasterKeys(env.masterKeys);
  const temporalKeys = parseTemporalKeys(env.temporalKeys);

  const database = createDb(env.databaseUrl, {
    onError: (error) => {
      logger.error({ err: error.message }, 'idle database connection failed');
    },
  });
  // Shut down by close() and the start-failure cleanup only when the runtime started it (F10).
  let ownTelemetry: WorkerTelemetry | undefined;
  // Each is set as soon as its step returns; the cleanup closes only what was returned (a listener
  // whose LISTEN never settles is not covered: the start hangs there). Readiness reads holder and worker.
  let http: { close(): Promise<void> } | undefined;
  let holder: ConfigurationHolder | undefined;
  let worker: Worker | undefined;
  let sync: ConfigurationSync | undefined;
  let connection: NativeConnection | undefined;
  // Without a relay, e-mail rows fail with channel_unconfigured on the retry schedule (NTF-3).
  const email = env.smtpUrl === undefined ? undefined : createSmtpSender({ url: env.smtpUrl, from: env.mailFrom });
  try {
    const active = telemetry ?? startWorkerTelemetry({ register: false });
    if (active !== telemetry) ownTelemetry = active;
    const { meter, spanProcessor, metricsHandler } = active;
    registerChangeSetGauge(meter, () => countChangeSetsByStatus(database));
    // Before the configuration load: the tool list of an mcp connection uses its stored credential (R10).
    const vault = new PostgresCredentialVault(database.db, masterKeys);
    // One composite adapter (CONN-1): its resolver checks the specs and lists the tools of every
    // revision loaded; it also runs the calls. The pin monitor runs in api only (R13).
    const adapter = createAdapters({
      // A preset code module's thrown text, already scrubbed of the credential and cut (OPS-5, SEC-3).
      onCodeError: ({ connection, operation, kind, message }) => {
        logger.warn({ connection, operation, kind, message }, 'preset code failed');
      },
      instrumentation: createUpstreamInstrumentation({ meter }),
      credentialFor: async (ref) => {
        const credential = await connectionCredential(vault, ref);
        // An unknown scheme lists without a credential; the read path refuses it as credential_unusable.
        return credential === 'unusable' ? undefined : credential;
      },
    });
    // Before the wait for an active configuration: a waiting worker is alive, not ready (NFR-10, R15).
    const server = await startWorkerHttpServer(env.httpPort, '0.0.0.0', {
      readiness: async (): Promise<ReadinessReport> => ({
        database: await probeWithin(() => database.pool.query('SELECT 1'), READINESS_PROBE_MS),
        configuration: holder === undefined ? 'none' : configurationProbe(holder.state()),
        // Only a polling worker is ready; no worker yet, draining or stopped is not (Worker.getState, 1.25.0).
        temporal: worker?.getState() === 'RUNNING' ? 'ok' : 'unavailable',
      }),
      metrics: metricsHandler,
    });
    http = server;
    logger.info({ port: server.port }, 'worker http server listening');
    const started = await startRuntimeConfiguration({ env, database, adapter, logger, signals });
    sync = started.sync;
    holder = started.holder;
    const configuration = started.holder;
    const state = configuration.state();
    if (state.status !== 'active') {
      logger.warn({ state }, 'waiting for a loadable configuration');
      await configuration.whenActive();
    }
    assertFullyChecked(configuration.current);

    if (email === undefined && configuration.current.notifications.some((n) => n.kind === 'email')) {
      logger.warn('AIOPS_SMTP_URL is not set: email notifications fail with channel_unconfigured');
    }
    const repository = new PostgresChangeSetRepository(database.db);
    // Preset sensitive fields are covered: the configuration was loaded with the preset directories (AUD-4).
    const audit = new DrizzleAuditLog(database.db, { sensitiveKeys: () => configuration.current.sensitiveFields });
    // The two batch activities record aiops_batch_duration_seconds (NFR-12).
    const activities = timeBatchActivities(activitiesFor({
      configuration,
      adapter,
      repository,
      audit,
      vault,
      tuning: env.activityTuning,
      logger,
    }), meter);
    const dispatcher = createNotificationDispatcher({
      outbox: new PostgresNotificationOutbox(database.db),
      repository,
      configuration: () => configuration.current,
      ...(email === undefined ? {} : { email }),
      webhook: createWebhookSender({ vault }),
      publicUrl: env.publicUrl.origin,
      newId: randomUUID,
      now: () => new Date(),
      logger,
    });
    const rateCounter = new PostgresRateCounter(database.db);
    const auditJobs = createAuditJobs({
      seal: () => sealAuditChain(database.pool),
      // The configuration is read on every run, so a reload changes the retention period (CFG-2).
      retain: () =>
        runAuditRetention({
          pool: database.pool,
          audit,
          rateCounter,
          retentionDays: configuration.current.audit.retentionDays,
          archiveDir: env.auditArchiveDir,
          actor: 'system',
          now: () => new Date(),
          newId: randomUUID,
        }),
      logger,
    });
    connection = await NativeConnection.connect({ address: env.temporalAddress });
    const running = await createWorker({
      connection,
      namespace: env.temporalNamespace,
      taskQueue: env.taskQueue,
      activities,
      dataConverter: workerDataConverter(temporalKeys),
      // Workflow, activity and client spans (NFR-11); the trace header carries only W3C context (SEC-4, ADR 0047).
      plugins: [createTracingPlugin({ spanProcessor, serviceName: 'aiops-worker' })],
    });
    worker = running;
    const open = connection;
    const openSync = sync;
    return {
      configuration,
      httpPort: server.port,
      run: async () => {
        // Delivery and the audit jobs run beside the worker; a failure in either never stops polling (NTF-3, AUD-3).
        const delivery = dispatcher.start();
        const jobs = auditJobs.start();
        try {
          await running.run();
        } finally {
          await Promise.all([delivery.stop(), jobs.stop()]);
        }
      },
      close: async () => {
        // The pool is closed even when closing the server, the sync or the Temporal connection fails.
        try {
          await server.close();
          await openSync.close();
          email?.close();
          await open.close();
        } finally {
          try {
            await database.close();
          } finally {
            // Never rejects (Task 9).
            await ownTelemetry?.shutdown();
          }
        }
      },
    };
  } catch (error) {
    try {
      // F10: the HTTP server first; F6: the listener's own client, then the rest; the pool is closed last.
      await http?.close();
      await sync?.close();
      email?.close();
      await connection?.close();
    } catch {
      // The start failure is the error worth reporting; the pool is closed regardless.
    }
    try {
      await database.close();
    } finally {
      await ownTelemetry?.shutdown();
    }
    throw error;
  }
}
