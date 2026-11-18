import { describe, expect, it } from 'vitest';
import type { ChangeSetRecord } from '../changeset/model.js';
import { canView, checkDecision, currentStep } from './decision.js';
import type { ApprovalChannel, ApprovalRecord, Approver, DecisionRequest } from './model.js';

const T0 = new Date('2026-11-17T10:00:00.000Z');
const NOW = new Date('2026-11-17T10:01:00.000Z');
const HASH = `sha256:${'a'.repeat(64)}`;

const changeset: ChangeSetRecord = {
  id: 'cs1',
  operation: 'op.write',
  connection: 'c',
  requester: 'alice',
  args: {},
  hash: HASH,
  status: 'pending_approval',
  stats: { total: 3, included: 3, excluded: {}, written: 0, failed: 0, skipped: 0 },
  configHash: 'h',
  correlationId: 'corr',
  createdAt: T0,
  expiresAt: new Date('2026-11-20T10:00:00.000Z'),
  approvalRound: 1,
  approvalPlan: { reason: 'role_always', steps: ['lead', 'brand'], widget: false, included: 3 },
  awaitingRole: 'lead',
  submission: {
    actor: 'alice',
    groups: ['g'],
    correlationId: 'corr',
    at: T0,
    role: 'editor',
    rule: 'r',
  },
};

const lead: Approver = { subject: 'bob', roles: ['lead'] };

function decide(
  over: {
    changeset?: Partial<ChangeSetRecord>;
    approvals?: ApprovalRecord[];
    approver?: Approver;
    channel?: ApprovalChannel;
    decision?: DecisionRequest;
    hash?: string;
    count?: number;
    comment?: string;
    now?: Date;
  } = {},
) {
  return checkDecision({
    changeset: { ...changeset, ...over.changeset },
    approvals: over.approvals ?? [],
    approver: over.approver ?? lead,
    channel: over.channel ?? 'page',
    decision: over.decision ?? 'approve',
    hash: over.hash ?? HASH,
    count: over.count ?? 3,
    now: over.now ?? NOW,
    ...(over.comment === undefined ? {} : { comment: over.comment }),
  });
}

function row(over: Partial<ApprovalRecord>): ApprovalRecord {
  return {
    id: 'a1',
    changesetId: 'cs1',
    round: 1,
    step: 1,
    role: 'lead',
    approver: 'bob',
    decision: 'approved',
    hash: HASH,
    itemCount: 3,
    channel: 'page',
    correlationId: 'c',
    ts: T0,
    ...over,
  };
}

describe('APR-1 checkDecision', () => {
  it('allowed answers undefined', () => {
    expect(decide()).toBeUndefined();
  });

  it('SEC-1 not_found for a viewer without a step role', () => {
    expect(decide({ approver: { subject: 'eve', roles: ['other'] } })).toBe('not_found');
  });

  it('SEC-1 not_found when the change-set has no approval plan and the viewer is not the requester', () => {
    const rest: ChangeSetRecord = { ...changeset, approvalPlan: undefined } as unknown as ChangeSetRecord; // plan absent: exactOptionalPropertyTypes forbids an explicit undefined
    expect(checkDecision({ ...input(), changeset: rest })).toBe('not_found');
  });

  it('CS-6 expired when expiresAt <= now', () => {
    expect(decide({ now: changeset.expiresAt })).toBe('expired');
  });

  it('CS-6 a change-set already moved to expired answers expired', () => {
    expect(decide({ changeset: { status: 'expired' } })).toBe('expired');
  });

  it('not_pending when status is approved', () => {
    expect(decide({ changeset: { status: 'approved' } })).toBe('not_pending');
  });

  it('APR-1 not_approver for a holder of brand while lead is awaited', () => {
    expect(decide({ approver: { subject: 'carol', roles: ['brand'] } })).toBe('not_approver');
  });

  it('APR-2 separation_of_duties for the requester', () => {
    expect(decide({ approver: { subject: 'alice', roles: ['lead'] } })).toBe('separation_of_duties');
  });

  it('APR-2 separation_of_duties for the approver of step 1 deciding step 2', () => {
    expect(
      decide({
        changeset: { awaitingRole: 'brand' },
        approvals: [row({})],
        approver: { subject: 'bob', roles: ['lead', 'brand'] },
      }),
    ).toBe('separation_of_duties');
  });

  it('APR-2 a round-1 approval does not bind the approver in round 2', () => {
    expect(decide({ changeset: { approvalRound: 2 }, approvals: [row({ round: 1 })] })).toBeUndefined();
  });

  it('APR-8 widget_not_allowed on the widget channel when plan.widget is false', () => {
    expect(decide({ channel: 'widget' })).toBe('widget_not_allowed');
  });

  it('APR-8 the widget channel is allowed when plan.widget is true', () => {
    const plan = { reason: 'role_always', steps: ['lead'], widget: true, included: 3 } as const;
    expect(decide({ channel: 'widget', changeset: { approvalPlan: plan } })).toBeUndefined();
  });
});

describe('AUTH-6 step-up in checkDecision', () => {
  const stepUp = {
    approvalPlan: {
      reason: 'risk_destructive',
      steps: ['lead'],
      stepUp: { maxAgeSeconds: 120 },
      widget: false,
      included: 3,
    },
  } as const;

  it('AUTH-6 step_up_required when authTime is before submission.at', () => {
    const authTime = new Date(T0.getTime() - 1000);
    expect(decide({ changeset: stepUp, approver: { ...lead, authTime } })).toBe('step_up_required');
  });

  it('AUTH-6 step_up_required when authTime is missing', () => {
    expect(decide({ changeset: stepUp })).toBe('step_up_required');
  });

  it('AUTH-6 step_up_required when now - authTime > maxAgeSeconds*1000', () => {
    const now = new Date(T0.getTime() + 121_000);
    expect(decide({ changeset: stepUp, approver: { ...lead, authTime: T0 }, now })).toBe('step_up_required');
  });

  it('AUTH-6 a fresh login after submission within the age is allowed', () => {
    expect(decide({ changeset: stepUp, approver: { ...lead, authTime: T0 } })).toBeUndefined();
  });

  it('AUTH-6 step_up_required when authTime is an invalid date', () => {
    expect(decide({ changeset: stepUp, approver: { ...lead, authTime: new Date(Number.NaN) } })).toBe('step_up_required');
  });

  it('AUTH-6 step_up_required when authTime is more than the allowed skew in the future', () => {
    const authTime = new Date(NOW.getTime() + 61_000);
    expect(decide({ changeset: stepUp, approver: { ...lead, authTime } })).toBe('step_up_required');
  });

  it('AUTH-6 an authTime slightly ahead of the server clock is allowed (clock skew)', () => {
    const authTime = new Date(NOW.getTime() + 30_000);
    expect(decide({ changeset: stepUp, approver: { ...lead, authTime } })).toBeUndefined();
  });

  it('AUTH-6 no step-up check on a plan without stepUp', () => {
    expect(decide({ approver: { ...lead, authTime: new Date(0) } })).toBeUndefined();
  });
});

describe('SEC-9 hash, count and comment checks', () => {
  it('SEC-9 hash_mismatch for approve with another hash', () => {
    expect(decide({ hash: `sha256:${'b'.repeat(64)}` })).toBe('hash_mismatch');
  });

  it('APR-6 count_mismatch for approve with count 2', () => {
    expect(decide({ count: 2 })).toBe('count_mismatch');
  });

  it('SEC-9 reject is not refused for a stale hash', () => {
    expect(decide({ decision: 'reject', hash: 'sha256:stale', count: 99 })).toBeUndefined();
  });

  it('APR-4 comment_required for return with "  "', () => {
    expect(decide({ decision: 'return', comment: '  ' })).toBe('comment_required');
    expect(decide({ decision: 'return' })).toBe('comment_required');
    expect(decide({ decision: 'return', comment: 'fix the titles' })).toBeUndefined();
  });

  it('APR-4 comment_invalid for 2001 chars or a control character; newline and tab are accepted', () => {
    expect(decide({ decision: 'reject', comment: 'x'.repeat(2001) })).toBe('comment_invalid');
    expect(decide({ decision: 'reject', comment: 'x'.repeat(2000) })).toBeUndefined();
    expect(decide({ decision: 'reject', comment: 'a\u0007b' })).toBe('comment_invalid');
    expect(decide({ decision: 'return', comment: 'a\u0007b' })).toBe('comment_invalid');
    expect(decide({ decision: 'reject', comment: 'a\nb\tc' })).toBeUndefined();
  });

  it('APR-1 the refusal order follows design section 6', () => {
    // fails checks 4 (not_approver), 6 (widget) and 8 (hash): 4 wins.
    expect(
      decide({ approver: { subject: 'carol', roles: ['brand'] }, channel: 'widget', hash: 'sha256:x' }),
    ).toBe('not_approver');
    // fails 5, 6 and 8: 5 wins.
    expect(
      decide({ approver: { subject: 'alice', roles: ['lead'] }, channel: 'widget', hash: 'sha256:x' }),
    ).toBe('separation_of_duties');
    // fails 6 and 8: 6 wins.
    expect(decide({ channel: 'widget', hash: 'sha256:x' })).toBe('widget_not_allowed');
  });
});

describe('APR-1 currentStep', () => {
  it('is the next undecided step of the current round, undefined unless pending_approval', () => {
    expect(currentStep(changeset, [])).toBe(1);
    expect(currentStep(changeset, [row({})])).toBe(2);
    expect(currentStep(changeset, [row({ round: 0 })])).toBe(1);
    expect(currentStep({ ...changeset, status: 'approved' }, [])).toBeUndefined();
  });
});

describe('SEC-1 canView', () => {
  const nobody = { subject: 'eve', roles: [] as string[] };
  it('SEC-1 is true for the requester, a holder of any step role and a recorded approver', () => {
    expect(canView(changeset, [], { subject: 'alice', roles: [] })).toBe(true);
    expect(canView(changeset, [], { subject: 'carol', roles: ['brand'] })).toBe(true);
    expect(canView(changeset, [row({ approver: 'eve' })], nobody)).toBe(true);
  });
  it('SEC-1 is false for anyone else', () => {
    expect(canView(changeset, [], nobody)).toBe(false);
    expect(canView(changeset, [row({ approver: 'bob' })], nobody)).toBe(false);
  });
  it('SEC-1 is false without an approval plan for a viewer who did not request it', () => {
    const rest: ChangeSetRecord = { ...changeset, approvalPlan: undefined } as unknown as ChangeSetRecord; // plan absent: exactOptionalPropertyTypes forbids an explicit undefined
    expect(canView(rest, [], { subject: 'bob', roles: ['lead'] })).toBe(false);
    expect(canView(rest, [], { subject: 'alice', roles: [] })).toBe(true);
  });
});

function input() {
  return {
    changeset,
    approvals: [],
    approver: lead,
    channel: 'page' as const,
    decision: 'approve' as const,
    hash: HASH,
    count: 3,
    now: NOW,
  };
}
