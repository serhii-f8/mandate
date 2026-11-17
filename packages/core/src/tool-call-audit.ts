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
  /**
   * The client's self-declared name from the request, unverified. Kept in the
   * details so `clientId` only ever holds a verified client identity.
   */
  readonly declaredClientName?: string;
  /**
   * Further non-sensitive details, e.g. the operation ID behind the tool name and the
   * upstream status (MCP-9, AUD-1). Never arguments, results or secrets (SEC-3).
   * `durationMs`, `declaredClientName` and `errorCode` above take precedence.
   */
  readonly details?: Readonly<Record<string, string | number | boolean>>;
}

/**
 * Turns a finished tool call into its audit event (AUD-1). Arguments and results
 * are deliberately not recorded: they can carry upstream data and sensitive
 * fields, and redaction (SEC-3, AUD-4) arrives with the first adapters.
 */
export function toolCallAuditEvent(call: ToolCallRecord): AuditEventInput {
  const details: Record<string, unknown> = { ...call.details, durationMs: call.durationMs };
  if (call.declaredClientName !== undefined) details.declaredClientName = call.declaredClientName;
  if (call.outcome === 'error' && call.errorCode !== undefined) details.errorCode = call.errorCode;
  // An error code belongs to failed calls only, whoever supplied it.
  if (call.outcome !== 'error') delete details.errorCode;
  // Only the request's own declared name is recorded; an extra detail cannot supply one.
  if (call.declaredClientName === undefined) delete details.declaredClientName;
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
