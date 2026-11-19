import type { RetentionReport, SealResult } from '@aiops/db';
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
  readonly retentionIntervalMs?: number;
}

/** The thrown value's class name; the message may carry row content and is never logged (SEC-3). */
function errorName(error: unknown): string {
  return error instanceof Error ? error.name : typeof error;
}

/**
 * Runs `pass` now and then after every `intervalMs` pause until stopped, on the pattern of the
 * notification dispatcher: `stop()` cuts the pause short, waits for a running pass and starts no
 * other. `pass` must not throw.
 */
function repeat(intervalMs: number, pass: () => Promise<void>): { stop(): Promise<void> } {
  // An object, so the loop re-reads the flag that stop() sets across the awaits.
  const state: { stopping: boolean; timer?: ReturnType<typeof setTimeout>; wake?: () => void } = { stopping: false };
  const pause = (): Promise<void> =>
    new Promise<void>((resolve) => {
      state.wake = resolve;
      state.timer = setTimeout(resolve, intervalMs);
    });
  const loop = (async () => {
    do {
      await pass();
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
 * error name only and the job keeps going; a refused retention is a warning with its reason, a
 * `locked` one (another worker holds the lock and audits its own run) is logged at info.
 */
export function createAuditJobs(deps: AuditJobsDeps): { start(): { stop(): Promise<void> } } {
  const sealIntervalMs = deps.sealIntervalMs ?? AUDIT_SEAL_INTERVAL_MS;
  const retentionIntervalMs = deps.retentionIntervalMs ?? AUDIT_RETENTION_INTERVAL_MS;
  const { logger } = deps;

  async function sealOnce(): Promise<void> {
    try {
      await deps.seal();
    } catch (error) {
      logger.error({ error: errorName(error) }, 'audit seal failed');
    }
  }

  async function retainOnce(): Promise<void> {
    let report: RetentionReport;
    try {
      report = await deps.retain();
    } catch (error) {
      logger.error({ error: errorName(error) }, 'audit retention failed');
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
