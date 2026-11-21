// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The AI Operations Layer Authors
/**
 * The direct read path (design part 1 §5, ADR 0017 decision 6): an allowed `read`
 * operation runs from `api` straight through its connection's adapter, as SPEC
 * section 2 says for reads. Writes need change-sets (Phase 4).
 */
import type { ReadOutcome } from '@aiops/connector-sdk';
import {
  READ_RESULT_TEXT,
  readErrorResult,
  readToolResult,
  type InvocationRequest,
  type InvocationResult,
  type OperationInvoker,
} from '@aiops/core';
import { performRead, type ReadDeps } from '@aiops/upstream';

/** The direct path runs only `read` operations bound to GET; anything else goes through a change-set (MCP-4, CS-1). */
export const NOT_DIRECT_READ = 'only read operations bound to GET run directly';

export type DirectReadInvokerDeps = ReadDeps;

type Details = Record<string, string | number | boolean>;

function fromOutcome(operation: string, base: Details, outcome: ReadOutcome): InvocationResult {
  if (!outcome.ok) {
    // The adapter's message stays out of the result and the audit: only the fixed code (SEC-3).
    const details: Details = { ...base, ...(outcome.status === undefined ? {} : { upstreamStatus: outcome.status }), upstreamMs: outcome.durationMs, errorCode: outcome.code };
    return { ...readErrorResult(operation, outcome.code, outcome.status), auditDetails: details };
  }
  const result = readToolResult({
    operation,
    ...(outcome.items === undefined ? { value: outcome.value } : { items: outcome.items }),
    ...(outcome.total === undefined ? {} : { total: outcome.total }),
    truncated: outcome.truncated,
  });
  const itemCount = outcome.items?.length;
  return {
    ...result,
    auditDetails: { ...base, upstreamStatus: outcome.status, ...(itemCount === undefined ? {} : { itemCount }), upstreamMs: outcome.durationMs },
  };
}

export class DirectReadInvoker implements OperationInvoker {
  constructor(private readonly deps: DirectReadInvokerDeps) {}

  async invoke({ operation, args }: InvocationRequest): Promise<InvocationResult> {
    const base: Details = { operation: operation.id, connection: operation.connection };
    const notDirect = (details: Details): InvocationResult => ({
      isError: true,
      text: `${operation.id} cannot run: ${NOT_DIRECT_READ}.`,
      auditDetails: { ...details, errorCode: 'not_readable' },
    });
    if (operation.risk !== 'read') return notDirect(base);

    const read = await performRead(this.deps, operation.id, args);
    if (!read.ok && read.code === 'not_bound') {
      // Not reachable with a fully checked configuration; answered without detail all the same.
      return { isError: true, text: READ_RESULT_TEXT.unknown(operation.id), auditDetails: { ...base, errorCode: 'not_bound' } };
    }
    // From here on the binding decides the connection, for the call and for the audit.
    const bound: Details = { operation: operation.id, connection: read.connection };
    if (!read.ok) {
      if (read.code === 'not_get') return notDirect(bound);
      return { ...readErrorResult(operation.id, 'credential_unusable'), auditDetails: { ...bound, errorCode: 'credential_unusable' } };
    }
    return fromOutcome(operation.id, bound, read.outcome);
  }
}
