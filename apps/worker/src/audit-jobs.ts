// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Mandate Authors
import { SEAL_BATCH, type RetentionReport, type SealResult } from '@mandate/db';
import type { Logger } from 'pino';

/** Pause between two sealing rounds (design §2). */
export const AUDIT_SEAL_INTERVAL_MS = 2_000;
/** Pause between two retention runs: 6 h (design §5). */
export const AUDIT_RETENTION_INTERVAL_MS = 21_600_000;

export interface AuditJobsDeps {
  readonly seal: () => Promise<SealResult>;
  readonly retain: () => Promise<RetentionReport>;
  readonly logger: Pick<Logger, 'info' | 'warn' | 'error'>;
  readonly sealIntervalMs?: number;
  /** Rows per seal call; a result at this size means a backlog (default `SEAL_BATCH`). */
  readonly sealBatchSize?: number;
  readonly retentionIntervalMs?: number;
}

/** Most seal calls in one tick, so a stop is honoured within a bounded time under a long backlog. */
export const AUDIT_SEAL_MAX_ROUNDS = 100;

/**
 * The thrown value's class name, and the PostgreSQL SQLSTATE when it carries one; the message may
 * carry row content and is never logged (SEC-3).
 */
function errorFields(error: unknown): { error: string; code?: string } {
  const name = error instanceof Error ? error.name : typeof error;
  const code: unknown = typeof error === 'object' && error !== null ? (error as { code?: unknown }).code : undefined;
  return typeof code === 'string' && /^[0-9A-Z]{5}$/.test(code) ? { error: name, code } : { error: name };
}

/**
 * Runs `pass` now and then after every `intervalMs` pause until stopped, on the pattern of the
 * notification dispatcher: `stop()` cuts the pause short, waits for a running pass and starts no
 * other. `pass` must not throw.
 */
function repeat(intervalMs: number, pass: (stopping: () => boolean) => Promise<void>): { stop(): Promise<void> } {
  // An object, so the loop re-reads the flag that stop() sets across the awaits.
  const state: { stopping: boolean; timer?: ReturnType<typeof setTimeout>; wake?: () => void } = { stopping: false };
  const pause = (): Promise<void> =>
    new Promise<void>((resolve) => {
      state.wake = resolve;
      state.timer = setTimeout(resolve, intervalMs);
    });
  const loop = (async () => {
    do {
      await pass(() => state.stopping);
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
}

/**
 * The worker's audit jobs beside the Temporal worker: the sealer (AUD-3) every `sealIntervalMs`
 * and retention (AUD-7) at start and every `retentionIntervalMs`. A failing pass is logged by its
 * error name and SQLSTATE only and the job keeps going; a refused retention is a warning with its reason, a
 * `locked` one (another worker holds the lock and audits its own run) is logged at info.
 */
export function createAuditJobs(deps: AuditJobsDeps): { start(): { stop(): Promise<void> } } {
  const sealIntervalMs = deps.sealIntervalMs ?? AUDIT_SEAL_INTERVAL_MS;
  const retentionIntervalMs = deps.retentionIntervalMs ?? AUDIT_RETENTION_INTERVAL_MS;
  const { logger } = deps;

  const batchSize = deps.sealBatchSize ?? SEAL_BATCH;

  /** Seals while the last call filled a batch (a backlog), at most `AUDIT_SEAL_MAX_ROUNDS` times. */
  async function sealOnce(stopping: () => boolean): Promise<void> {
    try {
      for (let round = 0; round < AUDIT_SEAL_MAX_ROUNDS; round += 1) {
        const result = await deps.seal();
        if (result.sealed < batchSize || stopping()) return;
      }
    } catch (error) {
      logger.error(errorFields(error), 'audit seal failed');
    }
  }

  async function retainOnce(): Promise<void> {
    let report: RetentionReport;
    try {
      report = await deps.retain();
    } catch (error) {
      logger.error(errorFields(error), 'audit retention failed');
      return;
    }
    switch (report.kind) {
      case 'refused':
        logger.warn({ reason: report.reason }, 'audit retention refused');
        return;
      case 'locked':
        logger.info({ kind: 'locked' }, 'audit retention skipped: another run holds the lock');
        return;
      default:
        logger.info(report, 'audit retention completed');
    }
  }

  return {
    start() {
      const sealing = repeat(sealIntervalMs, sealOnce);
      const retaining = repeat(retentionIntervalMs, retainOnce);
      return {
        async stop() {
          await Promise.all([sealing.stop(), retaining.stop()]);
        },
      };
    },
  };
}
