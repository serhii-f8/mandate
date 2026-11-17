import type { LoadedConfiguration } from '@aiops/config';
import { ApplicationFailure } from '@temporalio/common';

/** How one execution runs, from the worker's current configuration (EXE-3, EXE-5, EXE-9). */
export interface ExecutionSettings {
  readonly batchSize: number;
  readonly failureThreshold: number;
  readonly itemsPerRun: number;
}

/**
 * Batch size from the operation's manifest; failure threshold and items per workflow run from
 * `changesets`. An operation that is gone or has no manifest cannot run: a non-retryable
 * `operation_unavailable` (a fixed code, SEC-3).
 */
export function executionSettings(configuration: LoadedConfiguration, operationId: string): ExecutionSettings {
  const manifest = configuration.policy.operations.find((o) => o.id === operationId)?.manifest;
  if (manifest === undefined) throw ApplicationFailure.nonRetryable('operation_unavailable');
  return {
    batchSize: manifest.batchSize,
    failureThreshold: configuration.changesets.failureThreshold,
    itemsPerRun: configuration.changesets.itemsPerWorkflowRun,
  };
}
