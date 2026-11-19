/**
 * The refusal of an MCP-backed operation whose pinned tool is not `ok` (CONN-4; ADR 0051 R8):
 * after the policy decision, before any upstream call, whatever the risk class. Fixed text,
 * and only identifiers and the state in the audit (SEC-5).
 */
import type { PinEvaluation, PinState } from '@aiops/config';
import { readErrorResult, type InvocationResult, type OperationDefinition } from '@aiops/core';

/** `changed` and `missing` are a definition nobody reviewed; the others could not be checked or used. */
const REFUSAL_CODE: Readonly<Record<Exclude<PinState, 'ok'>, 'upstream_changed' | 'upstream_unavailable'>> = {
  changed: 'upstream_changed',
  missing: 'upstream_changed',
  unverified: 'upstream_unavailable',
  schema_invalid: 'upstream_unavailable',
};

/** `undefined` when the operation may run; otherwise the refusal to answer with. */
export function pinRefusal(operation: Pick<OperationDefinition, 'id' | 'connection'>, view: PinEvaluation): InvocationResult | undefined {
  if (view.state === 'ok') return undefined;
  const errorCode = REFUSAL_CODE[view.state];
  return {
    ...readErrorResult(operation.id, errorCode),
    auditDetails: { operation: operation.id, connection: operation.connection, errorCode, pinState: view.state },
  };
}
