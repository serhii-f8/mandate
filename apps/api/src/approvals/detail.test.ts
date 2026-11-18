import { describe, expect, it } from 'vitest';
import type { ApprovalPlan, ApprovalRecord, ChangeSetRecord, OperationDefinition } from '@aiops/core';
import { changesetDetail, checkPageStart, toApprover, viewerBlock, type PageViewer } from './detail.js';

const ID = '11111111-1111-4111-8111-111111111111';
const HASH = `sha256:${'a'.repeat(64)}`;
const CREATED = new Date('2026-11-17T09:50:00.000Z');
const SUBMITTED = new Date('2026-11-17T09:59:00.000Z');
const NOW = new Date('2026-11-17T10:00:00.000Z');
const EXPIRES = new Date('2026-11-17T11:00:00.000Z');
const ARGS = { skus: ['ACME-1', 'ACME-2', 'ACME-3', 'ACME-4'], fields: { meta_title: 'New <title>' } };

const PLAN: ApprovalPlan = { reason: 'above_threshold', steps: ['content_lead', 'brand_owner'], widget: false, threshold: 2, included: 3 };

const OPERATION: OperationDefinition = {
  id: 'catalog.update_content',
  toolName: 'catalog_update_content',
  source: 'config',
  connection: 'magento',
  risk: 'write',
  title: 'Update content',
  description: 'Update product content.',
  inputSchema: { type: 'object' },
};

/** A prepared change-set, never submitted for approval. */
function prepared(): ChangeSetRecord {
  return {
    id: ID,
    operation: 'catalog.update_content',
    connection: 'magento',
    requester: 'alice',
    clientId: 'claude-desktop',
    args: ARGS,
    hash: HASH,
    status: 'prepared',
    stats: { total: 4, included: 3, excluded: { not_found: 1 }, written: 0, failed: 0, skipped: 0 },
    configHash: 'cfg',
    correlationId: 'corr-1',
    createdAt: CREATED,
    preparedAt: CREATED,
    expiresAt: EXPIRES,
    approvalRound: 0,
  };
}

function pending(overrides: Partial<ChangeSetRecord> = {}): ChangeSetRecord {
  return {
    ...prepared(),
    status: 'pending_approval',
    approvalRound: 1,
    submission: {
      actor: 'alice',
      groups: ['content-managers'],
      clientId: 'claude-desktop',
      correlationId: 'corr-2',
      at: SUBMITTED,
      role: 'content_manager',
      rule: 'role:content_manager/grant:own-brands-content',
    },
    approvalPlan: PLAN,
    awaitingRole: 'content_lead',
    ...overrides,
  };
}

function approval(overrides: Partial<ApprovalRecord> = {}): ApprovalRecord {
  return {
    id: 'ap-1',
    changesetId: ID,
    round: 1,
    step: 1,
    role: 'content_lead',
    approver: 'dave-sub',
    approverName: 'dave',
    decision: 'approved',
    hash: HASH,
    itemCount: 3,
    channel: 'page',
    authTime: SUBMITTED,
    correlationId: 'corr-3',
    ts: new Date('2026-11-17T09:59:30.000Z'),
    ...overrides,
  };
}

/** dave's step-1 approval; the change-set now awaits erin's step 2. */
const daveApproved = approval({ comment: '<b>ok</b>' });
const atStep2 = pending({ awaitingRole: 'brand_owner' });

function viewer(subject: string, roles: readonly string[], overrides: Partial<PageViewer> = {}): PageViewer {
  return { subject, roles, clientId: 'aiops-pages', authTime: new Date(NOW.getTime() - 10_000), fresh: true, ...overrides };
}
const alice = viewer('alice', ['content_manager']);
const dave = viewer('dave-sub', ['content_lead'], { name: 'dave' });
const erin = viewer('erin-sub', ['brand_owner'], { name: 'erin' });

describe('changesetDetail', () => {
  it('APR-5 the detail carries the stored request, policy, stats, hash and expiry', () => {
    const cs = pending();
    const d = changesetDetail({ changeset: cs, approvals: [], operation: OPERATION, viewer: dave, now: NOW });
    expect(d.request.args).toStrictEqual(ARGS);
    expect(d.request.submittedAt).toBe(SUBMITTED.toISOString());
    expect(d.request).toStrictEqual({
      args: ARGS,
      requester: 'alice',
      clientId: 'claude-desktop',
      createdAt: CREATED.toISOString(),
      submittedAt: SUBMITTED.toISOString(),
    });
    expect(d.policy).toStrictEqual({
      rule: 'role:content_manager/grant:own-brands-content',
      role: 'content_manager',
      approval: { reason: 'above_threshold', threshold: 2, included: 3 },
    });
    expect(d.hash).toBe(HASH);
    expect(d.stats).toStrictEqual(cs.stats);
    expect(d.expiresAt).toBe(EXPIRES.toISOString());
    expect(d.id).toBe(ID);
    expect(d.status).toBe('pending_approval');
    expect(d.connection).toBe('magento');
    expect(d.operation).toStrictEqual({ id: 'catalog.update_content', title: 'Update content', description: 'Update product content.', risk: 'write' });
  });

  it('APR-3 the approval chain shows each step with its decision, comment as stored text', () => {
    const d = changesetDetail({ changeset: atStep2, approvals: [daveApproved], operation: OPERATION, viewer: erin, now: NOW });
    expect(d.approval?.round).toBe(1);
    expect(d.approval?.steps).toHaveLength(2);
    expect(d.approval?.steps[0]).toStrictEqual({
      step: 1,
      role: 'content_lead',
      decision: { approver: 'dave-sub', name: 'dave', decision: 'approved', channel: 'page', comment: '<b>ok</b>', ts: daveApproved.ts.toISOString() },
    });
    expect(d.approval?.steps[0]?.decision?.comment).toBe('<b>ok</b>');
    expect(d.approval?.steps[1]).toStrictEqual({ step: 2, role: 'brand_owner' });
    expect(d.approval?.steps[1]?.decision).toBeUndefined();
    expect(d.approval?.awaitingRole).toBe('brand_owner');
    expect(d.approval?.stepUp).toBeUndefined();
  });

  it('APR-3 decisions of an earlier round are not shown in the current round', () => {
    const cs = pending({ approvalRound: 2 });
    const d = changesetDetail({ changeset: cs, approvals: [approval({ decision: 'returned', comment: 'fix' })], viewer: dave, now: NOW });
    expect(d.approval?.round).toBe(2);
    expect(d.approval?.steps[0]?.decision).toBeUndefined();
  });

  it('APR-5 a change-set never submitted has no approval or policy block', () => {
    const cs = prepared();
    const d = changesetDetail({ changeset: cs, approvals: [], operation: OPERATION, viewer: alice, now: NOW });
    expect(d.approval).toBeUndefined();
    expect(d.policy).toBeUndefined();
    expect(d.request.submittedAt).toBeUndefined();
  });

  it('APR-5 progress and errorCode are passed through when present', () => {
    const cs = pending({ status: 'executing', errorCode: 'drift' });
    const d = changesetDetail({
      changeset: cs,
      approvals: [],
      operation: OPERATION,
      progress: { status: 'executing', total: 3, done: 1, failed: 0, skipped: 0 },
      viewer: alice,
      now: NOW,
    });
    expect(d.progress).toStrictEqual({ total: 3, done: 1, failed: 0, skipped: 0 });
    expect(d.errorCode).toBe('drift');
  });

  it('AUTH-6 the approval block carries the plan step-up', () => {
    const cs = pending({ approvalPlan: { ...PLAN, stepUp: { maxAgeSeconds: 120 } } });
    expect(changesetDetail({ changeset: cs, approvals: [], viewer: dave, now: NOW }).approval?.stepUp).toStrictEqual({ maxAgeSeconds: 120 });
  });

  it('UI-2 an unconfigured operation shows its id only', () => {
    const d = changesetDetail({ changeset: pending(), approvals: [], viewer: dave, now: NOW });
    expect(d.operation).toStrictEqual({ id: 'catalog.update_content' });
  });

  it('UI-2 the operation title falls back to its id', () => {
    const untitled: OperationDefinition = { id: OPERATION.id, toolName: OPERATION.toolName, source: OPERATION.source, connection: OPERATION.connection, risk: OPERATION.risk, description: OPERATION.description, inputSchema: OPERATION.inputSchema };
    const d = changesetDetail({ changeset: pending(), approvals: [], operation: untitled, viewer: dave, now: NOW });
    expect(d.operation).toStrictEqual({ id: 'catalog.update_content', title: 'catalog.update_content', description: 'Update product content.', risk: 'write' });
  });
});

describe('viewerBlock', () => {
  it('UI-7 viewer.canDecide only for the awaiting role', () => {
    expect(viewerBlock(pending(), [], dave, NOW)).toStrictEqual({ canDecide: true, reason: null, fresh: true, stepUpSatisfied: true, canStart: false });
    const e = viewerBlock(pending(), [], erin, NOW);
    expect(e.canDecide).toBe(false);
    expect(e.reason).toBe('not_approver');
  });

  it('APR-2 viewer.reason separation_of_duties for the requester and for the step-1 approver at step 2', () => {
    const requester = viewerBlock(pending(), [], viewer('alice', ['content_manager', 'content_lead']), NOW);
    expect(requester).toMatchObject({ canDecide: false, reason: 'separation_of_duties' });
    const daveBoth = viewer('dave-sub', ['content_lead', 'brand_owner'], { name: 'dave' });
    expect(viewerBlock(atStep2, [daveApproved], daveBoth, NOW)).toMatchObject({ canDecide: false, reason: 'separation_of_duties' });
    expect(viewerBlock(atStep2, [daveApproved], erin, NOW)).toMatchObject({ canDecide: true, reason: null });
  });

  it('AUTH-6 viewer.stepUpSatisfied false with canDecide true when the login predates the submission', () => {
    const cs = pending({ approvalPlan: { ...PLAN, stepUp: { maxAgeSeconds: 120 } } });
    const early = viewer('dave-sub', ['content_lead'], { authTime: new Date(SUBMITTED.getTime() - 1000) });
    expect(viewerBlock(cs, [], early, NOW)).toMatchObject({ canDecide: true, reason: null, stepUpSatisfied: false });
    expect(viewerBlock(cs, [], dave, NOW)).toMatchObject({ canDecide: true, reason: null, stepUpSatisfied: true });
  });

  it('CS-6 viewer.reason expired after expiresAt', () => {
    const late = new Date(EXPIRES.getTime() + 1);
    expect(viewerBlock(pending(), [], dave, late)).toMatchObject({ canDecide: false, reason: 'expired', canStart: false });
  });

  it('CS-6 viewer.reason expired for a change-set whose status is already expired', () => {
    expect(viewerBlock(pending({ status: 'expired' }), [], dave, NOW)).toMatchObject({ canDecide: false, reason: 'expired' });
  });

  it('SEC-8 viewer.fresh passes the session freshness through', () => {
    expect(viewerBlock(pending(), [], { ...dave, fresh: false }, NOW).fresh).toBe(false);
    expect(viewerBlock(pending(), [], dave, NOW).fresh).toBe(true);
  });

  it('UI-7 the detail embeds the viewer block', () => {
    expect(changesetDetail({ changeset: pending(), approvals: [], viewer: dave, now: NOW }).viewer).toStrictEqual(viewerBlock(pending(), [], dave, NOW));
  });

  it('APR-7 viewer.canStart for the last step role on an approved change-set', () => {
    const approved = pending({ status: 'approved' });
    expect(viewerBlock(approved, [daveApproved], erin, NOW)).toMatchObject({ canStart: true, canDecide: false, reason: 'not_pending' });
  });
});

describe('checkPageStart', () => {
  it('APR-7 checkPageStart: not_permitted for a non-last-step role, not_approved_status while pending, expired, ok for the last step role on approved', () => {
    const approved = pending({ status: 'approved' });
    const done = [daveApproved, approval({ id: 'ap-2', step: 2, role: 'brand_owner', approver: 'erin-sub', approverName: 'erin' })];
    expect(checkPageStart(approved, done, dave, NOW)).toBe('not_permitted');
    expect(checkPageStart(approved, done, alice, NOW)).toBe('not_permitted');
    expect(checkPageStart(atStep2, [daveApproved], erin, NOW)).toBe('not_approved_status');
    expect(checkPageStart(approved, done, erin, new Date(EXPIRES.getTime() + 1))).toBe('expired');
    expect(checkPageStart(pending({ status: 'expired' }), done, erin, NOW)).toBe('expired');
    expect(checkPageStart(approved, done, erin, NOW)).toBeUndefined();
  });

  it('UI-7 checkPageStart: not_found for a viewer who cannot see the change-set', () => {
    expect(checkPageStart(pending({ status: 'approved' }), [], viewer('mallory', ['catalog_editor']), NOW)).toBe('not_found');
  });
});

describe('toApprover', () => {
  it('AUTH-6 maps the page viewer to the approver identity', () => {
    expect(toApprover(dave)).toStrictEqual({ subject: 'dave-sub', name: 'dave', roles: ['content_lead'], clientId: 'aiops-pages', authTime: dave.authTime });
    expect(toApprover(alice)).toStrictEqual({ subject: 'alice', roles: ['content_manager'], clientId: 'aiops-pages', authTime: alice.authTime });
  });
});
