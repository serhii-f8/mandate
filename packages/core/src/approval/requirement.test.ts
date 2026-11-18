import { describe, expect, it } from 'vitest';
import type { RiskClass } from '../policy-model.js';
import { approvalRequirement, type ApprovalRequirement, type RoleApprovalRule } from './index.js';

type Row = [string, RiskClass, RoleApprovalRule | undefined, number, Record<string, unknown>];

const rows: Row[] = [
  [
    'destructive is always required with step-up, never widget',
    'destructive',
    { required: 'never', steps: ['lead'], allowWidget: true },
    1,
    {
      required: true,
      reason: 'risk_destructive',
      steps: ['lead'],
      stepUp: { maxAgeSeconds: 120 },
      widget: false,
      included: 1,
    },
  ],
  [
    'destructive takes the role step-up age',
    'destructive',
    { steps: ['lead'], allowWidget: false, stepUpMaxAgeSeconds: 300 },
    1,
    { required: true, reason: 'risk_destructive', stepUp: { maxAgeSeconds: 300 } },
  ],
  ['never', 'write', { required: 'never', steps: [], allowWidget: false }, 5, { required: false }],
  [
    'at the threshold',
    'write',
    { required: 'above_threshold', recordThreshold: 25, steps: ['lead'], allowWidget: false },
    25,
    { required: false },
  ],
  [
    'above the threshold',
    'write',
    { required: 'above_threshold', recordThreshold: 25, steps: ['lead'], allowWidget: false },
    26,
    { required: true, reason: 'above_threshold', threshold: 25 },
  ],
  [
    'always',
    'write',
    { required: 'always', steps: ['lead'], allowWidget: false },
    1,
    { required: true, reason: 'role_always', steps: ['lead'] },
  ],
  ['no rule is unroutable', 'write', undefined, 1, { required: true, unroutable: true, reason: 'default' }],
  [
    'rule without required and without steps is unroutable',
    'write',
    { steps: [], allowWidget: false },
    1,
    { required: true, unroutable: true, reason: 'default' },
  ],
];

describe('POL-5 approval requirement', () => {
  it.each(rows)('%s', (_name, risk, rule, included, expected) => {
    const input = { risk, included, ...(rule ? { rule } : {}) };
    expect(approvalRequirement(input)).toMatchObject(expected);
  });

  it('POL-5 APR-8 widget only when allowed and without step-up', () => {
    const base: RoleApprovalRule = { required: 'always', steps: ['lead'], allowWidget: true };
    const open = approvalRequirement({ risk: 'write', rule: base, included: 1 });
    expect(open).toMatchObject({ widget: true });
    const stepped = approvalRequirement({
      risk: 'write',
      rule: { ...base, stepUpMaxAgeSeconds: 60 },
      included: 1,
    });
    expect(stepped).toMatchObject({ widget: false, stepUp: { maxAgeSeconds: 60 } });
  });

  it('POL-5 no stepUp key without step-up', () => {
    const result: ApprovalRequirement = approvalRequirement({
      risk: 'write',
      rule: { required: 'always', steps: ['lead'], allowWidget: false },
      included: 1,
    });
    expect('stepUp' in result).toBe(false);
  });
});
