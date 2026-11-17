import { createOpenApiAdapter } from '@aiops/adapters';
import { ConfigurationError, ConfigurationHolder, formatIssue, type WorkerEnv } from '@aiops/config';
import { assertMigrated, createDb, DrizzleAuditLog, parseMasterKeys, PostgresChangeSetRepository, PostgresCredentialVault } from '@aiops/db';
import { parseTemporalKeys, workerDataConverter } from '@aiops/temporal';
import { assertFullyChecked, configurationLoadOptions } from '@aiops/upstream';
import { NativeConnection } from '@temporalio/worker';
import type { Logger } from 'pino';
import { echo } from './activities/index.js';
import { installReload } from './reload.js';
import { createWorker } from './worker.js';

export interface WorkerRuntime {
  /** Polls the task queue until SIGINT/SIGTERM (`Worker.run` installs those handlers). */
  run(): Promise<void>;
  /** Closes the Temporal connection and the database pool. */
  close(): Promise<void>;
}

/** What the activities are bound to; `createActivities` (Task 11) takes these. */
interface RuntimeStores {
  readonly configuration: ConfigurationHolder;
  readonly adapter: ReturnType<typeof createOpenApiAdapter>;
  readonly repository: PostgresChangeSetRepository;
  readonly audit: DrizzleAuditLog;
  readonly vault: PostgresCredentialVault;
}

/** Activities registered on the worker; until the change-set activities exist only `echo`. */
// eslint-disable-next-line @typescript-eslint/no-unused-vars -- the change-set activities (plan Task 11) bind to these.
function activitiesFor(_stores: RuntimeStores): object {
  return { echo };
}

/**
 * Worker start-up (NFR-4): refuses an unmigrated schema (migrations are `api`'s job), loads the
 * configuration exactly as `api` does (specs resolved, presets loaded), binds the activities to
 * the database, connects to Temporal with the encrypting data converter (SEC-4) and reloads the
 * configuration on SIGHUP (CFG-2).
 */
export async function startWorkerRuntime(env: WorkerEnv, logger: Logger): Promise<WorkerRuntime> {
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
    });
    connection = await NativeConnection.connect({ address: env.temporalAddress });
    const worker = await createWorker({
      connection,
      namespace: env.temporalNamespace,
      taskQueue: env.taskQueue,
      activities,
      dataConverter: workerDataConverter(temporalKeys),
    });
    installReload(configuration, logger, process);
    const open = connection;
    return {
      run: async () => {
        await worker.run();
      },
      close: async () => {
        await open.close();
        await database.close();
      },
    };
  } catch (error) {
    await connection?.close();
    await database.close();
    throw error;
  }
}
