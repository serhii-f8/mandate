// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Mandate Authors
import { describe, expect, it } from 'vitest';
import type { RoleApprovalRule } from './model.js';
import { approvalRequirement } from './requirement.js';
import { resolveApprovalRule } from './routing.js';

const lead: RoleApprovalRule = { steps: ['lead'], allowWidget: false };
const owner: RoleApprovalRule = { required: 'always', steps: ['owner'], allowWidget: false };

describe('POL-5 approval routing', () => {
  it('resolves nothing without a rule', () => {
    expect(resolveApprovalRule({ fields: [] })).toBeUndefined();
  });

  it('uses the role rule when no field rule or grant rule applies', () => {
    expect(resolveApprovalRule({ role: lead, fields: ['name'] })).toBe(lead);
  });

  it('lets the grant rule replace the role rule', () => {
    expect(resolveApprovalRule({ role: lead, grant: owner, fields: [] })).toBe(owner);
  });

  const routed: RoleApprovalRule = {
    ...lead,
    fieldRules: [
      { ...owner, fields: ['price', 'cost'] },
      { ...lead, steps: ['seo'], fields: ['url_key'] },
    ],
  };

  it('keeps the base rule when no touched field matches', () => {
    expect(resolveApprovalRule({ role: routed, fields: ['name'] })?.steps).toEqual(['lead']);
  });

  it('applies a field rule when any touched field matches', () => {
    expect(resolveApprovalRule({ role: routed, fields: ['name', 'price'] })?.steps).toEqual(['owner']);
  });

  it('takes the first matching field rule in list order', () => {
    expect(resolveApprovalRule({ role: routed, fields: ['url_key', 'price'] })?.steps).toEqual(['owner']);
  });

  const UNROUTABLE = { required: 'always', steps: [], allowWidget: false };

  it('POL-5 unreadable fields under a rule with field rules cannot be routed', () => {
    expect(resolveApprovalRule({ role: routed, fields: 'unreadable' })).toEqual(UNROUTABLE);
  });

  it('POL-5 unreadable fields change nothing under a rule without field rules', () => {
    expect(resolveApprovalRule({ role: lead, fields: 'unreadable' })).toBe(lead);
    expect(resolveApprovalRule({ role: routed, grant: lead, fields: 'unreadable' })).toBe(lead);
  });

  it('POL-5 unreadable fields under a grant rule with field rules cannot be routed', () => {
    expect(resolveApprovalRule({ role: lead, grant: routed, fields: 'unreadable' })).toEqual(UNROUTABLE);
  });

  it('POL-5 unreadable fields never select a weaker field rule than the base rule', () => {
    const weaker: RoleApprovalRule = { required: 'always', steps: ['lead'], allowWidget: false, fieldRules: [{ required: 'never', steps: [], allowWidget: false, fields: ['description'] }] };
    const resolved = resolveApprovalRule({ role: weaker, fields: 'unreadable' });
    expect(resolved).toEqual(UNROUTABLE);
    if (resolved === undefined) throw new Error('expected a rule');
    expect(approvalRequirement({ risk: 'write', opaque: false, rule: resolved, included: 1 })).toMatchObject({ required: true, unroutable: true });
  });

  it('ignores the role field rules under a grant rule', () => {
    expect(resolveApprovalRule({ role: routed, grant: lead, fields: ['price'] })?.steps).toEqual(['lead']);
  });
});
