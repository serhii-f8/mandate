import type { AuditEventInput } from './audit.js';
import type { Caller } from './caller.js';
import type { PolicyDecision } from './policy-engine.js';

/** Tool names come from the client; keep at most this many characters in audit. */
export const MAX_AUDITED_TOOL_NAME = 128;

export interface PolicyDecisionRecord {
  readonly id: string;
  readonly caller: Caller;
  readonly tool: string;
  /** The operation ID behind the tool name, when the call named an operation (MCP-9). */
  readonly operation?: string;
  readonly decision: PolicyDecision;
  readonly correlationId: string;
}

/**
 * One audit event per policy decision, allow or deny, with the rule that
 * produced it (POL-8). Argument values are never recorded.
 */
export function policyDecisionAuditEvent(record: PolicyDecisionRecord): AuditEventInput {
  const { decision } = record;
  const details: Record<string, unknown> = { rule: decision.rule, roles: [...decision.roles] };
  if (decision.reason !== undefined) details.reason = decision.reason;
  if (decision.detail !== undefined) details.detail = decision.detail;
  if (record.operation !== undefined) details.operation = record.operation;
  return {
    id: record.id,
    actor: record.caller.subject,
    ...(record.caller.clientId === undefined ? {} : { clientId: record.caller.clientId }),
    action: 'policy.decision',
    subject: record.tool.slice(0, MAX_AUDITED_TOOL_NAME),
    decision: decision.effect,
    outcome: decision.effect === 'allow' ? 'ok' : 'denied',
    correlationId: record.correlationId,
    details,
  };
}
