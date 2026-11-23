// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Mandate Authors
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ActionResult, ApprovalActions, ApprovalViewModel, ItemRowModel } from '../model.js';
import { approvalModel } from '../test-fixtures.js';
import { ApprovalView } from './ApprovalView.js';

afterEach(cleanup);

const ID = '11111111-1111-4111-8111-111111111111';
const HOSTILE = '<img src=x onerror=alert(1)>';
const HASH = `sha256:${'a'.repeat(64)}`;
const FRESH = `/auth/login?return_to=%2Fapp%2Fchangesets%2F${ID}&fresh=1`;

type Viewer = ApprovalViewModel['viewer'];

const item = (targetId: string, over: Partial<ItemRowModel> = {}): ItemRowModel => ({
  targetId,
  status: 'pending',
  before: { name: 'old' },
  after: { name: 'new' },
  ...over,
});

/** The Phase 6 page fixture, in the library's view model. */
const detail = (over: Partial<ApprovalViewModel> = {}): ApprovalViewModel =>
  approvalModel({
    id: ID,
    status: 'pending_approval',
    hash: 'abc123hash',
    operation: { id: 'catalog.update', title: 'Update brand content' },
    request: {
      args: { brand: 'acme' },
      requester: 'ann',
      clientId: 'claude-desktop',
      createdAt: '2030-01-01T00:00:00.000Z',
    },
    policy: {
      rule: 'role:content_manager/grant:own-brands-content',
      role: 'content_manager',
      approval: { reason: 'above_threshold', threshold: 2, included: 3 },
    },
    stats: { total: 4, included: 3, excluded: { not_found: 1 }, written: 0, failed: 0, skipped: 0 },
    expiresAt: '2030-02-01T00:00:00.000Z',
    approval: {
      round: 1,
      steps: [
        { step: 1, role: 'content_lead' },
        { step: 2, role: 'cto' },
      ],
      awaitingRole: 'content_lead',
    },
    sample: { seed: 's', items: [item('sku-1')] },
    items: { items: [item('sku-1'), item('sku-2')] },
    viewer: { channel: 'page', canDecide: false, reason: null, needsFreshLogin: false, canStart: false },
    freshLoginUrl: '/auth/login',
    ...over,
  });

function actionsWith(over: Partial<ApprovalActions> = {}): ApprovalActions {
  return {
    loadItems: vi.fn<ApprovalActions['loadItems']>().mockResolvedValue({ ok: true, value: { items: [] } }),
    resample: vi
      .fn<ApprovalActions['resample']>()
      .mockResolvedValue({ ok: true, value: { seed: 's2', items: [item('sku-2')] } }),
    decide: vi.fn<NonNullable<ApprovalActions['decide']>>(),
    start: vi.fn<NonNullable<ApprovalActions['start']>>(),
    ...over,
  };
}

function setup(data: ApprovalViewModel = detail(), actions: ApprovalActions = actionsWith()) {
  const onData = vi.fn<(next: ApprovalViewModel) => void>();
  const view = render(<ApprovalView data={data} actions={actions} onData={onData} />);
  return { ...view, onData, actions };
}

const flush = (): Promise<void> => act(() => Promise.resolve());

describe('ApprovalView', () => {
  it('APR-5 UI-2 the page shows status, operation title, hash, expiry, requester, client and the stored arguments', () => {
    const { container } = setup();
    const labels = Array.from(container.querySelectorAll('section')).map((s) => s.getAttribute('aria-label'));
    expect(labels).toEqual([
      'Summary',
      'Request',
      'Policy',
      'Statistics',
      'Sample',
      'Items',
      'Approval chain',
      'Decision',
    ]);
    const region = screen.getByRole('region', { name: 'Summary' });
    const summary = within(region);
    expect(summary.getByText(/pending_approval/)).toBeTruthy();
    expect(summary.getByText(/Update brand content/)).toBeTruthy();
    expect(summary.getByText(/abc123hash/)).toBeTruthy();
    expect(region.querySelector('time')?.dateTime).toBe('2030-02-01T00:00:00.000Z');
    const request = within(screen.getByRole('region', { name: 'Request' }));
    expect(request.getByText(/ann/)).toBeTruthy();
    expect(request.getByText(/claude-desktop/)).toBeTruthy();
    expect(container.querySelector('pre')?.textContent).toBe(JSON.stringify({ brand: 'acme' }, null, 2));
  });

  it('APR-5 the policy section states the rule and why approval is needed', () => {
    setup();
    const policy = within(screen.getByRole('region', { name: 'Policy' }));
    expect(policy.getByText(/role:content_manager\/grant:own-brands-content/)).toBeTruthy();
    expect(policy.getByText(/3 changes, above the threshold of 2/)).toBeTruthy();
  });

  it('APR-5 the sample shows before and after; Re-sample calls resample', async () => {
    const resample = vi
      .fn<ApprovalActions['resample']>()
      .mockResolvedValue({ ok: true, value: { seed: 's2', items: [] } });
    setup(detail(), actionsWith({ resample }));
    const sample = within(screen.getByRole('region', { name: 'Sample' }));
    expect(sample.getByText((_, el) => el?.tagName === 'TD' && el.textContent === 'name')).toBeTruthy();
    expect(sample.getByText((_, el) => el?.tagName === 'PRE' && el.textContent === 'old')).toBeTruthy();
    expect(sample.getByText((_, el) => el?.tagName === 'PRE' && el.textContent === 'new')).toBeTruthy();
    fireEvent.click(sample.getByRole('button', { name: 'Re-sample' }));
    expect(resample).toHaveBeenCalledTimes(1);
    await flush();
  });

  it('APR-5 resample replaces the sample with the new seed', async () => {
    const data = detail();
    const fresh = { seed: 'seed-2', items: [item('sku-9')] };
    const resample = vi.fn<ApprovalActions['resample']>().mockResolvedValue({ ok: true, value: fresh });
    const { onData, rerender, actions } = setup(data, actionsWith({ resample }));
    fireEvent.click(within(screen.getByRole('region', { name: 'Sample' })).getByRole('button', { name: 'Re-sample' }));
    await waitFor(() => {
      expect(onData).toHaveBeenCalledWith({ ...data, sample: fresh });
    });
    rerender(<ApprovalView data={{ ...data, sample: fresh }} actions={actions} onData={onData} />);
    const sample = within(screen.getByRole('region', { name: 'Sample' }));
    expect(sample.getByText('sku-9')).toBeTruthy();
    expect(sample.queryByText('sku-1')).toBeNull();
  });

  it('NFR-8 Next and Previous follow the item pages; the status filter calls loadItems', async () => {
    const firstLoad = vi.fn<ApprovalActions['loadItems']>().mockResolvedValue({ ok: true, value: { items: [] } });
    setup(detail(), actionsWith({ loadItems: firstLoad }));
    const items = within(screen.getByRole('region', { name: 'Items' }));
    expect(items.getByRole<HTMLButtonElement>('button', { name: 'Next' }).disabled).toBe(true);
    expect(items.getByRole<HTMLButtonElement>('button', { name: 'Previous' }).disabled).toBe(true);
    const options = Array.from(items.getByLabelText<HTMLSelectElement>('Status').options).map((o) => o.value);
    expect(options).toEqual(['', 'pending', 'excluded', 'written', 'failed', 'skipped']);
    fireEvent.change(items.getByLabelText('Status'), { target: { value: 'failed' } });
    expect(firstLoad).toHaveBeenCalledWith({ status: 'failed' });
    await flush();
    fireEvent.change(items.getByLabelText('Status'), { target: { value: '' } });
    expect(firstLoad).toHaveBeenLastCalledWith({});
    await flush();
    cleanup();
    const loadItems = vi
      .fn<ApprovalActions['loadItems']>()
      .mockResolvedValue({ ok: true, value: { items: [item('b')], next: 'cur2' } });
    setup(
      detail({ items: { items: [item('a')], next: 'cur' }, itemFilter: 'failed' }),
      actionsWith({ loadItems }),
    );
    const again = within(screen.getByRole('region', { name: 'Items' }));
    fireEvent.click(again.getByRole('button', { name: 'Next' }));
    expect(loadItems).toHaveBeenCalledTimes(1);
    expect(loadItems).toHaveBeenLastCalledWith({ after: 'cur', status: 'failed' });
    await waitFor(() => {
      expect(again.getByRole<HTMLButtonElement>('button', { name: 'Previous' }).disabled).toBe(false);
    });
    fireEvent.click(again.getByRole('button', { name: 'Previous' }));
    expect(loadItems).toHaveBeenCalledTimes(2);
    expect(loadItems).toHaveBeenLastCalledWith({ status: 'failed' });
    await flush();
  });

  it('APR-3 the approval chain shows each step, its role, decision and comment', () => {
    setup(
      detail({
        approval: {
          round: 1,
          steps: [
            {
              step: 1,
              role: 'content_lead',
              decision: {
                by: 'bob',
                decision: 'approve',
                channel: 'page',
                comment: 'looks fine',
                ts: '2030-01-02T00:00:00.000Z',
              },
            },
            { step: 2, role: 'cto' },
          ],
          awaitingRole: 'cto',
        },
      }),
    );
    const chain = within(screen.getByRole('region', { name: 'Approval chain' }));
    expect(chain.getByText(/content_lead/)).toBeTruthy();
    expect(chain.getByText(/approve/)).toBeTruthy();
    expect(chain.getByText(/looks fine/)).toBeTruthy();
    expect(chain.getByText(/cto/)).toBeTruthy();
  });

  it('SEC-5 upstream values, arguments and comments render as text', () => {
    const { container } = setup(
      detail({
        request: { args: { note: HOSTILE }, requester: 'ann', createdAt: '2030-01-01T00:00:00.000Z' },
        approval: {
          round: 1,
          steps: [
            {
              step: 1,
              role: 'content_lead',
              decision: {
                by: 'bob',
                decision: 'return',
                channel: 'page',
                comment: HOSTILE,
                ts: '2030-01-02T00:00:00.000Z',
              },
            },
          ],
        },
        items: { items: [item('x', { before: HOSTILE })] },
      }),
    );
    expect(container.querySelector('img')).toBeNull();
    expect(screen.getAllByText(/<img src=x onerror=alert\(1\)>/).length).toBeGreaterThanOrEqual(3);
  });

  const deciding = (over: Partial<Viewer> = {}): ApprovalViewModel =>
    detail({
      hash: HASH,
      viewer: { channel: 'page', canDecide: true, reason: null, needsFreshLogin: false, canStart: false, ...over },
    });
  const decision = () => within(screen.getByRole('region', { name: 'Decision' }));
  const decided = (): Promise<ActionResult<ApprovalViewModel>> =>
    Promise.resolve({ ok: true, value: detail({ status: 'approved' }) });

  it('APR-6 the approve button states the count and sends hash and count', async () => {
    const decide = vi.fn(decided);
    const { onData } = setup(deciding(), actionsWith({ decide }));
    fireEvent.click(decision().getByRole('button', { name: 'Approve 3 changes' }));
    await waitFor(() => {
      expect(decide).toHaveBeenCalledWith({ decision: 'approve', hash: HASH, count: 3 });
    });
    await waitFor(() => {
      expect(onData).toHaveBeenCalledWith(detail({ status: 'approved' }));
    });
  });

  it('APR-6 one included change reads "Approve 1 change"', () => {
    const d = deciding();
    setup({ ...d, stats: { ...d.stats, included: 1 } });
    expect(decision().getByRole('button', { name: 'Approve 1 change' })).toBeTruthy();
  });

  it('APR-4 return needs a comment; reject sends the comment', async () => {
    const decide = vi.fn(decided);
    setup(deciding(), actionsWith({ decide }));
    const panel = decision();
    const ret = panel.getByRole<HTMLButtonElement>('button', { name: 'Return with comment' });
    expect(ret.disabled).toBe(true);
    fireEvent.change(panel.getByLabelText('Comment'), { target: { value: '   ' } });
    expect(ret.disabled).toBe(true);
    fireEvent.change(panel.getByLabelText('Comment'), { target: { value: 'fix sku-2' } });
    expect(ret.disabled).toBe(false);
    fireEvent.click(ret);
    await waitFor(() => {
      expect(decide).toHaveBeenLastCalledWith({ decision: 'return', hash: HASH, count: 3, comment: 'fix sku-2' });
    });
    await waitFor(() => {
      expect(panel.getByRole<HTMLButtonElement>('button', { name: 'Reject' }).disabled).toBe(false);
    });
    fireEvent.click(panel.getByRole('button', { name: 'Reject' }));
    await waitFor(() => {
      expect(decide).toHaveBeenLastCalledWith({ decision: 'reject', hash: HASH, count: 3, comment: 'fix sku-2' });
    });
  });

  it('APR-6 a refused decision shows "Not decided: <error>"', async () => {
    const decide = (): Promise<ActionResult<ApprovalViewModel>> =>
      Promise.resolve({ ok: false, message: 'hash_mismatch' });
    setup(deciding(), actionsWith({ decide }));
    fireEvent.click(decision().getByRole('button', { name: 'Approve 3 changes' }));
    expect((await decision().findByRole('alert')).textContent).toBe('Not decided: hash_mismatch');
  });

  it('SEC-8 a stale session shows "Log in again to decide" linking to the fresh login and no decision buttons', () => {
    setup({ ...deciding({ needsFreshLogin: true }), freshLoginUrl: FRESH });
    expect(decision().getByRole('link', { name: 'Log in again to decide' }).getAttribute('href')).toBe(FRESH);
    expect(decision().queryAllByRole('button')).toHaveLength(0);
  });

  it('AUTH-6 an unsatisfied step-up shows the same re-login link', () => {
    setup({ ...deciding({ needsFreshLogin: true, reason: 'step_up_required' }), freshLoginUrl: FRESH });
    expect(decision().getByRole('link', { name: 'Log in again to decide' }).getAttribute('href')).toBe(FRESH);
    expect(decision().queryAllByRole('button')).toHaveLength(0);
  });

  it('APR-2 the requester sees why they cannot decide', () => {
    setup(deciding({ canDecide: false, reason: 'separation_of_duties' }));
    expect(
      decision().getByText('You cannot decide this step: you requested this change-set or decided an earlier step.'),
    ).toBeTruthy();
    expect(decision().queryAllByRole('button')).toHaveLength(0);
  });

  it('APR-2 each refusal reason has its fixed text, shown only while pending_approval', () => {
    const cases: [string, string][] = [
      ['not_approver', 'This step awaits another role.'],
      ['not_pending', 'This change-set is not awaiting a decision.'],
      ['expired', 'This change-set has expired.'],
      ['widget_not_allowed', 'Decisions on this change-set are made on the approval page.'],
      ['step_up_required', 'This change-set needs a recent login; decide on the approval page.'],
      ['count_mismatch', 'You cannot decide this change-set.'],
    ];
    for (const [reason, text] of cases) {
      setup(deciding({ canDecide: false, reason }));
      expect(decision().getByText(text)).toBeTruthy();
      cleanup();
    }
    setup({ ...deciding({ canDecide: false, reason: 'not_pending' }), status: 'completed' });
    expect(decision().queryByText('This change-set is not awaiting a decision.')).toBeNull();
  });

  it('UI-2 APR-7 with nothing to decide or start, the decision part says so and is not marked open', () => {
    setup({ ...deciding({ canDecide: false, reason: 'not_pending' }), status: 'completed' });
    const region = screen.getByRole('region', { name: 'Decision' });
    expect(within(region).getByText('Nothing to decide: this change-set is completed.')).toBeTruthy();
    expect(region.classList.contains('open')).toBe(false);
    cleanup();
    setup(deciding({ canDecide: true }));
    expect(screen.getByRole('region', { name: 'Decision' }).classList.contains('open')).toBe(true);
    expect(screen.queryByText(/Nothing to decide/)).toBeNull();
  });

  it('APR-7 Start execution shows only when viewer.canStart and calls start', async () => {
    setup({ ...deciding({ canDecide: false, reason: 'not_pending' }), status: 'approved' });
    expect(decision().queryByRole('button', { name: 'Start execution' })).toBeNull();
    cleanup();
    const start = vi.fn(
      (): Promise<ActionResult<ApprovalViewModel>> => Promise.resolve({ ok: false, message: 'executor_unavailable' }),
    );
    setup(
      { ...deciding({ canDecide: false, reason: 'not_pending', canStart: true }), status: 'approved' },
      actionsWith({ start }),
    );
    fireEvent.click(decision().getByRole('button', { name: 'Start execution' }));
    expect(start).toHaveBeenCalledTimes(1);
    expect((await decision().findByRole('alert')).textContent).toBe('Not started: executor_unavailable');
  });

  it('APR-7 a started change-set replaces the data; without the start action no button shows', async () => {
    const started = detail({ status: 'executing' });
    const start = vi.fn((): Promise<ActionResult<ApprovalViewModel>> => Promise.resolve({ ok: true, value: started }));
    const approved = { ...deciding({ canDecide: false, reason: 'not_pending', canStart: true }), status: 'approved' };
    const { onData } = setup(approved, actionsWith({ start }));
    fireEvent.click(decision().getByRole('button', { name: 'Start execution' }));
    await waitFor(() => {
      expect(onData).toHaveBeenCalledWith(started);
    });
    cleanup();
    const withoutStart = actionsWith();
    delete withoutStart.start;
    setup(approved, withoutStart);
    expect(decision().queryByRole('button', { name: 'Start execution' })).toBeNull();
  });

  it('APR-8 the widget shows decision buttons only when the server computed canDecide for the widget channel', async () => {
    const openPage = vi
      .fn<NonNullable<ApprovalActions['openPage']>>()
      .mockResolvedValue({ ok: true, value: undefined });
    setup(
      deciding({ channel: 'widget', canDecide: false, reason: 'widget_not_allowed' }),
      actionsWith({ openPage }),
    );
    expect(decision().queryByRole('button', { name: /Approve/ })).toBeNull();
    expect(decision().queryByRole('button', { name: 'Reject' })).toBeNull();
    expect(decision().getByText('Decisions on this change-set are made on the approval page.')).toBeTruthy();
    fireEvent.click(decision().getByRole('button', { name: 'Decide on the approval page' }));
    expect(openPage).toHaveBeenCalledTimes(1);
    await flush();
    cleanup();
    setup(deciding({ channel: 'widget', canDecide: true }), actionsWith({ openPage }));
    expect(decision().getByRole('button', { name: 'Approve 3 changes' })).toBeTruthy();
    expect(decision().getByRole('button', { name: 'Reject' })).toBeTruthy();
    expect(decision().getByRole('button', { name: 'Return with comment' })).toBeTruthy();
    expect(decision().queryByRole('button', { name: 'Decide on the approval page' })).toBeNull();
  });

  it('APR-8 the page channel never offers the approval-page button', () => {
    const openPage = vi.fn<NonNullable<ApprovalActions['openPage']>>();
    setup(deciding({ canDecide: false, reason: 'widget_not_allowed' }), actionsWith({ openPage }));
    expect(decision().queryAllByRole('button')).toHaveLength(0);
  });

  it('APR-6 the widget approve sends the shown hash and the stated count', async () => {
    const decide = vi.fn(decided);
    const d = deciding({ channel: 'widget' });
    setup({ ...d, stats: { ...d.stats, included: 3 } }, actionsWith({ decide }));
    expect(screen.getByRole('region', { name: 'Summary' }).textContent).toContain(HASH);
    fireEvent.click(decision().getByRole('button', { name: 'Approve 3 changes' }));
    await waitFor(() => {
      expect(decide).toHaveBeenCalledWith({ decision: 'approve', hash: HASH, count: 3 });
    });
  });

  it('APR-6 a double click on Approve sends one decision', async () => {
    let resolve: (r: ActionResult<ApprovalViewModel>) => void = () => undefined;
    const decide = vi.fn(
      () =>
        new Promise<ActionResult<ApprovalViewModel>>((r) => {
          resolve = r;
        }),
    );
    setup(deciding(), actionsWith({ decide }));
    const approve = decision().getByRole('button', { name: 'Approve 3 changes' });
    fireEvent.click(approve);
    fireEvent.click(approve);
    expect(decide).toHaveBeenCalledTimes(1);
    expect(decision().getByRole<HTMLButtonElement>('button', { name: 'Reject' }).disabled).toBe(true);
    expect(
      within(screen.getByRole('region', { name: 'Sample' })).getByRole<HTMLButtonElement>('button', {
        name: 'Re-sample',
      }).disabled,
    ).toBe(true);
    resolve({ ok: false, message: 'x' });
    await flush();
  });

  it('APR-6 a create approval says what is approved, with the record count', () => {
    const viewer: Viewer = { channel: 'page', canDecide: true, reason: null, needsFreshLogin: false, canStart: false };
    render(<ApprovalView data={detail({ action: 'create', viewer })} actions={actionsWith()} onData={vi.fn()} />);
    expect(screen.getByRole('button', { name: 'Approve creating 3 records' })).toBeTruthy();
    cleanup();
    const one = detail({ action: 'delete', viewer, stats: { total: 1, included: 1, excluded: {}, written: 0, failed: 0, skipped: 0 } });
    render(<ApprovalView data={one} actions={actionsWith()} onData={vi.fn()} />);
    expect(screen.getByRole('button', { name: 'Approve deleting 1 record' })).toBeTruthy();
  });

  it('CS-3 an item excluded by a check shows the configured title beside its code in the sample and the item list', () => {
    const locked = item('sku-9', { status: 'excluded', reason: 'locked' });
    render(
      <ApprovalView
        data={detail({ reasonTitles: { locked: 'Note is locked' }, sample: { seed: 's', items: [locked] }, items: { items: [locked] } })}
        actions={actionsWith()}
        onData={vi.fn()}
      />,
    );
    expect(screen.getAllByText('excluded: Note is locked (locked)')).toHaveLength(2);
  });

  it('APR-6 an update approval keeps its text', () => {
    const viewer: Viewer = { channel: 'page', canDecide: true, reason: null, needsFreshLogin: false, canStart: false };
    render(<ApprovalView data={detail({ action: 'update', viewer })} actions={actionsWith()} onData={vi.fn()} />);
    expect(screen.getByRole('button', { name: 'Approve 3 changes' })).toBeTruthy();
  });

  it('APR-6 the opaque approval view says Approve 1 call and hides sample and items', () => {
    const data = detail({ kind: 'opaque', viewer: { channel: 'page', canDecide: true, reason: null, needsFreshLogin: false, canStart: false }, request: { ...detail().request, args: { text: HOSTILE } } });
    const { container } = render(<ApprovalView data={data} actions={actionsWith()} onData={vi.fn()} />);
    expect(screen.getByRole('button', { name: 'Approve 1 call' })).toBeTruthy();
    expect(screen.getByRole('heading', { name: 'Raw arguments' })).toBeTruthy();
    expect(container.querySelector('img')).toBeNull();
    expect(container.textContent).toContain(HOSTILE);
    expect(container.querySelector('[aria-label="Sample"]')).toBeNull();
    expect(container.querySelector('[aria-label="Items"]')).toBeNull();
    expect(container.querySelector('table')).toBeNull();
  });
});

describe('UI-2 APR-5 the approval view shows files', () => {
  const FILE = { pointer: '/image', id: '33333333-3333-4333-8333-333333333333', name: 'logo.png', mediaType: 'image/png', size: 2048, sha256: HASH, preview: 'image' as const, available: true };
  const viewer = { channel: 'page' as const, canDecide: true, reason: null, needsFreshLogin: false, canStart: false };

  it('APR-5 the files section comes before the raw arguments', () => {
    const data = detail({ kind: 'opaque', viewer, files: [FILE] });
    render(<ApprovalView data={data} actions={actionsWith()} onData={vi.fn()} />);
    const files = screen.getByRole('heading', { name: 'Files sent with this call (1)' });
    const raw = screen.getByRole('heading', { name: 'Raw arguments' });
    expect(files.compareDocumentPosition(raw) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it('APR-5 a call without files shows no files section', () => {
    render(<ApprovalView data={detail({ kind: 'opaque', viewer })} actions={actionsWith()} onData={vi.fn()} />);
    expect(screen.queryByText(/Files sent with this call/)).toBeNull();
  });
});

describe('UI-4 APR-5 CS-9 the approval view shows the plan', () => {
  const SIBLING = '22222222-2222-4222-8222-222222222222';
  const plan: NonNullable<ApprovalViewModel['plan']> = {
    title: 'Spring launch',
    step: 2,
    of: 3,
    steps: [
      { step: 1, id: SIBLING, operation: 'shop.retire', status: 'executing' },
      { step: 2, id: ID, operation: 'catalog.update', status: 'pending_approval' },
      { step: 3, id: '33333333-3333-4333-8333-333333333333', operation: 'shop.publish', status: 'prepared', href: '/app/changesets/33333333-3333-4333-8333-333333333333' },
    ],
    startLine: 'Runs after step 1 completes (now: executing)',
  };

  it('UI-4 step 2 of 3 names its plan and what it waits for; only a step with a link is a link', () => {
    const { container } = render(<ApprovalView data={detail({ plan })} actions={actionsWith()} onData={vi.fn()} />);
    expect(screen.getByText('Step 2 of 3 in plan "Spring launch"')).toBeTruthy();
    expect(screen.getByText('Runs after step 1 completes (now: executing)')).toBeTruthy();
    const rows = Array.from(container.querySelectorAll('.plan li')).map((li) => li.textContent);
    expect(rows).toEqual(['1 shop.retire executing', '2 catalog.update pending_approval', '3 shop.publish prepared']);
    const links = Array.from(container.querySelectorAll('.plan a')).map((a) => a.getAttribute('href'));
    expect(links).toEqual(['/app/changesets/33333333-3333-4333-8333-333333333333']);
  });

  it('UI-4 without a plan the view has no plan section', () => {
    const { container } = render(<ApprovalView data={detail()} actions={actionsWith()} onData={vi.fn()} />);
    expect(container.querySelector('.plan')).toBeNull();
  });
});
