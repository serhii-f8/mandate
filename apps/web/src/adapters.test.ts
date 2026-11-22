// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Mandate Authors
import { describe, expect, it } from 'vitest';
import type { ChangeSetDetail, ItemsPage, Sample } from './api.js';
import { toApprovalModel, toChangeSetModel, toItemsPage } from './adapters.js';
import approverAnswer from './fixtures/detail-approver.json' with { type: 'json' };
import requesterAnswer from './fixtures/detail-requester.json' with { type: 'json' };

// Recorded detail answers of `GET /api/v1/changesets/:id` (apps/api/src/approvals/detail.ts).
const requester: ChangeSetDetail = requesterAnswer;
const approver: ChangeSetDetail = approverAnswer;

const items: ItemsPage = {
  items: [
    { targetId: 'TS-1', status: 'pending', before: { price: '10.00' }, after: { price: '11.00' } },
    { targetId: 'TS-2', status: 'excluded', reason: 'requester', before: { price: '20.00' }, after: { price: '22.00' } },
  ],
  next: 'cursor-2',
};
const sample: Sample = { seed: 'b'.repeat(32), items: [{ targetId: 'TS-1', status: 'pending', before: 1, after: 2 }] };
const FRESH = '/auth/login?return_to=%2Fapp%2Fchangesets%2Fx&fresh=1';

describe('page adapters', () => {
  it('UI-1 the requester detail maps to the change-set model with page permissions', () => {
    const model = toChangeSetModel(requester, items, 'pending');
    expect(model).toEqual({
      id: requester.id,
      kind: 'diff',
      operation: { id: 'catalog.update_prices', title: 'Update prices' },
      status: 'prepared',
      hash: requester.hash,
      createdAt: '2030-01-01T09:00:00.000Z',
      expiresAt: '2030-01-08T09:00:00.000Z',
      stats: requester.stats,
      items: toItemsPage(items),
      itemFilter: 'pending',
      derivedFrom: '3f2b8c1e-5d4a-4e6f-9a7b-1c2d3e4f5a6b',
      rollback: { available: false },
      permissions: { canExclude: true, canSubmit: true, canCancel: false },
    });
    expect('pageUrl' in model).toBe(false);
    expect(toItemsPage(items)).toEqual(items);
    expect(toItemsPage({ items: [] })).toEqual({ items: [] });
    expect('itemFilter' in toChangeSetModel(requester, items)).toBe(false);
  });

  it('APR-5 the approver detail maps to the approval model with channel page and needsFreshLogin', () => {
    const model = toApprovalModel(approver, items, sample, FRESH);
    expect(model).toEqual({
      id: approver.id,
      kind: 'diff',
      status: 'pending_approval',
      hash: approver.hash,
      operation: approver.operation,
      request: approver.request,
      policy: approver.policy,
      stats: approver.stats,
      expiresAt: approver.expiresAt,
      approval: {
        round: 2,
        steps: [
          {
            step: 1,
            role: 'content_lead',
            decision: { decision: 'approve', by: 'Dave Lead', channel: 'widget', comment: 'Prices checked.', ts: '2030-01-01T10:00:00.000Z' },
          },
          { step: 2, role: 'finance' },
        ],
        awaitingRole: 'finance',
      },
      sample,
      items: toItemsPage(items),
      viewer: { channel: 'page', canDecide: true, reason: null, needsFreshLogin: true, canStart: false },
      freshLoginUrl: FRESH,
    });
    // Without a display name the approver's subject shows.
    const first = approver.approval?.steps[0];
    if (first?.decision === undefined) throw new Error('fixture lacks a decision');
    const unnamed = { ...first.decision };
    delete unnamed.name;
    const plain = toApprovalModel(
      { ...approver, approval: { round: 2, steps: [{ ...first, decision: unnamed }] } },
      items,
      sample,
      FRESH,
    );
    expect(plain.approval?.steps[0]?.decision?.by).toBe('dave');
    // Fresh and step-up satisfied: no new login; cannot decide: never a login prompt.
    const satisfied = { ...approver, viewer: { ...approver.viewer, stepUpSatisfied: true } };
    expect(toApprovalModel(satisfied, items, sample, FRESH).viewer.needsFreshLogin).toBe(false);
    const stale = { ...satisfied, viewer: { ...satisfied.viewer, fresh: false } };
    expect(toApprovalModel(stale, items, sample, FRESH).viewer.needsFreshLogin).toBe(true);
    const refused = { ...stale, viewer: { ...stale.viewer, canDecide: false, reason: 'not_approver' } };
    expect(toApprovalModel(refused, items, sample, FRESH, 'failed')).toMatchObject({
      viewer: { canDecide: false, reason: 'not_approver', needsFreshLogin: false },
      itemFilter: 'failed',
    });
  });

  it('UI-4 drift and rollback pass through', () => {
    const done: ChangeSetDetail = {
      ...requester,
      status: 'completed_with_errors',
      progress: { total: 3, done: 3, failed: 1, skipped: 0 },
      errorCode: 'partial_failure',
      drift: 2,
      viewer: { ...requester.viewer, canSubmit: false, canExclude: false },
    };
    expect(toChangeSetModel(done, items)).toMatchObject({
      status: 'completed_with_errors',
      progress: { total: 3, done: 3, failed: 1, skipped: 0 },
      errorCode: 'partial_failure',
      drift: 2,
      rollback: { available: false },
      permissions: { canExclude: false, canSubmit: false, canCancel: false },
    });
    expect('drift' in toChangeSetModel(requester, items)).toBe(false);
  });

  it('CS-3 the reason titles reach both models; none or an empty map adds nothing', () => {
    const titled: ChangeSetDetail = { ...requester, reasonTitles: { locked: 'Note is locked' } };
    expect(toChangeSetModel(titled, items).reasonTitles).toEqual({ locked: 'Note is locked' });
    expect(toApprovalModel(titled, items, sample, FRESH).reasonTitles).toEqual({ locked: 'Note is locked' });
    expect('reasonTitles' in toChangeSetModel({ ...requester, reasonTitles: {} }, items)).toBe(false);
    expect('reasonTitles' in toApprovalModel(requester, items, sample, FRESH)).toBe(false);
  });

  it('APR-5 the stored action reaches both models; an update carries none', () => {
    const created: ChangeSetDetail = { ...requester, action: 'create' };
    expect(toChangeSetModel(created, items).action).toBe('create');
    expect(toApprovalModel(created, items, sample, FRESH).action).toBe('create');
    expect('action' in toChangeSetModel({ ...requester, action: 'update' }, items)).toBe(false);
    expect('action' in toApprovalModel({ ...requester, action: 'update' }, items, sample, FRESH)).toBe(false);
    expect('action' in toApprovalModel(requester, items, sample, FRESH)).toBe(false);
  });

  it('UI-2 APR-5 an opaque detail maps kind and arguments; a diff detail has none', () => {
    const opaque: ChangeSetDetail = { ...requester, kind: 'opaque', request: { ...requester.request, args: { text: 'x' } } };
    expect(toChangeSetModel(opaque, items)).toMatchObject({ kind: 'opaque', args: { text: 'x' } });
    expect(toApprovalModel(opaque, items, sample, FRESH).kind).toBe('opaque');
    const diff = toChangeSetModel(requester, items);
    expect(diff.kind).toBe('diff');
    expect('args' in diff).toBe(false);
  });
});
