import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ChangeSetDetail, ItemRow, ItemsPage, Sample } from '../api.js';
import { ChangeSetView, type ChangeSetViewProps } from './ChangeSetView.js';

afterEach(cleanup);

const ID = '11111111-1111-4111-8111-111111111111';
const HOSTILE = '<img src=x onerror=alert(1)>';

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
});
