import type { ApprovalRecord } from '../approval/model.js';
import type { ChangeSetRecord } from '../changeset/model.js';
import type { NotificationRow } from './outbox.js';

export interface RenderInput {
  readonly row: Pick<NotificationRow, 'kind' | 'round' | 'step'>;
  readonly changeset: ChangeSetRecord;
  /** The configured title of the operation; absent → the operation ID. */
  readonly operationTitle?: string;
  /** approval_decided only: the decision of `row.step` in `row.round`. */
  readonly decision?: ApprovalRecord;
  /** Origin without trailing slash, e.g. `http://localhost:8400`. */
  readonly publicUrl: string;
}

export interface RenderedNotification {
  readonly subject: string;
  readonly text: string;
}

const UNRENDERABLE = 'notification cannot be rendered';

/** Configuration and identity text may carry control characters (header injection); every interpolation passes here. */
function clean(s: string): string {
  // eslint-disable-next-line no-control-regex -- stripping control characters is the purpose
  return s.replace(/[\u0000-\u001f\u007f]/g, ' ');
}

export function changesetLink(publicUrl: string, changesetId: string): string {
  return `${publicUrl}/app/changesets/${changesetId}`;
}

/** NTF-2: fixed templates; only identifiers, counts, names and the link are interpolated (SEC-3). */
export function renderNotification(input: RenderInput): RenderedNotification {
  const { row, changeset: cs, publicUrl } = input;
  const link = clean(changesetLink(publicUrl, cs.id));
  const id = clean(cs.id);
  switch (row.kind) {
    case 'approval_requested': {
      const plan = cs.approvalPlan;
      if (plan === undefined) throw new Error(UNRENDERABLE);
      const title = clean(input.operationTitle ?? cs.operation);
      const actor = clean(cs.submission?.actor ?? cs.requester);
      const role = clean(plan.steps[row.step - 1] ?? cs.awaitingRole ?? '');
      return {
        subject: `Approval requested: ${title}`,
        text: `Change-set ${id} by ${actor} with ${cs.stats.included} changes to ${title} awaits approval by role ${role} (step ${row.step} of ${plan.steps.length}). Review it: ${link}`,
      };
    }
    case 'approval_decided': {
      const d = input.decision;
      if (d === undefined) throw new Error(UNRENDERABLE);
      const who = clean(d.approverName ?? d.approver);
      return {
        subject: `Change-set ${d.decision}: ${clean(input.operationTitle ?? cs.operation)}`,
        text: `Change-set ${id} was ${d.decision} by ${who} at step ${row.step}. ${link}`,
      };
    }
    case 'execution_finished': {
      const s = cs.stats;
      return {
        subject: `Change-set ${cs.status}: ${clean(input.operationTitle ?? cs.operation)}`,
        text: `Change-set ${id} finished ${cs.status}: ${s.written} written, ${s.failed} failed, ${s.skipped} skipped. ${link}`,
      };
    }
  }
}
