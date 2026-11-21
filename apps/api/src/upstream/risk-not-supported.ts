// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The AI Operations Layer Authors
import type { InvocationResult, OperationDefinition } from '@aiops/core';

/** Fixed refusal for risk classes this phase does not run; no upstream call. */
export function riskNotSupportedResult(operation: OperationDefinition): InvocationResult {
  return {
    isError: true,
    text: `${operation.id} cannot run: ${operation.risk} operations are not supported yet.`,
    auditDetails: { operation: operation.id, connection: operation.connection, errorCode: 'risk_not_supported' },
  };
}
