// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Mandate Authors
import type { RoleApprovalRule } from './model.js';

/**
 * Picks the approval rule for a change (POL-5). A grant's rule replaces the role's; the role's field
 * rules apply only when no grant rule does. Among the field rules of the chosen rule, the first in
 * list order that matches a touched field wins. When the touched fields cannot be read and the chosen
 * rule has field rules, the change cannot be routed: the result requires approval and has no steps,
 * which `approvalRequirement` reports as unroutable (fail closed, never to a weaker rule). Otherwise
 * the chosen rule itself applies.
 */
export function resolveApprovalRule(input: {
  readonly role?: RoleApprovalRule;
  readonly grant?: RoleApprovalRule;
  readonly fields: readonly string[] | 'unreadable';
}): RoleApprovalRule | undefined {
  const base = input.grant ?? input.role;
  if (base === undefined) return undefined;
  const { fields } = input;
  if (base.fieldRules === undefined || base.fieldRules.length === 0) return base;
  if (fields === 'unreadable') return { required: 'always', steps: [], allowWidget: false };
  return base.fieldRules.find((rule) => rule.fields.some((f) => fields.includes(f))) ?? base;
}
