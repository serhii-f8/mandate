// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Mandate Authors
import { isCallToolResult, type CallToolResult } from '@modelcontextprotocol/client';
import { describe, expect, it } from 'vitest';
import { fromGetChangeset, fromReviewChangeset, parseApprovalTrigger, parseChangeSetTrigger } from './adapters.js';
import completed from './fixtures/get-changeset-completed.json' with { type: 'json' };
import executing from './fixtures/get-changeset-executing.json' with { type: 'json' };
import pending from './fixtures/get-changeset-pending.json' with { type: 'json' };
import getPrepared from './fixtures/get-changeset-prepared.json' with { type: 'json' };
import errorTextOnly from './fixtures/error-text-only.json' with { type: 'json' };
import exclude from './fixtures/exclude.json' with { type: 'json' };
import prepared from './fixtures/prepared.json' with { type: 'json' };
import preparing from './fixtures/preparing.json' with { type: 'json' };
import review from './fixtures/review-changeset.json' with { type: 'json' };
import reviewDenied from './fixtures/review-changeset-widget-denied.json' with { type: 'json' };
import submitExecuting from './fixtures/submit-executing.json' with { type: 'json' };
import submitPending from './fixtures/submit-pending.json' with { type: 'json' };

const A = '0b6f0c2e-8a51-4c2b-9d0e-6f1a2b3c4d5e';
const B = '7c1d2e3f-4a5b-4c6d-8e7f-9a0b1c2d3e4f';
const PAGE_A = `https://mandate.example.test/app/changesets/${A}`;
const HASH_A = `sha256:${'a'.repeat(64)}`;

function answer(json: unknown): CallToolResult {
  if (!isCallToolResult(json)) throw new Error('fixture is not a CallToolResult');
  return json;
}

const ALL = { prepared, preparing, getPrepared, pending, executing, completed, exclude, submitPending, submitExecuting, review, reviewDenied, errorTextOnly };

describe('widget adapters', () => {
  it('UI-1 every fixture is a whole CallToolResult whose JSON block repeats its structured content', () => {
    for (const [name, json] of Object.entries(ALL)) {
      const result = answer(json);
      const [, data] = result.content;
      if (result.structuredContent !== undefined && data?.type === 'text') {
        expect(JSON.parse(data.text), name).toEqual(result.structuredContent);
      }
    }
  });

  it('APR-6 MCP-4 the action of a prepared result and of a review detail reaches the models; older answers still parse', () => {
    const base = prepared.structuredContent;
    const create = { ...answer(prepared), structuredContent: { ...base, changeset: { ...base.changeset, action: 'create' } } };
    const t = parseChangeSetTrigger(create);
    expect(t.kind === 'view' && t.model.action).toBe('create');
    const plain = parseChangeSetTrigger(answer(prepared));
    expect(plain.kind === 'view' && 'action' in plain.model).toBe(false);
    const rv = review.structuredContent;
    const del = { ...answer(review), structuredContent: { ...rv, detail: { ...rv.detail, action: 'delete' } } };
    const a = parseApprovalTrigger(del);
    expect(a.kind === 'view' && a.model.action).toBe('delete');
    const old = parseApprovalTrigger(answer(review));
    expect(old.kind === 'view' && 'action' in old.model).toBe(false);
  });

  it('CS-3 the reason titles of a review detail reach the approval model; older answers still parse', () => {
    const rv = review.structuredContent;
    const titled = { ...answer(review), structuredContent: { ...rv, detail: { ...rv.detail, reasonTitles: { locked: 'Note is locked' } } } };
    const a = parseApprovalTrigger(titled);
    expect(a.kind === 'view' && a.model.reasonTitles).toEqual({ locked: 'Note is locked' });
    const old = parseApprovalTrigger(answer(review));
    expect(old.kind === 'view' && 'reasonTitles' in old.model).toBe(false);
  });

  it('EXE-12 verification counts, item codes and titles of a get_changeset answer reach the model; older answers still parse', () => {
    const base = answer(prepared).structuredContent as { changeset: { stats: object }; items: object[] };
    const verification = { pending: 1, confirmed: 2, unconfirmed: 1 };
    const verified = {
      ...answer(prepared),
      structuredContent: {
        ...base,
        changeset: { ...base.changeset, stats: { ...base.changeset.stats, verification } },
        items: [{ targetId: 'x', status: 'written', before: 1, after: 2, verificationStatus: 'unconfirmed', verificationCode: 'missing_in_shop' }],
        verificationTitles: { missing_in_shop: 'Missing in the shop' },
      },
    };
    const t = parseChangeSetTrigger(verified);
    expect(t.kind === 'view' && t.model.stats.verification).toEqual(verification);
    expect(t.kind === 'view' && t.model.verificationTitles).toEqual({ missing_in_shop: 'Missing in the shop' });
    expect(t.kind === 'view' && t.model.items.items[0]).toMatchObject({ verificationStatus: 'unconfirmed', verificationCode: 'missing_in_shop' });
    const old = parseChangeSetTrigger(answer(prepared));
    expect(old.kind === 'view' && ('verificationTitles' in old.model || 'verification' in old.model.stats)).toBe(false);
  });

  it('UI-4 CS-9 the plan of a get_changeset answer and of a review detail reaches the models without links; older answers still parse', () => {
    const plan = {
      id: B,
      title: 'Spring launch',
      step: 2,
      of: 2,
      steps: [
        { step: 1, id: A, operation: 'shop.retire', status: 'executing', visible: true },
        { step: 2, id: B, operation: 'shop.update', status: 'approved', visible: true },
      ],
      startLine: 'Runs after step 1 completes (now: executing)',
    };
    const expected = {
      title: 'Spring launch',
      step: 2,
      of: 2,
      steps: [
        { step: 1, id: A, operation: 'shop.retire', status: 'executing' },
        { step: 2, id: B, operation: 'shop.update', status: 'approved' },
      ],
      startLine: 'Runs after step 1 completes (now: executing)',
    };
    const base = answer(getPrepared).structuredContent as object;
    const t = parseChangeSetTrigger({ ...answer(getPrepared), structuredContent: { ...base, plan: { ...plan, steps: plan.steps.map((s) => ({ step: s.step, id: s.id, operation: s.operation, status: s.status })) } } });
    expect(t.kind === 'view' && t.model.plan).toEqual(expected);
    const rv = review.structuredContent;
    const a = parseApprovalTrigger({ ...answer(review), structuredContent: { ...rv, detail: { ...rv.detail, plan } } });
    // The widget has no way to open another change-set: no step carries a link.
    expect(a.kind === 'view' && a.model.plan).toEqual(expected);
    const old = parseChangeSetTrigger(answer(getPrepared));
    expect(old.kind === 'view' && 'plan' in old.model).toBe(false);
    const oldReview = parseApprovalTrigger(answer(review));
    expect(oldReview.kind === 'view' && 'plan' in oldReview.model).toBe(false);
  });

  it('UI-1 a prepared result and a get_changeset answer become a view model', () => {
    const fromPrepared = parseChangeSetTrigger(answer(prepared));
    expect(fromPrepared.kind).toBe('view');
    if (fromPrepared.kind !== 'view') return;
    expect(fromPrepared.model).toEqual({
      id: A,
      kind: 'diff',
      operation: { id: 'catalog.update_names' },
      status: 'prepared',
      hash: HASH_A,
      createdAt: '2030-01-01T09:00:00.000Z',
      expiresAt: '2030-01-08T09:00:00.000Z',
      stats: { total: 3, included: 2, excluded: { no_change: 1 }, written: 0, failed: 0, skipped: 0 },
      items: {
        items: [
          { targetId: 'UMBRELLA-0001', status: 'pending', before: { name: 'Old text' }, after: { name: 'New text' } },
          { targetId: 'UMBRELLA-0002', status: 'pending', before: { name: 'Old text' }, after: { name: 'New text' } },
          { targetId: 'UMBRELLA-0003', status: 'excluded', reason: 'no_change', before: { name: 'Old text' }, after: { name: 'Old text' } },
        ],
      },
      rollback: { available: false },
      pageUrl: PAGE_A,
      permissions: { canExclude: true, canSubmit: true, canCancel: false },
    });

    const fromGet = parseChangeSetTrigger(answer(getPrepared));
    expect(fromGet.kind).toBe('view');
    if (fromGet.kind !== 'view') return;
    expect(fromGet.model.id).toBe(A);
    expect(fromGet.model.hash).toBe(HASH_A);
    expect(fromGet.model.stats.included).toBe(2);
    expect(fromGet.model.items.items.map((i) => i.targetId)).toEqual(['UMBRELLA-0001', 'UMBRELLA-0002']);
    expect(fromGet.model.items.next).toBe(getPrepared.structuredContent.nextCursor);

    const derived = parseChangeSetTrigger(answer(exclude));
    expect(derived.kind === 'view' && derived.model).toMatchObject({ id: B, derivedFrom: A, status: 'prepared' });
    // An object operation from a later server is read too (F13).
    const withTitle = fromGetChangeset({ ...getPrepared.structuredContent, changeset: { ...getPrepared.structuredContent.changeset, operation: { id: 'x', title: 'X' } } }, 'pending');
    expect(withTitle?.operation).toEqual({ id: 'x', title: 'X' });
    expect(withTitle?.itemFilter).toBe('pending');
    // The executing answer may be cancelled from the widget only.
    expect(fromGetChangeset(executing.structuredContent)).toMatchObject({
      status: 'executing',
      progress: { total: 2, done: 1, failed: 0, skipped: 0 },
      permissions: { canExclude: false, canSubmit: false, canCancel: true },
    });
  });

  it('UI-1 a result with only an ID asks the widget to load it', () => {
    expect(parseChangeSetTrigger(answer(preparing))).toEqual({ kind: 'load', id: A, pageUrl: PAGE_A });
    expect(parseChangeSetTrigger(answer(submitPending))).toEqual({ kind: 'load', id: A, pageUrl: PAGE_A });
    expect(parseChangeSetTrigger(answer(submitExecuting))).toEqual({ kind: 'load', id: A, pageUrl: PAGE_A });
    // A preparation error with an ID shows the stored state.
    const failed: CallToolResult = {
      isError: true,
      content: [{ type: 'text', text: 'failed' }],
      structuredContent: { changeset: { id: A, status: 'failed', errorCode: 'internal' } },
    };
    expect(parseChangeSetTrigger(failed)).toEqual({ kind: 'load', id: A });
    // A changeset block with items but a broken field still has a usable ID.
    const broken: CallToolResult = { content: [], structuredContent: { ...prepared.structuredContent, changeset: { ...prepared.structuredContent.changeset, stats: 'x' } } };
    expect(parseChangeSetTrigger(broken)).toEqual({ kind: 'load', id: A, pageUrl: PAGE_A });
  });

  it('UI-1 an unparsable result shows its text and the page link', () => {
    expect(parseChangeSetTrigger(answer(errorTextOnly))).toEqual({ kind: 'text', text: `Change-set ${A} was not found.` });
    expect(parseChangeSetTrigger({ content: [{ type: 'text', text: 'x' }], structuredContent: { changeset: 7 } })).toEqual({ kind: 'text', text: 'x' });
    expect(
      parseChangeSetTrigger({ isError: true, content: [{ type: 'text', text: 'denied' }], structuredContent: { pageUrl: PAGE_A } }),
    ).toEqual({ kind: 'text', text: 'denied', pageUrl: PAGE_A });
    // Wrong types never throw: a numeric pageUrl is dropped, a non-UUID ID is no ID.
    expect(
      parseChangeSetTrigger({ content: [{ type: 'text', text: 'y' }], structuredContent: { changesetId: 'not-a-uuid', pageUrl: 5, changeset: { id: 3 }, items: 'no' } }),
    ).toEqual({ kind: 'text', text: 'y' });
    expect(parseChangeSetTrigger({ content: [] })).toEqual({ kind: 'text', text: '' });
    expect(fromGetChangeset(null)).toBeUndefined();
    expect(fromGetChangeset({ changeset: { id: A }, items: [] })).toBeUndefined();
  });

  it('SEC-5 a view needs a UUID change-set ID and a http(s) page address', () => {
    const sc = getPrepared.structuredContent;
    expect(fromGetChangeset({ ...sc, changeset: { ...sc.changeset, id: 'not-a-uuid' } })).toBeUndefined();
    for (const bad of ['javascript:alert(1)', 'data:text/html,x', '/app/changesets/x', 'https//no', '']) {
      const model = fromGetChangeset({ ...sc, pageUrl: bad });
      expect(model, bad).toBeDefined();
      expect(model, bad).not.toHaveProperty('pageUrl');
      expect(fromReviewChangeset({ ...review.structuredContent, pageUrl: bad }), bad).not.toHaveProperty('pageUrl');
      expect(parseChangeSetTrigger({ content: [{ type: 'text', text: 't' }], structuredContent: { pageUrl: bad } }), bad).toEqual({ kind: 'text', text: 't' });
      expect(parseChangeSetTrigger({ content: [], structuredContent: { changesetId: A, pageUrl: bad } }), bad).toEqual({ kind: 'load', id: A });
    }
    expect(fromGetChangeset({ ...sc, pageUrl: 'http://localhost:8080/app/changesets/x' })?.pageUrl).toBe('http://localhost:8080/app/changesets/x');
    expect(fromReviewChangeset({ ...review.structuredContent, detail: { ...review.structuredContent.detail, id: 'x' } })).toBeUndefined();
  });

  it('APR-5 the pending answer maps decisions to steps and the awaiting role', () => {
    const model = fromGetChangeset(pending.structuredContent);
    expect(model?.approval).toEqual({
      round: 1,
      steps: [
        { step: 1, role: 'content_lead', decision: { decision: 'approve', by: 'dave', channel: 'widget', ts: '2030-01-01T10:00:00.000Z', comment: 'Names checked.' } },
        { step: 2, role: 'finance' },
      ],
      awaitingRole: 'finance',
    });
    expect(model?.permissions).toEqual({ canExclude: false, canSubmit: false, canCancel: false });
    // Only a pending change-set awaits a role; the last decision of a step counts.
    const later = fromGetChangeset({
      ...pending.structuredContent,
      changeset: { ...pending.structuredContent.changeset, status: 'approved' },
      approval: {
        ...pending.structuredContent.approval,
        decisions: [
          ...pending.structuredContent.approval.decisions,
          { step: 2, role: 'finance', approver: 'erin', decision: 'approve', channel: 'page', ts: '2030-01-01T11:00:00.000Z' },
        ],
      },
    });
    expect(later?.approval?.awaitingRole).toBeUndefined();
    expect(later?.approval?.steps[1]?.decision?.by).toBe('erin');
  });

  it('UI-4 get_changeset rollback count, until and stats reach the model', () => {
    const rollback = { available: true, count: 3, until: '2030-02-01T00:00:00.000Z', stats: { restored: 2, skipped: 0, failed: 1 } };
    const model = fromGetChangeset({ ...completed.structuredContent, rollback });
    expect(model?.rollback).toEqual(rollback);
    expect(fromGetChangeset({ ...completed.structuredContent, rollback: { available: false, reason: 'window_closed' } })?.rollback).toEqual({ available: false });
  });

  it('UI-4 the completed answer carries drift and rollback unavailable', () => {
    const model = fromGetChangeset(completed.structuredContent);
    expect(model).toMatchObject({
      status: 'completed_with_errors',
      drift: 1,
      rollback: { available: false },
      progress: { total: 2, done: 2, failed: 1, skipped: 0 },
      permissions: { canExclude: false, canSubmit: false, canCancel: false },
    });
    expect(model?.items.items[1]).toEqual({ targetId: 'UMBRELLA-0002', status: 'failed', before: { name: 'Old text' }, after: { name: 'New text' }, error: 'drift' });
    // An answer from today's server (no rollback block) defaults to unavailable.
    const today: Record<string, unknown> = { ...completed.structuredContent };
    delete today.rollback;
    delete today.execution;
    expect(fromGetChangeset(today)).toMatchObject({ rollback: { available: false } });
    expect(fromGetChangeset(today)?.drift).toBeUndefined();
  });

  it('APR-8 review_changeset maps canDecide and reason for the widget channel', () => {
    const trigger = parseApprovalTrigger(answer(review));
    expect(trigger.kind).toBe('view');
    if (trigger.kind !== 'view') return;
    expect(trigger.model).toEqual({
      id: A,
      kind: 'diff',
      status: 'pending_approval',
      hash: HASH_A,
      operation: { id: 'catalog.update_names', title: 'Update names', description: 'Sets the name of catalog products.', risk: 'medium' },
      request: { args: { sku_prefix: 'UMBRELLA-' }, requester: 'ann', clientId: 'claude-desktop', createdAt: '2030-01-01T09:00:00.000Z', submittedAt: '2030-01-01T09:05:00.000Z' },
      policy: { rule: 'name-updates', role: 'content_editor', approval: { reason: 'threshold', threshold: 1, included: 2 } },
      stats: { total: 3, included: 2, excluded: { no_change: 1 }, written: 0, failed: 0, skipped: 0 },
      expiresAt: '2030-01-08T09:00:00.000Z',
      approval: {
        round: 1,
        steps: [
          { step: 1, role: 'content_lead', decision: { decision: 'approve', by: 'Dave Lead', channel: 'widget', ts: '2030-01-01T10:00:00.000Z', comment: 'Names checked.' } },
          { step: 2, role: 'finance' },
        ],
        awaitingRole: 'finance',
      },
      sample: { seed: 'seed-0001', items: [{ targetId: 'UMBRELLA-0002', status: 'pending', before: { name: 'Old text' }, after: { name: 'New text' } }] },
      items: {
        items: [
          { targetId: 'UMBRELLA-0001', status: 'pending', before: { name: 'Old text' }, after: { name: 'New text' } },
          { targetId: 'UMBRELLA-0002', status: 'pending', before: { name: 'Old text' }, after: { name: 'New text' } },
        ],
        next: review.structuredContent.nextCursor,
      },
      viewer: { channel: 'widget', canDecide: true, reason: null, needsFreshLogin: false, canStart: false },
      pageUrl: PAGE_A,
    });

    const denied = parseApprovalTrigger(answer(reviewDenied));
    expect(denied.kind === 'view' && denied.model.viewer).toEqual({
      channel: 'widget',
      canDecide: false,
      reason: 'widget_not_allowed',
      needsFreshLogin: false,
      canStart: false,
    });
    expect(fromReviewChangeset(review.structuredContent, 'failed')?.itemFilter).toBe('failed');
    // Anything else falls back to text and the link when present.
    expect(parseApprovalTrigger(answer(errorTextOnly))).toEqual({ kind: 'text', text: `Change-set ${A} was not found.` });
    expect(
      parseApprovalTrigger({ content: [{ type: 'text', text: 'z' }], structuredContent: { ...review.structuredContent, detail: { viewer: 1 } } }),
    ).toEqual({ kind: 'text', text: 'z', pageUrl: PAGE_A });
  });

  it('UI-2 APR-5 kind and args of an opaque answer reach both models; canExclude is off', () => {
    const args = { text: 'hello' };
    const structured = <T,>(o: T): T => structuredClone(o);
    const get = structured(getPrepared.structuredContent) as { changeset: Record<string, unknown> };
    expect(fromGetChangeset(get)).toMatchObject({ kind: 'diff', permissions: { canExclude: true } });
    get.changeset.kind = 'opaque';
    get.changeset.args = args;
    const model = fromGetChangeset(get);
    expect(model).toMatchObject({ kind: 'opaque', args, permissions: { canExclude: false, canSubmit: true } });
    const rev = structured(review.structuredContent) as { detail: Record<string, unknown> };
    expect(fromReviewChangeset(rev)?.kind).toBe('diff');
    rev.detail.kind = 'opaque';
    expect(fromReviewChangeset(rev)?.kind).toBe('opaque');
  });
});
