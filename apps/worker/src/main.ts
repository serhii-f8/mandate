// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The AI Operations Layer Authors
import { parseWorkerEnv } from '@aiops/config';
import { createWorkerLogger } from './logger.js';
import { startWorkerRuntime } from './runtime.js';
import { startWorkerTelemetry } from './telemetry/telemetry.js';

/** Process entry: start the runtime (NFR-4) and poll the task queue until SIGTERM/SIGINT. */
async function main(): Promise<void> {
  const env = parseWorkerEnv(process.env);
  const logger = createWorkerLogger(env.logLevel);
  // Registered globally before the worker exists: the activity and client interceptors use the global tracer (NFR-11).
  const telemetry = startWorkerTelemetry({ register: true, ...(env.otlpEndpoint === undefined ? {} : { otlpEndpoint: env.otlpEndpoint }) });
  try {
    const runtime = await startWorkerRuntime(env, logger, process, telemetry);
    try {
      logger.info({ namespace: env.temporalNamespace, taskQueue: env.taskQueue }, 'worker polling');
      // Worker.run() installs SIGINT/SIGTERM handlers and resolves after a graceful shutdown.
      await runtime.run();
      logger.info('worker stopped');
    } finally {
      await runtime.close();
    }
  } finally {
    // Flushes the last spans; never rejects (Task 9).
    await telemetry.shutdown();
  }
}

main().catch((error: unknown) => {
  // EnvError, ConfigurationError and key-parse messages carry names and locations only, never values.
  console.error(JSON.stringify({ level: 'fatal', msg: error instanceof Error ? error.message : String(error) }));
  process.exit(1);
});
