import type { CallToolResult } from '@modelcontextprotocol/server';
import { toolCallAuditEvent, type AuditLog, type AuditOutcome, type Caller } from '@aiops/core';
import type { ToolDefinition } from './tool-catalog.js';

export interface AuditedToolDeps {
  readonly audit: AuditLog;
  readonly caller: Caller;
  readonly correlationId: string;
  readonly newId: () => string;
  /** Monotonic milliseconds, for the duration. */
  readonly now: () => number;
}

const AUDIT_UNAVAILABLE: CallToolResult = {
  isError: true,
  content: [{ type: 'text', text: 'Audit unavailable; the call was not completed.' }],
};

const TOOL_FAILED: CallToolResult = { isError: true, content: [{ type: 'text', text: 'Tool failed.' }] };

/**
 * Wraps a tool so that its audit event (AUD-1) is stored before the result is
 * returned. A call whose audit write fails is reported as failed: an unaudited
 * call is never presented as done (ADR 0013). Handler errors are not echoed to
 * the client, since their text can carry upstream detail (SEC-3).
 */
export function auditedTool(def: ToolDefinition, deps: AuditedToolDeps): (args: unknown) => Promise<CallToolResult> {
  return async (args) => {
    const started = deps.now();
    let result: CallToolResult;
    let outcome: AuditOutcome;
    try {
      result = await def.handler(args, deps.caller);
      outcome = result.isError === true ? 'error' : 'ok';
    } catch {
      result = TOOL_FAILED;
      outcome = 'error';
    }
    const event = toolCallAuditEvent({
      id: deps.newId(),
      caller: deps.caller,
      tool: def.name,
      outcome,
      correlationId: deps.correlationId,
      durationMs: deps.now() - started,
      ...(result === TOOL_FAILED ? { errorCode: 'handler_failed' } : {}),
    });
    try {
      await deps.audit.append(event);
    } catch {
      return AUDIT_UNAVAILABLE;
    }
    return result;
  };
}
