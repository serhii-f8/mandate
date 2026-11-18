import { createOpenApiAdapter } from '@aiops/adapters';
import { ConfigurationError, ConfigurationHolder, formatIssue, parseApiEnv } from '@aiops/config';
import { runMigrations } from '@aiops/db';
import { createApp } from './app.js';
import { createLogger } from './logger.js';
import { enableShutdown } from './shutdown.js';
import { configurationLoadOptions } from '@aiops/upstream';

/** Process entry: parse env, load configuration (CFG-2), apply migrations (NFR-5), serve. */
async function main(): Promise<void> {
  const env = parseApiEnv(process.env);
  const logger = createLogger(env.logLevel);
  // One adapter: its resolver checks the specs at load and on every reload; it also runs the reads.
  const adapter = createOpenApiAdapter();
  let configuration: ConfigurationHolder;
  try {
    // The holder keeps these options, so a SIGHUP reload checks specs and presets the same way.
    configuration = await ConfigurationHolder.load(env.configDir, configurationLoadOptions(adapter, env));
  } catch (error) {
    if (error instanceof ConfigurationError) {
      for (const issue of error.issues) logger.fatal({ issue: formatIssue(issue) }, 'invalid configuration');
    }
    throw error;
  }
  logger.info({ hash: configuration.current.hash }, 'configuration loaded');
  // SIGHUP reloads; an invalid configuration is reported and the previous one stays active (CFG-2).
  process.on('SIGHUP', () => {
    configuration.reload().then(
      (result) => {
        if (result.ok) logger.info({ hash: configuration.current.hash }, 'configuration reloaded');
        else for (const issue of result.issues) logger.warn({ issue: formatIssue(issue) }, 'configuration reload rejected; previous configuration stays active');
      },
      (error: unknown) => {
        // Never let a failed reload end the process: the previous configuration stays active.
        logger.error({ err: error instanceof Error ? error.message : 'unknown' }, 'configuration reload failed; previous configuration stays active');
      },
    );
  });
  const { applied } = await runMigrations(env.databaseUrl);
  logger.info({ applied }, 'database migrations applied');
  const app = await createApp({ env, configuration, logger, overrides: { adapter } });
  enableShutdown(app);
  await app.listen(env.port, '0.0.0.0');
  logger.info({ port: env.port }, 'api listening');
}

main().catch((error: unknown) => {
  // EnvError and ConfigurationError messages carry names and locations only, never values.
  console.error(JSON.stringify({ level: 'fatal', msg: error instanceof Error ? error.message : String(error) }));
  process.exit(1);
});
