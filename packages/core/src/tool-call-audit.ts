import type { AuditEventInput, AuditOutcome } from './audit.js';
import type { Caller } from './caller.js';

export interface ToolCallRecord {
  readonly id: string;
  readonly caller: Caller;
  readonly tool: string;
  readonly outcome: AuditOutcome;
  readonly correlationId: string;
  readonly durationMs: number;
  /** Machine-readable failure reason; kept only when `outcome` is `error`. */
  readonly errorCode?: string;
}

/**
 * Turns a finished tool call into its audit event (AUD-1). Arguments and results
 * are deliberately not recorded: they can carry upstream data and sensitive
 * fields, and redaction (SEC-3, AUD-4) arrives with the first adapters.
 */
export function toolCallAuditEvent(call: ToolCallRecord): AuditEventInput {
  const details: Record<string, unknown> = { durationMs: call.durationMs };
  if (call.outcome === 'error' && call.errorCode !== undefined) details.errorCode = call.errorCode;
  return {
    id: call.id,
    actor: call.caller.subject,
    ...(call.caller.clientId === undefined ? {} : { clientId: call.caller.clientId }),
    action: 'tool.call',
    subject: call.tool,
    outcome: call.outcome,
    correlationId: call.correlationId,
    details,
  };
}
