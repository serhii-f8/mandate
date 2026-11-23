// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Mandate Authors
import type { Logger } from 'pino';

/** Pause between two purge runs: one hour (CS-10). */
export const FILE_PURGE_INTERVAL_MS = 3_600_000;
/** Files removed per purge call; a result at this size means a backlog. */
export const FILE_PURGE_BATCH = 200;
/** Most purge calls in one tick, so a stop is honoured within a bounded time under a long backlog. */
export const FILE_PURGE_MAX_ROUNDS = 100;

export interface FileJobsDeps {
  /** One purge call of at most `FILE_PURGE_BATCH` files; returns how many it removed. */
  readonly purge: () => Promise<number>;
  readonly logger: Pick<Logger, 'info' | 'error'>;
  readonly intervalMs?: number;
}

/**
 * The thrown value's class name, and the PostgreSQL SQLSTATE when it carries one; the message may
 * carry a file name and is never logged (SEC-3).
 */
function errorFields(error: unknown): { error: string; code?: string } {
  const name = error instanceof Error ? error.name : typeof error;
  const code: unknown = typeof error === 'object' && error !== null ? (error as { code?: unknown }).code : undefined;
  return typeof code === 'string' && /^[0-9A-Z]{5}$/.test(code) ? { error: name, code } : { error: name };
}

/**
 * The worker's file job beside the Temporal worker: removes the content of staged files past their
 * retention (CS-10) at start and every `intervalMs`, repeating while a pass filled a batch. A failing
 * pass is logged by its error name and SQLSTATE only and the job keeps going; `stop()` cuts the pause
 * short, waits for a running pass and starts no other.
 */
export function createFileJobs(deps: FileJobsDeps): { start(): { stop(): Promise<void> } } {
  const intervalMs = deps.intervalMs ?? FILE_PURGE_INTERVAL_MS;
  const { logger } = deps;

  async function passOnce(stopping: () => boolean): Promise<void> {
    try {
      let total = 0;
      for (let round = 0; round < FILE_PURGE_MAX_ROUNDS; round += 1) {
        const purged = await deps.purge();
        total += purged;
        if (purged < FILE_PURGE_BATCH || stopping()) break;
      }
      if (total > 0) logger.info({ purged: total }, 'staged file content removed');
    } catch (error) {
      logger.error(errorFields(error), 'file purge failed');
    }
  }

  return {
    start() {
      // An object, so the loop re-reads the flag that stop() sets across the awaits.
      const state: { stopping: boolean; timer?: ReturnType<typeof setTimeout>; wake?: () => void } = { stopping: false };
      const pause = (): Promise<void> =>
        new Promise<void>((resolve) => {
          state.wake = resolve;
          state.timer = setTimeout(resolve, intervalMs);
        });
      const loop = (async () => {
        do {
          await passOnce(() => state.stopping);
          if (!state.stopping) await pause();
        } while (!state.stopping);
      })();
      return {
        async stop() {
          state.stopping = true;
          clearTimeout(state.timer);
          state.wake?.();
          await loop;
        },
      };
    },
  };
}
