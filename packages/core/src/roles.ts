import type { Caller } from './caller.js';
import type { PolicyConfiguration, RoleMappingEntry } from './policy-model.js';

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

/** The subject namespace of service-account callers (AUTH-4): `service:<client_id>`. */
export const SERVICE_SUBJECT_PREFIX = 'service:';

/** The caller subject of the service account behind OAuth client `clientId` (AUTH-4). */
export function serviceSubject(clientId: string): string {
  return `${SERVICE_SUBJECT_PREFIX}${clientId}`;
}

/** The client id of a service subject, or `undefined` when the subject is not one. The prefix compares exactly. */
export function serviceClientOf(subject: string): string | undefined {
  if (!subject.startsWith(SERVICE_SUBJECT_PREFIX)) return undefined;
  const clientId = subject.slice(SERVICE_SUBJECT_PREFIX.length);
  return clientId === '' ? undefined : clientId;
}

export function callerKind(caller: Pick<Caller, 'subject'>): 'user' | 'service' {
  return serviceClientOf(caller.subject) === undefined ? 'user' : 'service';
}

/**
 * The caller's roles. A service subject (AUTH-4) holds exactly the role configured
 * for its client, or none (POL-1); its groups are ignored. A user subject gets its
 * roles from its groups (AUTH-3).
 */
export function rolesOf(
  caller: Pick<Caller, 'subject' | 'groups'>,
  policy: Pick<PolicyConfiguration, 'roleMapping' | 'serviceAccounts'>,
): readonly string[] {
  const clientId = serviceClientOf(caller.subject);
  if (clientId === undefined) return resolveRoles(caller.groups, policy.roleMapping);
  const entry = policy.serviceAccounts?.find((a) => a.clientId === clientId);
  return entry === undefined ? [] : [entry.role];
}
