import { describe, expect, it } from 'vitest';
import type { RoleMappingEntry } from './policy-model.js';
import { resolveRoles } from './roles.js';

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
