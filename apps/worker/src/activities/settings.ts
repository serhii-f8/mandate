import type { LoadedConfiguration } from '@aiops/config';
import { isOpaque } from '@aiops/core';
import { ApplicationFailure } from '@temporalio/common';

/** How one execution and its rollback run, from the worker's current configuration (EXE-3, EXE-5, EXE-8, EXE-9). */
export interface ExecutionSettings {
  readonly batchSize: number;
  readonly failureThreshold: number;
  readonly itemsPerRun: number;
  /** EXE-8: hours a finished change-set stays rollbackable; 0 opens no window. */
  readonly rollbackWindowHours: number;
}

/**
 * Batch size from the operation's manifest, or 1 for an opaque operation (its one call, EXE-4);
 * failure threshold and items per workflow run and the rollback window from `changesets`. An
 * operation that is gone, or is neither opaque nor has a manifest, cannot run: a non-retryable
 * `operation_unavailable` (a fixed code, SEC-3).
 */
export function executionSettings(configuration: LoadedConfiguration, operationId: string): ExecutionSettings {
  const operation = configuration.policy.operations.find((o) => o.id === operationId);
  if (operation === undefined) throw ApplicationFailure.nonRetryable('operation_unavailable');
  let batchSize: number;
  if (operation.manifest !== undefined) batchSize = operation.manifest.batchSize;
  else if (isOpaque(operation)) batchSize = 1;
  else throw ApplicationFailure.nonRetryable('operation_unavailable');
  return {
    batchSize,
    failureThreshold: configuration.changesets.failureThreshold,
    itemsPerRun: configuration.changesets.itemsPerWorkflowRun,
    rollbackWindowHours: configuration.changesets.rollbackWindowHours,
  };
}
