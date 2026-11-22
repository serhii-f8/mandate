// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Mandate Authors
import type { ExecutionLimits } from '@mandate/core';
import type { LoadedConfiguration } from './load.js';

/**
 * POL-4: the limits enforced when a change-set starts executing for a role. `calls_per_minute`
 * is not part of it: it limits every operation call (read or write) per user and role, enforced
 * by the tool pipeline before the call runs. Undefined when the role sets none of the three.
 */
export function executionLimits(configuration: LoadedConfiguration, role: string): ExecutionLimits | undefined {
  const limits = configuration.limits.get(role);
  if (limits === undefined) return undefined;
  const { records_per_operation: perOperation, records_per_day: perDay, concurrent_executions: concurrent } = limits;
  if (perOperation === undefined && perDay === undefined && concurrent === undefined) return undefined;
  return {
    role,
    ...(perOperation === undefined ? {} : { recordsPerOperation: perOperation }),
    ...(perDay === undefined ? {} : { recordsPerDay: perDay }),
    ...(concurrent === undefined ? {} : { concurrentExecutions: concurrent }),
  };
}
