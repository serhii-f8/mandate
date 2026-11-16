import type { RoleMappingEntry } from './policy-model.js';

/**
 * The caller's roles (AUTH-3): the union of the roles mapped to any of the
 * caller's groups, de-duplicated, in mapping order. Group names compare exactly.
 */
export function resolveRoles(groups: readonly string[], mapping: readonly RoleMappingEntry[]): readonly string[] {
  const member = new Set(groups);
  const roles = new Set<string>();
  for (const entry of mapping) {
    if (!member.has(entry.group)) continue;
    for (const role of entry.roles) roles.add(role);
  }
  return [...roles];
}
