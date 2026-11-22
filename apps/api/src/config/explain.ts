// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Mandate Authors
/**
 * `mandate config explain`: a dry policy evaluation against a loaded configuration (POL-7).
 * Arguments are checked against the operation's input schema first, as on a real call
 * (MCP-3); an allowed write states the approval it would need (POL-5). Pure: no I/O.
 */
import { approvalRuleFor, createSchemaCompiler, pinStateOf, type LoadedConfiguration, type PinState } from '@mandate/config';
import { approvalRequirement, createPolicyEngine, isOpaque, serviceSubject, type ApprovalRequirement, type PolicyDecision } from '@mandate/core';

export interface ExplainInput {
  readonly operationId: string;
  readonly groups: readonly string[];
  /** A configured service account's client ID (AUTH-4); the caller is its service subject with no groups. */
  readonly service?: string;
  readonly subject?: string;
  readonly args: Readonly<Record<string, unknown>>;
  /** Records the change-set would include, for `above_threshold` approval rules. */
  readonly records: number;
}

export type ExplainResult =
  | { readonly kind: 'invalid_arguments'; readonly message: string }
  | {
      readonly kind: 'decision';
      readonly decision: PolicyDecision;
      readonly approval?: ApprovalRequirement;
      /** CONN-4: an MCP-backed operation's pin state against the revision's load-time tool list. */
      readonly pin?: PinState;
    };

/** The pin state of an MCP-backed operation, as the load-time catalog seeds it; undefined for any other. */
function pinOf(configuration: LoadedConfiguration, operationId: string): { readonly pin?: PinState } {
  const binding = configuration.bindings.get(operationId);
  if (binding?.kind !== 'mcp') return {};
  return { pin: pinStateOf(binding, configuration.mcpCatalogs.get(binding.connection), createSchemaCompiler()).state };
}

export function explainCall(configuration: LoadedConfiguration, input: ExplainInput): ExplainResult {
  const { operationId, groups, args } = input;
  // An operation without a validator is unknown here: it skips the check and is denied below (ruling F17).
  const check = configuration.validators.get(operationId)?.(args);
  if (check?.ok === false) return { kind: 'invalid_arguments', message: check.message };

  const evaluated = createPolicyEngine(configuration.policy).evaluate({ caller: input.service === undefined ? { subject: input.subject ?? 'explain', groups } : { subject: serviceSubject(input.service), groups: [] }, operationId, args });
  const operation = configuration.policy.operations.find((op) => op.id === operationId);
  // The engine denies an unknown ID as no_grant; the tool pipeline records it as unknown_tool, and so does explain.
  const decision: PolicyDecision = operation === undefined && evaluated.effect === 'deny' ? { ...evaluated, reason: 'unknown_tool' } : evaluated;
  const pin = pinOf(configuration, operationId);
  if (decision.effect !== 'allow') return { kind: 'decision', decision, ...pin };
  if (operation === undefined || operation.risk === 'read') return { kind: 'decision', decision, ...pin };

  // The allowing rule's role decides approval, as on submission (ADR 0027).
  const rule = approvalRuleFor(configuration, decision.rule, operation, args);
  const approval = approvalRequirement({
    risk: operation.risk,
    opaque: isOpaque(operation),
    ...(rule === undefined ? {} : { rule }),
    included: input.records,
  });
  return { kind: 'decision', decision, approval, ...pin };
}

function approvalLine(approval: ApprovalRequirement): string {
  if (!approval.required) return 'approval: not required';
  if (approval.unroutable === true) return `approval: unroutable; reason ${approval.reason}`;
  return `approval: required: steps ${approval.steps.join(', ')}; reason ${approval.reason}`;
}

export function formatExplain(result: ExplainResult): readonly string[] {
  if (result.kind === 'invalid_arguments') return ['effect: invalid_arguments', `message: ${result.message}`];
  const { decision, approval, pin } = result;
  return [
    `effect: ${decision.effect}`,
    `rule: ${decision.rule}`,
    `roles: ${decision.roles.length === 0 ? '-' : decision.roles.join(',')}`,
    `reason: ${decision.reason ?? '-'}`,
    `detail: ${decision.detail ?? '-'}`,
    ...(pin === undefined ? [] : [`pin: ${pin}`]),
    ...(approval === undefined ? [] : [approvalLine(approval)]),
  ];
}
