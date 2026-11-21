// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The AI Operations Layer Authors
import type { INestApplicationContext } from '@nestjs/common';

/**
 * The signals that stop the api gracefully. SIGHUP is not one of them: it reloads the configuration
 * (CFG-2). Nest's `enableShutdownHooks()` without a list listens to every signal, SIGHUP included,
 * and then ends the process after the reload.
 */
export const SHUTDOWN_SIGNALS = ['SIGTERM', 'SIGINT'] as const;

/** Stops the application gracefully on SIGTERM and SIGINT only. */
export function enableShutdown(app: INestApplicationContext): void {
  app.enableShutdownHooks([...SHUTDOWN_SIGNALS]);
}
