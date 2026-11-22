// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Mandate Authors
import { allowingRole, resolveApprovalRule, touchedCallFields, type OperationDefinition, type RoleApprovalRule } from '@mandate/core';
import type { LoadedConfiguration } from './load.js';

/** The reference of the grant behind an allow decision's rule, without a trailing `/scope:...`-style suffix. */
function grantReference(decisionRule: string): string | undefined {
  return /^(role:[^/]+\/grant:[^/]+)/.exec(decisionRule)?.[1];
}

/** Every approval rule a configuration holds: roles', grants' and their field rules (POL-5). */
export function allApprovalRules(configuration: Pick<LoadedConfiguration, 'approval' | 'grantApproval'>): readonly RoleApprovalRule[] {
  return [...configuration.approval.values(), ...configuration.grantApproval.values()].flatMap((rule) => [rule, ...(rule.fieldRules ?? [])]);
}

/**
 * The approval rule that applies to a call (POL-5): the allowing grant's rule replaces the role's,
 * and a field rule of the chosen rule applies when the call touches one of its fields. An operation
 * that cannot be found reads its fields as unreadable, so a field rule cannot be bypassed.
 */
export function approvalRuleFor(
  configuration: Pick<LoadedConfiguration, 'approval' | 'grantApproval'>,
  decisionRule: string,
  operation: OperationDefinition | undefined,
  args: Readonly<Record<string, unknown>>,
): RoleApprovalRule | undefined {
  const role = allowingRole(decisionRule);
  if (role === undefined) return undefined;
  const reference = grantReference(decisionRule);
  const grant = reference === undefined ? undefined : configuration.grantApproval.get(reference);
  const roleRule = configuration.approval.get(role);
  return resolveApprovalRule({
    ...(roleRule === undefined ? {} : { role: roleRule }),
    ...(grant === undefined ? {} : { grant }),
    fields: operation === undefined ? 'unreadable' : touchedCallFields(operation.fieldsArg, args),
  });
}
