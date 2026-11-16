import { NativeConnection } from '@temporalio/worker';
import { pino } from 'pino';
import { parseWorkerEnv } from '@aiops/config';
import { createWorker } from './worker.js';

/** Process entry: connect to Temporal and poll the task queue until SIGTERM/SIGINT. */
async function main(): Promise<void> {
  const env = parseWorkerEnv(process.env);
  const logger = pino({ level: env.logLevel, base: { service: 'worker' } });
  const connection = await NativeConnection.connect({ address: env.temporalAddress });
  try {
    const worker = await createWorker({ connection, namespace: env.temporalNamespace, taskQueue: env.taskQueue });
    logger.info({ namespace: env.temporalNamespace, taskQueue: env.taskQueue }, 'worker polling');
    // Worker.run() installs SIGINT/SIGTERM handlers and resolves after a graceful shutdown.
    await worker.run();
    logger.info('worker stopped');
  } finally {
    await connection.close();
  }
}

main().catch((error: unknown) => {
  console.error(JSON.stringify({ level: 'fatal', msg: error instanceof Error ? error.message : String(error) }));
  process.exit(1);
});
