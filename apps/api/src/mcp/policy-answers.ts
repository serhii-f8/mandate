// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The AI Operations Layer Authors
/** How a policy decision is recorded (POL-8) and how a denial is answered, for the pipeline and the built-ins. */
import type { CallToolResult } from '@modelcontextprotocol/server';
import { policyDecisionAuditEvent, type AuditLog, type Caller, type DenyReason, type PolicyDecision } from '@aiops/core';

const REASON_TEXT: Readonly<Record<DenyReason, (detail: string) => string>> = {
  no_grant: () => 'the operation is not granted to you',
  unknown_tool: () => 'the operation is not granted to you',
  scope_argument_missing: (d) => `argument '${d}' is required by your scope`,
  out_of_scope: (d) => `argument '${d}' is outside your scope`,
  denied_field: (d) => `field '${d}' is denied`,
  field_not_allowed: (d) => `field '${d}' is not allowed`,
  limit_exceeded: (d) => `limit ${d} reached`,
};

export function deniedResult(decision: PolicyDecision): CallToolResult {
  const reason = REASON_TEXT[decision.reason ?? 'no_grant'](decision.detail ?? '');
  return { isError: true, content: [{ type: 'text', text: `Denied by policy: ${reason} (rule ${decision.rule})` }] };
}

/** Identifiers a decision row may carry besides the tool name; never argument values (SEC-3). */
export interface DecisionIds {
  /** The operation ID behind the called tool (MCP-9). */
  readonly operation?: string;
  readonly changesetId?: string;
}

/** Appends one `policy.decision` row; false when the audit could not be written. */
export async function recordDecision(
  deps: { readonly audit: AuditLog; readonly newId: () => string },
  req: { readonly caller: Caller; readonly correlationId: string },
  tool: string,
  decision: PolicyDecision,
  ids: DecisionIds = {},
): Promise<boolean> {
  try {
    const event = policyDecisionAuditEvent({
      id: deps.newId(),
      caller: req.caller,
      tool,
      ...(ids.operation === undefined ? {} : { operation: ids.operation }),
      decision,
      correlationId: req.correlationId,
    });
    await deps.audit.append(ids.changesetId === undefined ? event : { ...event, changesetId: ids.changesetId });
    return true;
  } catch {
    return false;
  }
}
