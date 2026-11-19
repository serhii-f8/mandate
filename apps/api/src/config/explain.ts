/**
 * `aiops config explain`: a dry policy evaluation against a loaded configuration (POL-7).
 * Arguments are checked against the operation's input schema first, as on a real call
 * (MCP-3); an allowed write states the approval it would need (POL-5). Pure: no I/O.
 */
import type { LoadedConfiguration } from '@aiops/config';
import { allowingRole, approvalRequirement, createPolicyEngine, type ApprovalRequirement, type PolicyDecision } from '@aiops/core';

export interface ExplainInput {
  readonly operationId: string;
  readonly groups: readonly string[];
  readonly subject?: string;
  readonly args: Readonly<Record<string, unknown>>;
  /** Records the change-set would include, for `above_threshold` approval rules. */
  readonly records: number;
}

export type ExplainResult =
  | { readonly kind: 'invalid_arguments'; readonly message: string }
  | { readonly kind: 'decision'; readonly decision: PolicyDecision; readonly approval?: ApprovalRequirement };

export function explainCall(configuration: LoadedConfiguration, input: ExplainInput): ExplainResult {
  const { operationId, groups, args } = input;
  // An operation without a validator is unknown here: it skips the check and is denied below (ruling F17).
  const check = configuration.validators.get(operationId)?.(args);
  if (check?.ok === false) return { kind: 'invalid_arguments', message: check.message };

  const evaluated = createPolicyEngine(configuration.policy).evaluate({ caller: { subject: input.subject ?? 'explain', groups }, operationId, args });
  const operation = configuration.policy.operations.find((op) => op.id === operationId);
  // The engine denies an unknown ID as no_grant; the tool pipeline records it as unknown_tool, and so does explain.
  const decision: PolicyDecision = operation === undefined && evaluated.effect === 'deny' ? { ...evaluated, reason: 'unknown_tool' } : evaluated;
  if (decision.effect !== 'allow') return { kind: 'decision', decision };
  const risk = operation?.risk;
  if (risk !== 'write' && risk !== 'destructive') return { kind: 'decision', decision };

  // The allowing rule's role decides approval, as on submission (ADR 0027).
  const role = allowingRole(decision.rule);
  const rule = role === undefined ? undefined : configuration.approval.get(role);
  const approval = approvalRequirement({ risk, ...(rule === undefined ? {} : { rule }), included: input.records });
  return { kind: 'decision', decision, approval };
}

function approvalLine(approval: ApprovalRequirement): string {
  if (!approval.required) return 'approval: not required';
  if (approval.unroutable === true) return `approval: unroutable; reason ${approval.reason}`;
  return `approval: required: steps ${approval.steps.join(', ')}; reason ${approval.reason}`;
}

export function formatExplain(result: ExplainResult): readonly string[] {
  if (result.kind === 'invalid_arguments') return ['effect: invalid_arguments', `message: ${result.message}`];
  const { decision, approval } = result;
  return [
    `effect: ${decision.effect}`,
    `rule: ${decision.rule}`,
    `roles: ${decision.roles.length === 0 ? '-' : decision.roles.join(',')}`,
    `reason: ${decision.reason ?? '-'}`,
    `detail: ${decision.detail ?? '-'}`,
    ...(approval === undefined ? [] : [approvalLine(approval)]),
  ];
}
