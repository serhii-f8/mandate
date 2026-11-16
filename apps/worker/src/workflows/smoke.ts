import { proxyActivities } from '@temporalio/workflow';
import type * as activities from '../activities/index.js';

const { echo } = proxyActivities<typeof activities>({
  startToCloseTimeout: '10 seconds',
  retry: { maximumAttempts: 3 },
});

export interface SmokeInput {
  readonly message: string;
}

/**
 * Phase 1 smoke workflow: one activity, proves the worker, task queue and
 * Temporal server work together. Deployed from Phase 1 on, so any change to its
 * command sequence follows the versioning convention (ADR 0006).
 */
export async function smokeWorkflow(input: SmokeInput): Promise<{ echoed: string }> {
  return { echoed: await echo(input.message) };
}
