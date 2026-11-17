import { randomUUID } from 'node:crypto';
import { createOpenApiAdapter } from '@aiops/adapters';
import { ConfigurationError, ConfigurationHolder, formatIssue, type WorkerEnv } from '@aiops/config';
import { assertMigrated, createDb, DrizzleAuditLog, parseMasterKeys, PostgresChangeSetRepository, PostgresCredentialVault } from '@aiops/db';
import { parseTemporalKeys, workerDataConverter, type ActivityTuning } from '@aiops/temporal';
import { assertFullyChecked, configurationLoadOptions, createUpstreamReader, type UpstreamCallLog } from '@aiops/upstream';
import { heartbeat } from '@temporalio/activity';
import { NativeConnection } from '@temporalio/worker';
import type { Logger } from 'pino';
import { createActivities, createExecutionGuard, echo, type WorkerActivities } from './activities/index.js';
import { installReload } from './reload.js';
import { createWorker } from './worker.js';
import { createWriterFor } from './writers.js';

export interface WorkerRuntime {
  /** Polls the task queue until SIGINT/SIGTERM (`Worker.run` installs those handlers). */
  run(): Promise<void>;
  /** Closes the Temporal connection and the database pool. */
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
 * `write_mode_unsupported`); reads run the shared upstream read path.
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
  try {
    const activities = activitiesFor({
      configuration,
      adapter,
      repository: new PostgresChangeSetRepository(database.db),
      audit: new DrizzleAuditLog(database.db),
      vault: new PostgresCredentialVault(database.db, masterKeys),
      tuning: env.activityTuning,
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
        await worker.run();
      },
      close: async () => {
        // The pool is closed even when closing the Temporal connection fails.
        try {
          await open.close();
        } finally {
          await database.close();
        }
      },
    };
  } catch (error) {
    try {
      await connection?.close();
    } catch {
      // The start failure is the error worth reporting; the pool is closed regardless.
    }
    await database.close();
    throw error;
  }
}
