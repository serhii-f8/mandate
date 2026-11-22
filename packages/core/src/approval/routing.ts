// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Mandate Authors
import type { RoleApprovalRule } from './model.js';

/**
 * Picks the approval rule for a change (POL-5). A grant's rule replaces the role's; the role's field
 * rules apply only when no grant rule does. Among the field rules of the chosen rule, the first in
 * list order that matches a touched field wins; with unreadable fields the first field rule applies
 * (fail closed). Otherwise the chosen rule itself applies.
 */
export function resolveApprovalRule(input: {
  readonly role?: RoleApprovalRule;
  readonly grant?: RoleApprovalRule;
  readonly fields: readonly string[] | 'unreadable';
}): RoleApprovalRule | undefined {
  const base = input.grant ?? input.role;
  if (base === undefined) return undefined;
  const { fields } = input;
  const routed =
    fields === 'unreadable'
      ? base.fieldRules?.[0]
      : base.fieldRules?.find((rule) => rule.fields.some((f) => fields.includes(f)));
  return routed ?? base;
}
