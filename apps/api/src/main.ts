import { randomUUID } from 'node:crypto';
import { createAdapters } from '@aiops/adapters';
import { ConfigurationError, ConfigurationHolder, formatIssue, parseApiEnv, startConfigurationSync } from '@aiops/config';
import { createDb, DrizzleAuditLog, parseMasterKeys, PostgresConfigRevisionStore, PostgresCredentialVault, runMigrations } from '@aiops/db';
import { createApp } from './app.js';
import { createLogger } from './logger.js';
import { enableShutdown } from './shutdown.js';
import { startApiTelemetry } from './telemetry.js';
import { configurationLoadOptions, connectionCredential, createUpstreamInstrumentation } from '@aiops/upstream';

/**
 * Process entry: parse env, apply migrations (NFR-5), load the active configuration revision
 * (CFG-4; bootstrapped from AIOPS_CONFIG_DIR on an empty table), keep it current (CFG-3), serve.
 * Migrations come first: the holder reads `config_revision`, which a fresh database gets from them.
 * Telemetry starts right after the logger (NFR-11, NFR-12), so the adapter's upstream calls carry
 * `traceparent` and are counted; `/metrics` listens once the app is built (ruling F2).
 */
async function main(): Promise<void> {
  const env = parseApiEnv(process.env);
  const logger = createLogger(env.logLevel);
  // Registered globally: the context manager carries the active span, and the Temporal interceptor uses the global tracer.
  const telemetry = startApiTelemetry({ serviceName: 'aiops-api', register: true, ...(env.otlpEndpoint === undefined ? {} : { otlpEndpoint: env.otlpEndpoint }) });
  // Parsed before any pool, so a malformed key set stops the start; messages name no key material.
  const masterKeys = parseMasterKeys(env.masterKeys);
  const { applied } = await runMigrations(env.databaseUrl);
  logger.info({ applied }, 'database migrations applied');
  // The configuration's own handle: it is closed after the app's pool, once the sync has stopped.
  const configDb = createDb(env.databaseUrl, {
    onError: (error) => {
      logger.warn({ err: error.message }, 'idle configuration database connection failed');
    },
  });
  const store = new PostgresConfigRevisionStore(configDb.db, { databaseUrl: env.databaseUrl });
  // Before the holder: the load-time tool list of an mcp connection uses its stored credential (R10).
  const vault = new PostgresCredentialVault(configDb.db, masterKeys);
  // One composite adapter (CONN-1): its resolver checks the specs and lists the tools of every
  // revision loaded; it also runs the reads and tool calls, and its listTools drives the pin monitor.
  const adapter = createAdapters({
    instrumentation: createUpstreamInstrumentation({ meter: telemetry.meter }),
    credentialFor: async (ref) => {
      const credential = await connectionCredential(vault, ref);
      // An unknown scheme lists without a credential; the read path refuses it as credential_unusable.
      return credential === 'unusable' ? undefined : credential;
    },
  });
  let configuration: ConfigurationHolder;
  try {
    configuration = await ConfigurationHolder.fromRevisions({
      store,
      fallbackDir: env.configDir,
      load: configurationLoadOptions(adapter, env),
      // No sensitive keys (F5): they come from the active configuration, which may not exist yet; the
      // details of config.load carry no manifest fields and the key-pattern backstop still applies.
      audit: new DrizzleAuditLog(configDb.db),
      service: 'api',
      newId: randomUUID,
      logger,
    });
  } catch (error) {
    if (error instanceof ConfigurationError) {
      for (const issue of error.issues) logger.fatal({ issue: formatIssue(issue) }, 'invalid configuration');
    }
    await configDb.close();
    throw error;
  }
  const state = configuration.state();
  if (state.status !== 'active') logger.error({ status: state.status }, 'no active configuration; requests answer 503 until a revision loads');
  // SIGHUP, NOTIFY and the poll share one sync; a refused revision leaves the previous one active (CFG-2).
  const configSync = await startConfigurationSync({ holder: configuration, store, signals: process, logger });
  // Set once it listens; closed in onShutdown, before the app shuts the telemetry down last.
  let metricsServer: { close(): Promise<void> } | undefined = undefined;
  const app = await createApp({
    env,
    configuration,
    logger,
    telemetry,
    overrides: {
      adapter,
      onShutdown: async () => {
        await configSync.close();
        await configDb.close();
        await metricsServer?.close();
      },
    },
  });
  const metrics = await telemetry.startMetricsServer(env.metricsPort, '0.0.0.0');
  metricsServer = metrics;
  logger.info({ port: metrics.port }, 'metrics listening');
  enableShutdown(app);
  await app.listen(env.port, '0.0.0.0');
  logger.info({ port: env.port }, 'api listening');
}

main().catch((error: unknown) => {
  // EnvError and ConfigurationError messages carry names and locations only, never values.
  console.error(JSON.stringify({ level: 'fatal', msg: error instanceof Error ? error.message : String(error) }));
  process.exit(1);
});
