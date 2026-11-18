import { describe, expect, it } from 'vitest';
import type { ApprovalRecord } from '../approval/model.js';
import type { ChangeSetRecord } from '../changeset/model.js';
import { renderNotification, type RenderInput } from './render.js';

const changeset = {
  id: 'cs-1',
  operation: 'catalog.update_content',
  connection: 'c',
  requester: 'alice-sub',
  args: { skus: ['SKU-SECRET-1'], changes: { description: 'ARG-SECRET-VALUE' } },
  status: 'completed_with_errors',
  stats: { total: 4, included: 3, excluded: {}, written: 2, failed: 1, skipped: 0 },
  errorCode: 'ERROR-SECRET-CODE',
  configHash: 'h',
  correlationId: 'k',
  createdAt: new Date(0),
  expiresAt: new Date(0),
  approvalRound: 1,
  submission: { actor: 'alice-sub', groups: [], correlationId: 'k', at: new Date(0), role: 'r', rule: 'x' },
  approvalPlan: { reason: 'default', steps: ['content_lead', 'brand_owner'], widget: false },
} as unknown as ChangeSetRecord;

const decision = {
  step: 1,
  round: 1,
  decision: 'returned',
  approver: 'dave-sub',
  approverName: 'Dave',
  comment: 'COMMENT-SECRET',
} as unknown as ApprovalRecord;

const base = { changeset, publicUrl: 'http://localhost:8400' };
const link = 'http://localhost:8400/app/changesets/cs-1';
const row = (kind: RenderInput['row']['kind']): RenderInput['row'] => ({ kind, round: 1, step: 1 });

describe('NTF-2 notification templates', () => {
  it('NTF-2 approval_requested renders the fixed text', () => {
    const r = renderNotification({ ...base, row: row('approval_requested'), operationTitle: 'Update content' });
    expect(r.subject).toBe('Approval requested: Update content');
    expect(r.text).toBe(
      `Change-set cs-1 by alice-sub with 3 changes to Update content awaits approval by role content_lead (step 1 of 2). Review it: ${link}`,
    );
  });

  it('NTF-2 approval_decided renders the fixed text', () => {
    const r = renderNotification({ ...base, row: row('approval_decided'), decision });
    expect(r.subject).toBe('Change-set returned: catalog.update_content');
    expect(r.text).toBe(`Change-set cs-1 was returned by Dave at step 1. ${link}`);
  });

  it('NTF-2 execution_finished renders the fixed text', () => {
    const r = renderNotification({ ...base, row: row('execution_finished') });
    expect(r.text).toBe(
      `Change-set cs-1 finished completed_with_errors: 2 written, 1 failed, 0 skipped. ${link}`,
    );
  });

  it('NTF-2 SEC-3 no template carries arguments, item values, comments or error codes', () => {
    for (const kind of ['approval_requested', 'approval_decided', 'execution_finished'] as const) {
      const r = renderNotification({ ...base, row: row(kind), decision });
      const all = r.subject + r.text;
      for (const s of ['SKU-SECRET-1', 'ARG-SECRET-VALUE', 'COMMENT-SECRET', 'ERROR-SECRET-CODE']) {
        expect(all).not.toContain(s);
      }
    }
  });

  it('NTF-2 control characters in configuration or identity text become spaces', () => {
    const r = renderNotification({ ...base, row: row('approval_requested'), operationTitle: 'Up\r\nBcc: x@evil.test' });
    expect(r.subject).not.toMatch(/[\r\n]/);
    const d = renderNotification({
      ...base,
      row: row('approval_decided'),
      decision: { ...decision, approverName: 'Da\u0007ve' },
    });
    expect(d.text).toContain('Da ve');
  });

  it('NTF-2 approval_decided without a decision throws the fixed message', () => {
    expect(() => renderNotification({ ...base, row: row('approval_decided') })).toThrow(
      'notification cannot be rendered',
    );
    expect(() =>
      renderNotification({ ...base, changeset: { ...changeset, approvalPlan: undefined } as unknown as ChangeSetRecord, row: row('approval_requested') }),
    ).toThrow('notification cannot be rendered');
  });
});
