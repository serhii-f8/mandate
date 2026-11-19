import { randomUUID } from 'node:crypto';
import { createOpenApiAdapter } from '@aiops/adapters';
import { ConfigurationError, ConfigurationHolder, formatIssue, type WorkerEnv } from '@aiops/config';
import {
  assertMigrated,
  createDb,
  DrizzleAuditLog,
  parseMasterKeys,
  PostgresChangeSetRepository,
  PostgresCredentialVault,
  PostgresNotificationOutbox,
} from '@aiops/db';
import { parseTemporalKeys, workerDataConverter, type ActivityTuning } from '@aiops/temporal';
import { assertFullyChecked, configurationLoadOptions, createUpstreamReader, type UpstreamCallLog } from '@aiops/upstream';
import { heartbeat } from '@temporalio/activity';
import { NativeConnection } from '@temporalio/worker';
import type { Logger } from 'pino';
import { createActivities, createExecutionGuard, echo, type WorkerActivities } from './activities/index.js';
import { createNotificationDispatcher } from './notifications/dispatcher.js';
import { createSmtpSender } from './notifications/email.js';
import { createWebhookSender } from './notifications/webhook.js';
import { installReload } from './reload.js';
import { createWorker } from './worker.js';
import { createRollbackWriterFor, createWriterFor } from './writers.js';

export interface WorkerRuntime {
  /** Polls the task queue until SIGINT/SIGTERM (`Worker.run` installs those handlers); dispatches notifications meanwhile (NTF-3). */
  run(): Promise<void>;
  /** Closes the SMTP transport, the Temporal connection and the database pool. */
  close(): Promise<void>;
}

/** What the activities are bound to. */
interface RuntimeStores {
  readonly configuration: ConfigurationHolder;
  readonly adapter: ReturnType<typeof createOpenApiAdapter>;
  readonly repository: PostgresChangeSetRepository;
  readonly audit: DrizzleAuditLog;
  readonly vault: PostgresCredentialVault;
  readonly tuning: ActivityTuning;
  readonly logger: Logger;
}

/**
 * Activities registered on the worker: `echo` and the change-set activities bound to the stores,
 * the current configuration (it changes on SIGHUP) and the tuning from the environment. Writes
 * go through `createWriterFor` (a bulk binding writes, anything else fails every item with
 * `write_mode_unsupported`), rollbacks through `createRollbackWriterFor` (EXE-8, OPS-3); reads run
 * the shared upstream read path.
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
      writerFor: createWriterFor({ vault, adapter, log }),
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
 * Worker start-up (NFR-4): refuses an unmigrated schema (migrations are `api`'s job), loads the
 * configuration exactly as `api` does (specs resolved, presets loaded), binds the activities to
 * the database, connects to Temporal with the encrypting data converter (SEC-4) and reloads the
 * configuration on SIGHUP (CFG-2). `signals` is the process (a test passes its own emitter).
 */
export async function startWorkerRuntime(
  env: WorkerEnv,
  logger: Logger,
  signals: Pick<NodeJS.EventEmitter, 'on'> = process,
): Promise<WorkerRuntime> {
  await assertMigrated(env.databaseUrl);

  // One adapter: its resolver checks the specs at load and on every reload; it also runs the calls.
  const adapter = createOpenApiAdapter();
  let configuration: ConfigurationHolder;
  try {
    configuration = await ConfigurationHolder.load(env.configDir, configurationLoadOptions(adapter, env));
  } catch (error) {
    if (error instanceof ConfigurationError) {
      for (const issue of error.issues) logger.fatal({ issue: formatIssue(issue) }, 'invalid configuration');
    }
    throw error;
  }
  assertFullyChecked(configuration.current);
  logger.info({ hash: configuration.current.hash }, 'configuration loaded');
  // Before the slow connect and workflow bundling: an early SIGHUP must reload, not end the process.
  installReload(configuration, logger, signals);

  // Parsed before any connection so a malformed key set stops the start; messages name no key material.
  const masterKeys = parseMasterKeys(env.masterKeys);
  const temporalKeys = parseTemporalKeys(env.temporalKeys);

  const database = createDb(env.databaseUrl, {
    onError: (error) => {
      logger.error({ err: error.message }, 'idle database connection failed');
    },
  });
  let connection: NativeConnection | undefined;
  // Without a relay, e-mail rows fail with channel_unconfigured on the retry schedule (NTF-3).
  const email = env.smtpUrl === undefined ? undefined : createSmtpSender({ url: env.smtpUrl, from: env.mailFrom });
  if (email === undefined && configuration.current.notifications.some((n) => n.kind === 'email')) {
    logger.warn('AIOPS_SMTP_URL is not set: email notifications fail with channel_unconfigured');
  }
  try {
    const repository = new PostgresChangeSetRepository(database.db);
    const vault = new PostgresCredentialVault(database.db, masterKeys);
    const activities = activitiesFor({
      configuration,
      adapter,
      repository,
      audit: new DrizzleAuditLog(database.db),
      vault,
      tuning: env.activityTuning,
      logger,
    });
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
    connection = await NativeConnection.connect({ address: env.temporalAddress });
    const worker = await createWorker({
      connection,
      namespace: env.temporalNamespace,
      taskQueue: env.taskQueue,
      activities,
      dataConverter: workerDataConverter(temporalKeys),
    });
    const open = connection;
    return {
      run: async () => {
        // Delivery runs beside the worker; a channel that is down never stops polling (NTF-3).
        const delivery = dispatcher.start();
        try {
          await worker.run();
        } finally {
          await delivery.stop();
        }
      },
      close: async () => {
        // The pool is closed even when closing the Temporal connection fails.
        try {
          email?.close();
          await open.close();
        } finally {
          await database.close();
        }
      },
    };
  } catch (error) {
    try {
      email?.close();
      await connection?.close();
    } catch {
      // The start failure is the error worth reporting; the pool is closed regardless.
    }
    await database.close();
    throw error;
  }
}
