import { describe, expect, it } from 'vitest';
import type { RoleMappingEntry } from './policy-model.js';
import { callerKind, resolveRoles, rolesOf, serviceClientOf } from './roles.js';

const mapping: RoleMappingEntry[] = [
  { group: 'content', roles: ['content_manager'] },
  { group: 'support', roles: ['support_agent', 'content_manager'] },
  { group: 'leads', roles: ['content_lead'] },
];

describe('AUTH-3 roles from group claims', () => {
  it('maps a group to its roles', () => {
    expect(resolveRoles(['content'], mapping)).toEqual(['content_manager']);
  });

  it('unions and de-duplicates roles of several groups in mapping order', () => {
    expect(resolveRoles(['leads', 'support', 'content'], mapping)).toEqual(['content_manager', 'support_agent', 'content_lead']);
  });

  it('gives no role for an unmapped group', () => {
    expect(resolveRoles(['finance'], mapping)).toEqual([]);
  });

  it('compares group names exactly', () => {
    expect(resolveRoles(['Content', 'content '], mapping)).toEqual([]);
  });

  it('gives no role without groups', () => {
    expect(resolveRoles([], mapping)).toEqual([]);
  });
});

describe('AUTH-4 rolesOf', () => {
  const serviceAccounts = [{ clientId: 'aiops-sa-ci', role: 'integration' }];

  it('AUTH-4 a service subject gets exactly its configured role and its groups are ignored', () => {
    expect(rolesOf({ subject: 'service:aiops-sa-ci', groups: ['content'] }, { roleMapping: mapping, serviceAccounts })).toEqual(['integration']);
  });

  it('AUTH-4 POL-1 an unconfigured service subject has no roles', () => {
    expect(rolesOf({ subject: 'service:other', groups: ['content'] }, { roleMapping: mapping, serviceAccounts })).toEqual([]);
    expect(rolesOf({ subject: 'service:aiops-sa-ci', groups: ['content'] }, { roleMapping: mapping })).toEqual([]);
  });

  it('AUTH-3 a user subject keeps group resolution', () => {
    const groups = ['leads', 'support'];
    expect(rolesOf({ subject: 'alice', groups }, { roleMapping: mapping, serviceAccounts })).toEqual(resolveRoles(groups, mapping));
  });

  it('AUTH-4 serviceClientOf and callerKind', () => {
    expect(serviceClientOf('service:a')).toBe('a');
    expect(callerKind({ subject: 'service:a' })).toBe('service');
    for (const subject of ['service:', 'Service:a', 'alice']) {
      expect(serviceClientOf(subject)).toBeUndefined();
      expect(callerKind({ subject })).toBe('user');
    }
  });
});
