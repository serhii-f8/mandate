// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Mandate Authors
import { describe, expect, it } from 'vitest';
import type { OperationDefinition, RoleApprovalRule } from '@mandate/core';
import { allApprovalRules, approvalRuleFor } from './approval-rule.js';

const rule = (steps: readonly string[], extra: Partial<RoleApprovalRule> = {}): RoleApprovalRule => ({ steps, allowWidget: false, ...extra });
const priceRule = rule(['pricing_owner'], { required: 'always' });
const roleRule = rule(['content_lead'], { required: 'always', fieldRules: [{ ...priceRule, fields: ['price'] }] });
const grantRule = rule(['grant_lead']);
const configuration = {
  approval: new Map([['editor', roleRule]]),
  grantApproval: new Map([['role:editor/grant:prices', grantRule]]),
};
// Only the fields the helper reads.
const operation = { id: 'catalog.update', fieldsArg: 'changes' } as OperationDefinition;

describe('POL-5 approvalRuleFor', () => {
  it('POL-5 a call touching a field routes to the field rule, any other to the role rule', () => {
    expect(approvalRuleFor(configuration, 'role:editor/grant:0', operation, { changes: { price: '1' } })?.steps).toEqual(['pricing_owner']);
    expect(approvalRuleFor(configuration, 'role:editor/grant:0', operation, { changes: { name: 'x' } })?.steps).toEqual(['content_lead']);
  });

  it('POL-5 the allowing grant rule replaces the role rule, also when the rule carries a denial-style suffix', () => {
    expect(approvalRuleFor(configuration, 'role:editor/grant:prices', operation, { changes: { price: '1' } })).toBe(grantRule);
    expect(approvalRuleFor(configuration, 'role:editor/grant:prices/scope:brand', operation, { changes: {} })).toBe(grantRule);
  });

  it('POL-5 an operation that cannot be found reads its fields as unreadable: the change cannot be routed', () => {
    expect(approvalRuleFor(configuration, 'role:editor/grant:0', undefined, { changes: { name: 'x' } })).toEqual({ required: 'always', steps: [], allowWidget: false });
  });

  it('POL-5 unreadable fields cannot be routed; no role and a non-role rule give none', () => {
    expect(approvalRuleFor(configuration, 'role:editor/grant:0', operation, { changes: 'price' })?.steps).toEqual([]);
    expect(approvalRuleFor(configuration, 'role:nobody/grant:0', operation, {})).toBeUndefined();
    expect(approvalRuleFor(configuration, 'default-deny', operation, {})).toBeUndefined();
  });
});

describe('POL-5 approvalRuleFor with records', () => {
  const records = {
    id: 'catalog.update_many',
    fieldsArg: 'records',
    manifest: { idField: 'sku', recordsArg: 'records' },
  } as OperationDefinition;

  it('POL-5 a field rule on price routes a records call in which one record carries price', () => {
    const args = { records: [{ sku: 'a', name: 'x' }, { sku: 'b', price: '1' }] };
    expect(approvalRuleFor(configuration, 'role:editor/grant:0', records, args)?.steps).toEqual(['pricing_owner']);
    expect(approvalRuleFor(configuration, 'role:editor/grant:0', records, { records: [{ sku: 'a', name: 'x' }] })?.steps).toEqual(['content_lead']);
  });
});

describe('POL-5 allApprovalRules', () => {
  it('POL-5 lists the rules of roles and grants and their field rules, so every step role is found', () => {
    const steps = allApprovalRules(configuration).flatMap((r) => r.steps);
    expect(new Set(steps)).toEqual(new Set(['content_lead', 'pricing_owner', 'grant_lead']));
  });
});
