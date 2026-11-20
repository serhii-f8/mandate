import { describe, expect, it } from 'vitest';
import type { RiskClass } from '../policy-model.js';
import { approvalRequirement, type ApprovalRequirement, type RoleApprovalRule } from './index.js';

type Row = [string, RiskClass, boolean, RoleApprovalRule | undefined, number, Record<string, unknown>];

const rows: Row[] = [
  [
    'destructive is always required with step-up, never widget',
    'destructive',
    false,
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
    false,
    { steps: ['lead'], allowWidget: false, stepUpMaxAgeSeconds: 300 },
    1,
    { required: true, reason: 'risk_destructive', stepUp: { maxAgeSeconds: 300 } },
  ],
  ['never', 'write', false, { required: 'never', steps: [], allowWidget: false }, 5, { required: false }],
  [
    'at the threshold',
    'write',
    false,
    { required: 'above_threshold', recordThreshold: 25, steps: ['lead'], allowWidget: false },
    25,
    { required: false },
  ],
  [
    'above the threshold',
    'write',
    false,
    { required: 'above_threshold', recordThreshold: 25, steps: ['lead'], allowWidget: false },
    26,
    { required: true, reason: 'above_threshold', threshold: 25 },
  ],
  [
    'always',
    'write',
    false,
    { required: 'always', steps: ['lead'], allowWidget: false },
    1,
    { required: true, reason: 'role_always', steps: ['lead'] },
  ],
  ['no rule is unroutable', 'write', false, undefined, 1, { required: true, unroutable: true, reason: 'default' }],
  [
    'rule without required and without steps is unroutable',
    'write',
    false,
    { steps: [], allowWidget: false },
    1,
    { required: true, unroutable: true, reason: 'default' },
  ],
];

describe('POL-5 approval requirement', () => {
  it.each(rows)('%s', (_name, risk, opaque, rule, included, expected) => {
    const input = { risk, opaque, included, ...(rule ? { rule } : {}) };
    expect(approvalRequirement(input)).toMatchObject(expected);
  });

  it('POL-5 APR-8 widget only when allowed and without step-up', () => {
    const base: RoleApprovalRule = { required: 'always', steps: ['lead'], allowWidget: true };
    const open = approvalRequirement({ risk: 'write', opaque: false, rule: base, included: 1 });
    expect(open).toMatchObject({ widget: true });
    const stepped = approvalRequirement({
      risk: 'write',
      opaque: false,
      rule: { ...base, stepUpMaxAgeSeconds: 60 },
      included: 1,
    });
    expect(stepped).toMatchObject({ widget: false, stepUp: { maxAgeSeconds: 60 } });
  });

  it('POL-5 no stepUp key without step-up', () => {
    const result: ApprovalRequirement = approvalRequirement({
      risk: 'write',
      opaque: false,
      rule: { required: 'always', steps: ['lead'], allowWidget: false },
      included: 1,
    });
    expect('stepUp' in result).toBe(false);
  });
});

describe('POL-5 approval requirement of opaque operations', () => {
  const threshold: RoleApprovalRule = { required: 'above_threshold', recordThreshold: 25, steps: ['lead'], allowWidget: false };

  it('POL-5 opaque under above_threshold is required with reason opaque', () => {
    const result = approvalRequirement({ risk: 'write_opaque', opaque: true, rule: threshold, included: 1 });
    expect(result).toEqual({ required: true, reason: 'opaque', steps: ['lead'], widget: false, included: 1 });
    expect('threshold' in result).toBe(false);
  });

  it('POL-5 opaque with required: never is not required', () => {
    const rule: RoleApprovalRule = { required: 'never', steps: ['lead'], allowWidget: false };
    expect(approvalRequirement({ risk: 'write_opaque', opaque: true, rule, included: 1 })).toEqual({ required: false });
  });

  it('POL-5 opaque with always', () => {
    const rule: RoleApprovalRule = { required: 'always', steps: ['lead'], allowWidget: false };
    expect(approvalRequirement({ risk: 'write_opaque', opaque: true, rule, included: 1 })).toMatchObject({
      required: true,
      reason: 'role_always',
      steps: ['lead'],
    });
  });

  it('POL-5 destructive without manifest is risk_destructive with step-up 120, never widget', () => {
    const rule: RoleApprovalRule = { required: 'never', steps: ['lead'], allowWidget: true };
    expect(approvalRequirement({ risk: 'destructive', opaque: true, rule, included: 1 })).toEqual({
      required: true,
      reason: 'risk_destructive',
      steps: ['lead'],
      stepUp: { maxAgeSeconds: 120 },
      widget: false,
      included: 1,
    });
  });

  it('POL-5 opaque without a rule is unroutable', () => {
    expect(approvalRequirement({ risk: 'write_opaque', opaque: true, included: 1 })).toEqual({
      required: true,
      unroutable: true,
      reason: 'default',
    });
  });
});
