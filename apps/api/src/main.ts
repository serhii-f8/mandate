import { parseApiEnv } from '@aiops/config';
import { runMigrations } from '@aiops/db';
import { createApp } from './app.js';
import { createLogger } from './logger.js';

/** Process entry: parse env, apply migrations (NFR-5), serve. */
async function main(): Promise<void> {
  const env = parseApiEnv(process.env);
  const logger = createLogger(env.logLevel);
  const { applied } = await runMigrations(env.databaseUrl);
  logger.info({ applied }, 'database migrations applied');
  const app = await createApp({ env, logger });
  app.enableShutdownHooks();
  await app.listen(env.port, '0.0.0.0');
  logger.info({ port: env.port }, 'api listening');
}

main().catch((error: unknown) => {
  // EnvError messages carry variable names only, never values.
  console.error(JSON.stringify({ level: 'fatal', msg: error instanceof Error ? error.message : String(error) }));
  process.exit(1);
});
