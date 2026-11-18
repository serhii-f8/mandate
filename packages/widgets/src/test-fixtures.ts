/** Model builders for the view tests; excluded from the library build. */
import type { ApprovalViewModel, ChangeSetViewModel, ItemRowModel } from './model.js';

export const HASH = `sha256:6114edb2${'0'.repeat(56)}`;

export function item(targetId: string, over: Partial<ItemRowModel> = {}): ItemRowModel {
  return { targetId, status: 'pending', before: { name: 'old' }, after: { name: 'new' }, ...over };
}

export function changeSetModel(over: Partial<ChangeSetViewModel> = {}): ChangeSetViewModel {
  return {
    id: '11111111-1111-4111-8111-111111111111',
    operation: { id: 'update_product_content', title: 'Update product content' },
    status: 'prepared',
    hash: HASH,
    createdAt: '2030-01-31T12:00:00.000Z',
    expiresAt: '2030-02-01T00:00:00.000Z',
    stats: { total: 4, included: 3, excluded: { no_change: 1 }, written: 0, failed: 0, skipped: 0 },
    items: {
      items: [
        item('sku-1'),
        item('sku-2'),
        item('sku-3'),
        item('sku-4', { status: 'excluded', reason: 'no_change', before: undefined, after: undefined }),
      ],
    },
    rollback: { available: false },
    permissions: { canExclude: true, canSubmit: true, canCancel: true },
    ...over,
  };
}

export function approvalModel(over: Partial<ApprovalViewModel> = {}): ApprovalViewModel {
  return {
    id: '22222222-2222-4222-8222-222222222222',
    status: 'pending_approval',
    hash: HASH,
    operation: { id: 'update_product_content', title: 'Update product content', risk: 'medium' },
    request: {
      args: { skus: ['sku-1', 'sku-2', 'sku-3'] },
      requester: 'ann',
      createdAt: '2030-01-31T12:00:00.000Z',
      submittedAt: '2030-01-31T12:05:00.000Z',
    },
    policy: { rule: 'content-editors', role: 'editor', approval: { reason: 'always', included: 3 } },
    stats: { total: 3, included: 3, excluded: {}, written: 0, failed: 0, skipped: 0 },
    expiresAt: '2030-02-01T00:00:00.000Z',
    approval: { round: 1, steps: [{ step: 1, role: 'approver' }], awaitingRole: 'approver' },
    sample: { seed: 'seed-1', items: [item('sku-1')] },
    items: { items: [item('sku-1'), item('sku-2'), item('sku-3')] },
    viewer: { channel: 'page', canDecide: true, reason: null, needsFreshLogin: false, canStart: false },
    ...over,
  };
}
