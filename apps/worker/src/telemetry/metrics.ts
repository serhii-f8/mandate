/**
 * Worker metrics (NFR-12): the `aiops_changesets` gauge by status and the batch duration histogram.
 * Labels are the closed sets of the constraints: never a change-set, user or target ID.
 */
import type { ChangeSetStatus } from '@aiops/core';
import type { Meter } from '@opentelemetry/api';
import { ApplicationFailure } from '@temporalio/common';
import type { WorkerActivities } from '../activities/index.js';

/** Every `ChangeSetStatus`; `metrics.test.ts` fails to compile when one is missing (ruling F9). */
export const CHANGESET_STATUSES = [
  'preparing',
  'prepared',
  'pending_approval',
  'approved',
  'executing',
  'completed',
  'completed_with_errors',
  'failed',
  'rejected',
  'expired',
  'cancelled',
  'rolling_back',
  'rolled_back',
] as const satisfies readonly ChangeSetStatus[];

const CACHE_MS = 15_000;
const DEADLINE_MS = 2_000;
const BATCH_BUCKETS = [0.5, 1, 2.5, 5, 10, 30, 60, 120, 300];

export interface ChangeSetGaugeOptions {
  /** Settles like `work`, or rejects when the deadline passes; tests inject one without a timer (ruling F17). */
  readonly deadline?: (work: Promise<unknown>) => Promise<unknown>;
}

function timerDeadline(work: Promise<unknown>): Promise<unknown> {
  let timer: NodeJS.Timeout | undefined;
  const expired = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      reject(new Error('count query deadline'));
    }, DEADLINE_MS);
  });
  return Promise.race([work, expired]).finally(() => {
    clearTimeout(timer);
  });
}

/**
 * Observable gauge `aiops_changesets{status}`: every status is reported, 0 when absent. Counts are
 * cached for 15 s; the query runs under a 2 s deadline, a failed or late query keeps the last
 * values, and no second query starts while one is in flight (ruling F17).
 */
export function registerChangeSetGauge(
  meter: Meter,
  counts: () => Promise<ReadonlyMap<string, number>>,
  now: () => number = Date.now,
  options: ChangeSetGaugeOptions = {},
): void {
  const deadline = options.deadline ?? timerDeadline;
  let last: ReadonlyMap<string, number> = new Map();
  let fetchedAt: number | undefined;
  let inFlight: Promise<void> | undefined;

  const refresh = (): Promise<void> => {
    inFlight ??= counts()
      .then((fresh) => {
        last = fresh;
        fetchedAt = now();
      })
      .catch(() => undefined)
      .finally(() => {
        inFlight = undefined;
      });
    return inFlight;
  };

  const gauge = meter.createObservableGauge('aiops_changesets', {
    description: 'Change-sets by status',
  });
  gauge.addCallback(async (result) => {
    if (fetchedAt === undefined || now() - fetchedAt >= CACHE_MS) {
      try {
        await deadline(refresh());
      } catch {
        // Keep the last values (ruling F17).
      }
    }
    // Before the first successful count an outage must not look like an empty system.
    if (fetchedAt === undefined) return;
    for (const status of CHANGESET_STATUSES) result.observe(last.get(status) ?? 0, { status });
  });
}

export type BatchOutcome = 'ok' | 'error' | 'superseded';

function outcomeOf(error: unknown): BatchOutcome {
  return error instanceof ApplicationFailure && error.message === 'batch_superseded' ? 'superseded' : 'error';
}

/** Wraps the two batch activities to record `aiops_batch_duration_seconds{phase,outcome}`; errors are rethrown unchanged. */
export function timeBatchActivities<A extends WorkerActivities>(
  activities: A,
  meter: Meter,
  now: () => number = () => performance.now(),
): A {
  const histogram = meter.createHistogram('aiops_batch_duration_seconds', {
    description: 'Duration of one execute or rollback batch activity',
    unit: 's',
    advice: { explicitBucketBoundaries: BATCH_BUCKETS },
  });
  const timed = <F extends (...args: never[]) => Promise<unknown>>(phase: 'execute' | 'rollback', fn: F): F =>
    (async (...args: Parameters<F>) => {
      const start = now();
      let outcome: BatchOutcome = 'ok';
      try {
        return await fn(...args);
      } catch (error) {
        outcome = outcomeOf(error);
        throw error;
      } finally {
        histogram.record((now() - start) / 1000, { phase, outcome });
      }
    }) as F;
  return {
    ...activities,
    executeBatch: timed('execute', (...args) => activities.executeBatch(...args)),
    rollbackBatch: timed('rollback', (...args) => activities.rollbackBatch(...args)),
  };
}
