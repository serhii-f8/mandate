import type { CallToolResult } from '@modelcontextprotocol/server';
import { toolCallAuditEvent, type AuditLog, type AuditOutcome, type Caller } from '@aiops/core';

export interface AuditedRunDeps {
  readonly audit: AuditLog;
  readonly caller: Caller;
  readonly correlationId: string;
  /** Unverified client name the request declared, if any. */
  readonly declaredClientName?: string;
  readonly newId: () => string;
  /** Monotonic milliseconds, for the duration. */
  readonly now: () => number;
}

export const AUDIT_UNAVAILABLE: CallToolResult = {
  isError: true,
  content: [{ type: 'text', text: 'Audit unavailable; the call was not completed.' }],
};

const TOOL_FAILED: CallToolResult = { isError: true, content: [{ type: 'text', text: 'Tool failed.' }] };

/**
 * Runs an allowed call and stores its `tool.call` event (AUD-1) before the
 * result is returned. A call whose audit write fails is reported as failed: an
 * unaudited call is never presented as done (ADR 0013). Failures are not echoed
 * to the client, since their text can carry upstream detail (SEC-3).
 */
export type AuditDetails = Readonly<Record<string, string | number | boolean>>;

/**
 * `run` may call `report` with non-sensitive details (operation ID, upstream status) to
 * add to the `tool.call` event; later calls add to earlier ones.
 */
export async function auditedRun(
  tool: string,
  run: (report: (details: AuditDetails) => void) => Promise<CallToolResult>,
  deps: AuditedRunDeps,
): Promise<CallToolResult> {
  const started = deps.now();
  let details: AuditDetails = {};
  const report = (more: AuditDetails): void => {
    details = { ...details, ...more };
  };
  let result: CallToolResult;
  let outcome: AuditOutcome;
  try {
    result = await run(report);
    outcome = result.isError === true ? 'error' : 'ok';
  } catch {
    result = TOOL_FAILED;
    outcome = 'error';
  }
  const event = toolCallAuditEvent({
    id: deps.newId(),
    caller: deps.caller,
    tool,
    outcome,
    correlationId: deps.correlationId,
    durationMs: deps.now() - started,
    ...(Object.keys(details).length === 0 ? {} : { details }),
    ...(result === TOOL_FAILED ? { errorCode: 'handler_failed' } : {}),
    ...(deps.declaredClientName === undefined ? {} : { declaredClientName: deps.declaredClientName }),
  });
  try {
    await deps.audit.append(event);
  } catch {
    return AUDIT_UNAVAILABLE;
  }
  return result;
}
