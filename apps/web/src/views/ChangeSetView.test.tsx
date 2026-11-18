import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ChangeSetDetail, DecideOutcome, ItemRow, ItemsPage, Sample } from '../api.js';
import { ChangeSetView, type ChangeSetViewProps } from './ChangeSetView.js';

afterEach(cleanup);

const ID = '11111111-1111-4111-8111-111111111111';
const HOSTILE = '<img src=x onerror=alert(1)>';
const HASH = `sha256:${'a'.repeat(64)}`;
const FRESH = `/auth/login?return_to=%2Fapp%2Fchangesets%2F${ID}&fresh=1`;

const detail = (over: Partial<ChangeSetDetail> = {}): ChangeSetDetail => ({
  id: ID,
  status: 'pending_approval',
  hash: 'abc123hash',
  operation: { id: 'catalog.update', title: 'Update brand content' },
  connection: 'shop',
  request: { args: { brand: 'acme' }, requester: 'ann', clientId: 'claude-desktop', createdAt: '2030-01-01T00:00:00.000Z' },
  policy: { rule: 'role:content_manager/grant:own-brands-content', role: 'content_manager', approval: { reason: 'above_threshold', threshold: 2, included: 3 } },
  stats: { total: 4, included: 3, excluded: { not_found: 1 }, written: 0, failed: 0, skipped: 0 },
  expiresAt: '2030-02-01T00:00:00.000Z',
  approval: { round: 1, steps: [{ step: 1, role: 'content_lead' }, { step: 2, role: 'cto' }], awaitingRole: 'content_lead' },
  viewer: { canDecide: false, reason: null, fresh: true, stepUpSatisfied: true, canStart: false },
  ...over,
});
const item = (targetId: string, over: Partial<ItemRow> = {}): ItemRow => ({ targetId, status: 'pending', before: { name: 'old' }, after: { name: 'new' }, ...over });

function setup(over: Partial<ChangeSetViewProps> = {}) {
  const props: ChangeSetViewProps = {
    detail: detail(),
    items: { items: [item('sku-1'), item('sku-2')] } satisfies ItemsPage,
    sample: { seed: 's', items: [item('sku-1')] } satisfies Sample,
    hasPrevious: false,
    onResample: vi.fn(),
    onNext: vi.fn(),
    onPrevious: vi.fn(),
    onStatusFilter: vi.fn(),
    freshLoginUrl: '/auth/login',
    onDecide: vi.fn(),
    onStart: vi.fn(),
    ...over,
  };
  return { props, ...render(<ChangeSetView {...props} />) };
}

describe('ChangeSetView', () => {
  it('APR-5 UI-2 the page shows status, operation title, hash, expiry, requester, client and the stored arguments', () => {
    const { container } = setup();
    const labels = Array.from(container.querySelectorAll('section')).map((s) => s.getAttribute('aria-label'));
    expect(labels).toEqual(['Summary', 'Request', 'Policy', 'Statistics', 'Sample', 'Items', 'Approval chain', 'Decision']);
    const summary = within(screen.getByRole('region', { name: 'Summary' }));
    expect(summary.getByText(/pending_approval/)).toBeTruthy();
    expect(summary.getByText(/Update brand content/)).toBeTruthy();
    expect(summary.getByText(/abc123hash/)).toBeTruthy();
    expect(summary.getByText(/2030-02-01/)).toBeTruthy();
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

  it('APR-5 the sample shows before and after; Re-sample calls onResample', () => {
    const { props } = setup();
    const sample = within(screen.getByRole('region', { name: 'Sample' }));
    expect(sample.getByText((_, el) => el?.tagName === 'PRE' && el.textContent === JSON.stringify({ name: 'old' }, null, 2))).toBeTruthy();
    expect(sample.getByText((_, el) => el?.tagName === 'PRE' && el.textContent === JSON.stringify({ name: 'new' }, null, 2))).toBeTruthy();
    fireEvent.click(sample.getByRole('button', { name: 'Re-sample' }));
    expect(props.onResample).toHaveBeenCalledTimes(1);
  });

  it('NFR-8 Next and Previous follow the item pages; the status filter calls onStatusFilter', () => {
    const first = setup();
    const items = within(screen.getByRole('region', { name: 'Items' }));
    expect(items.getByRole<HTMLButtonElement>('button', { name: 'Next' }).disabled).toBe(true);
    expect(items.getByRole<HTMLButtonElement>('button', { name: 'Previous' }).disabled).toBe(true);
    fireEvent.change(items.getByLabelText('Status'), { target: { value: 'failed' } });
    expect(first.props.onStatusFilter).toHaveBeenCalledWith('failed');
    fireEvent.change(items.getByLabelText('Status'), { target: { value: '' } });
    expect(first.props.onStatusFilter).toHaveBeenLastCalledWith(undefined);
    cleanup();
    const second = setup({ items: { items: [item('a')], next: 'cur' }, hasPrevious: true, statusFilter: 'failed' });
    const again = within(screen.getByRole('region', { name: 'Items' }));
    fireEvent.click(again.getByRole('button', { name: 'Next' }));
    fireEvent.click(again.getByRole('button', { name: 'Previous' }));
    expect(second.props.onNext).toHaveBeenCalledTimes(1);
    expect(second.props.onPrevious).toHaveBeenCalledTimes(1);
  });

  it('APR-3 the approval chain shows each step, its role, decision and comment', () => {
    setup({
      detail: detail({
        approval: {
          round: 1,
          steps: [
            { step: 1, role: 'content_lead', decision: { approver: 'bob', decision: 'approve', channel: 'web', comment: 'looks fine', ts: '2030-01-02T00:00:00.000Z' } },
            { step: 2, role: 'cto' },
          ],
          awaitingRole: 'cto',
        },
      }),
    });
    const chain = within(screen.getByRole('region', { name: 'Approval chain' }));
    expect(chain.getByText(/content_lead/)).toBeTruthy();
    expect(chain.getByText(/approve/)).toBeTruthy();
    expect(chain.getByText(/looks fine/)).toBeTruthy();
    expect(chain.getByText(/cto/)).toBeTruthy();
  });

  it('SEC-5 upstream values, arguments and comments render as text', () => {
    const { container } = setup({
      detail: detail({
        request: { args: { note: HOSTILE }, requester: 'ann', createdAt: '2030-01-01T00:00:00.000Z' },
        approval: { round: 1, steps: [{ step: 1, role: 'content_lead', decision: { approver: 'bob', decision: 'return', channel: 'web', comment: HOSTILE, ts: '2030-01-02T00:00:00.000Z' } }] },
      }),
      items: { items: [item('x', { before: HOSTILE })] },
    });
    expect(container.querySelector('img')).toBeNull();
    expect(screen.getAllByText(/<img src=x onerror=alert\(1\)>/).length).toBeGreaterThanOrEqual(3);
  });

  const deciding = (over: Partial<ChangeSetDetail['viewer']> = {}) =>
    detail({ hash: HASH, viewer: { canDecide: true, reason: null, fresh: true, stepUpSatisfied: true, canStart: false, ...over } });
  const decision = () => within(screen.getByRole('region', { name: 'Decision' }));

  it('APR-6 the approve button states the count and sends hash and count', async () => {
    const onDecide = vi.fn(() => Promise.resolve<DecideOutcome>({ ok: true, status: 'approved' }));
    setup({ detail: deciding(), onDecide });
    fireEvent.click(decision().getByRole('button', { name: 'Approve 3 changes' }));
    await waitFor(() => {
      expect(onDecide).toHaveBeenCalledWith({ decision: 'approve', hash: HASH, count: 3 });
    });
  });

  it('APR-6 one included change reads "Approve 1 change"', () => {
    const d = deciding();
    setup({ detail: { ...d, stats: { ...d.stats, included: 1 } } });
    expect(decision().getByRole('button', { name: 'Approve 1 change' })).toBeTruthy();
  });

  it('APR-4 return needs a comment; reject sends the comment', async () => {
    const onDecide = vi.fn(() => Promise.resolve<DecideOutcome>({ ok: true, status: 'returned' }));
    setup({ detail: deciding(), onDecide });
    const panel = decision();
    const ret = panel.getByRole<HTMLButtonElement>('button', { name: 'Return with comment' });
    expect(ret.disabled).toBe(true);
    fireEvent.change(panel.getByLabelText('Comment'), { target: { value: '   ' } });
    expect(ret.disabled).toBe(true);
    fireEvent.change(panel.getByLabelText('Comment'), { target: { value: 'fix sku-2' } });
    expect(ret.disabled).toBe(false);
    fireEvent.click(ret);
    await waitFor(() => {
      expect(onDecide).toHaveBeenLastCalledWith({ decision: 'return', hash: HASH, count: 3, comment: 'fix sku-2' });
    });
    fireEvent.click(panel.getByRole('button', { name: 'Reject' }));
    await waitFor(() => {
      expect(onDecide).toHaveBeenLastCalledWith({ decision: 'reject', hash: HASH, count: 3, comment: 'fix sku-2' });
    });
  });

  it('APR-6 a refused decision shows "Not decided: <error>"', async () => {
    setup({ detail: deciding(), onDecide: () => Promise.resolve<DecideOutcome>({ ok: false, error: 'hash_mismatch' }) });
    fireEvent.click(decision().getByRole('button', { name: 'Approve 3 changes' }));
    expect((await decision().findByRole('alert')).textContent).toBe('Not decided: hash_mismatch');
  });

  it('SEC-8 a stale session shows "Log in again to decide" linking to the fresh login and no decision buttons', () => {
    setup({ detail: deciding({ fresh: false }), freshLoginUrl: FRESH });
    expect(decision().getByRole('link', { name: 'Log in again to decide' }).getAttribute('href')).toBe(FRESH);
    expect(decision().queryAllByRole('button')).toHaveLength(0);
  });

  it('AUTH-6 an unsatisfied step-up shows the same re-login link', () => {
    setup({ detail: deciding({ stepUpSatisfied: false }), freshLoginUrl: FRESH });
    expect(decision().getByRole('link', { name: 'Log in again to decide' }).getAttribute('href')).toBe(FRESH);
    expect(decision().queryAllByRole('button')).toHaveLength(0);
  });

  it('APR-2 the requester sees why they cannot decide', () => {
    setup({ detail: deciding({ canDecide: false, reason: 'separation_of_duties' }) });
    expect(decision().getByText('You cannot decide this step: you requested this change-set or decided an earlier step.')).toBeTruthy();
    expect(decision().queryAllByRole('button')).toHaveLength(0);
  });

  it('APR-2 each refusal reason has its fixed text, shown only while pending_approval', () => {
    const cases: [string, string][] = [
      ['not_approver', 'This step awaits another role.'],
      ['not_pending', 'This change-set is not awaiting a decision.'],
      ['expired', 'This change-set has expired.'],
      ['widget_not_allowed', 'You cannot decide this change-set.'],
    ];
    for (const [reason, text] of cases) {
      setup({ detail: deciding({ canDecide: false, reason }) });
      expect(decision().getByText(text)).toBeTruthy();
      cleanup();
    }
    setup({ detail: { ...deciding({ canDecide: false, reason: 'not_pending' }), status: 'completed' } });
    expect(decision().queryByText('This change-set is not awaiting a decision.')).toBeNull();
  });

  it('APR-7 Start execution shows only when viewer.canStart and calls onStart', async () => {
    setup({ detail: { ...deciding({ canDecide: false, reason: 'not_pending' }), status: 'approved' } });
    expect(decision().queryByRole('button', { name: 'Start execution' })).toBeNull();
    cleanup();
    const onStart = vi.fn(() => Promise.resolve<DecideOutcome>({ ok: false, error: 'executor_unavailable' }));
    setup({ detail: { ...deciding({ canDecide: false, reason: 'not_pending', canStart: true }), status: 'approved' }, onStart });
    fireEvent.click(decision().getByRole('button', { name: 'Start execution' }));
    expect(onStart).toHaveBeenCalledTimes(1);
    expect((await decision().findByRole('alert')).textContent).toBe('Not started: executor_unavailable');
  });
});
