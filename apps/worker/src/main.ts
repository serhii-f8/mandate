import { pino } from 'pino';
import { parseWorkerEnv } from '@aiops/config';
import { startWorkerRuntime } from './runtime.js';

/** Process entry: start the runtime (NFR-4) and poll the task queue until SIGTERM/SIGINT. */
async function main(): Promise<void> {
  const env = parseWorkerEnv(process.env);
  const logger = pino({ level: env.logLevel, base: { service: 'worker' } });
  const runtime = await startWorkerRuntime(env, logger);
  try {
    logger.info({ namespace: env.temporalNamespace, taskQueue: env.taskQueue }, 'worker polling');
    // Worker.run() installs SIGINT/SIGTERM handlers and resolves after a graceful shutdown.
    await runtime.run();
    logger.info('worker stopped');
  } finally {
    await runtime.close();
  }
}

main().catch((error: unknown) => {
  // EnvError, ConfigurationError and key-parse messages carry names and locations only, never values.
  console.error(JSON.stringify({ level: 'fatal', msg: error instanceof Error ? error.message : String(error) }));
  process.exit(1);
});
