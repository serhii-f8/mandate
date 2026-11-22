// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Mandate Authors
/**
 * The change-set detail answer of the trusted pages (design part 2 §4), its `viewer` block and the
 * page start check (part 1 §6 "Starting an approved change-set"). Everything comes from storage
 * (APR-5); the server re-checks on every POST.
 */
import {
  canView,
  changesetKind,
  checkDecision,
  isExpiryDue,
  type ApprovalChannel,
  type ApprovalDecision,
  type ApprovalReason,
  type ApprovalRecord,
  type Approver,
  type ChangeItemRecord,
  type ChangeSetKind,
  type ManifestAction,
  type ChangeSetRecord,
  type ChangeSetStats,
  type ChangeSetStatus,
  type DecisionRefusal,
  type ExecutionProgress,
  type ItemStatus,
  type OperationDefinition,
  type RiskClass,
} from '@mandate/core';
import type { RollbackBlock } from '../changesets/rollback.js';

export interface PageViewer {
  subject: string;
  name?: string;
  roles: readonly string[];
  clientId: string;
  authTime: Date;
  /** `now − auth_time ≤ MANDATE_FRESH_AUTH_SECONDS` (SEC-8). */
  fresh: boolean;
}

export type PageStartRefusal = 'not_found' | 'expired' | 'not_approved_status' | 'not_permitted';

export interface ViewerBlock {
  canDecide: boolean;
  reason: DecisionRefusal | null;
  fresh: boolean;
  stepUpSatisfied: boolean;
  canStart: boolean;
  canSubmit: boolean;
  canExclude: boolean;
}

/** One change item as the pages and widgets show it. */
export interface ItemRow {
  targetId: string;
  status: ItemStatus;
  reason?: string;
  before: unknown;
  after: unknown;
  error?: string;
}

export function itemRow(i: ChangeItemRecord): ItemRow {
  return {
    targetId: i.targetId,
    status: i.status,
    ...(i.reason === undefined ? {} : { reason: i.reason }),
    before: i.before,
    after: i.after,
    ...(i.error === undefined ? {} : { error: i.error }),
  };
}

export interface StepDecision {
  approver: string;
  name?: string;
  decision: ApprovalDecision;
  channel: ApprovalChannel;
  comment?: string;
  ts: string;
}

export interface ApprovalStepView {
  step: number;
  role: string;
  decision?: StepDecision;
}

export interface ChangeSetDetail {
  id: string;
  /** `opaque`: one raw upstream call with no diff (R7); `request.args` holds the arguments. */
  kind: ChangeSetKind;
  /** What the change-set does to its targets, as stored at preparation (APR-5); `update` when none was stored. */
  action: ManifestAction;
  status: ChangeSetStatus;
  hash?: string;
  derivedFrom?: string;
  operation: { id: string; title?: string; description?: string; risk?: RiskClass };
  connection: string;
  request: {
    args: Readonly<Record<string, unknown>>;
    requester: string;
    clientId?: string;
    createdAt: string;
    submittedAt?: string;
  };
  policy?: { rule: string; role: string; approval?: { reason: ApprovalReason; threshold?: number; included: number } };
  stats: ChangeSetStats;
  expiresAt: string;
  progress?: { total: number; done: number; failed: number; skipped: number };
  errorCode?: string;
  approval?: {
    round: number;
    steps: ApprovalStepView[];
    awaitingRole?: string;
    stepUp?: { maxAgeSeconds: number };
  };
  /** Present once execution is summarised (UI-4). */
  drift?: number;
  /** Rollback availability for this viewer and, once present, its counts (UI-4, EXE-8). */
  rollback: RollbackBlock;
  /**
   * CS-3: the titles of the operation's check codes under the current configuration, a label shown
   * beside an item's stored reason code (display only; an untitled or unknown code shows the code).
   */
  reasonTitles: Record<string, string>;
  viewer: ViewerBlock;
}

function reasonTitlesOf(op: OperationDefinition | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  for (const check of op?.manifest?.checks ?? []) if (check.title !== undefined) out[check.code] = check.title;
  return out;
}

export function toApprover(v: PageViewer): Approver {
  return { subject: v.subject, ...(v.name === undefined ? {} : { name: v.name }), roles: v.roles, clientId: v.clientId, authTime: v.authTime };
}

/** Part 1 §6: visible, not expired, status `approved`, viewer holds the last plan step's role. */
export function checkPageStart(
  cs: ChangeSetRecord,
  approvals: readonly ApprovalRecord[],
  viewer: PageViewer,
  now: Date,
): PageStartRefusal | undefined {
  if (!canView(cs, approvals, { subject: viewer.subject, roles: viewer.roles })) return 'not_found';
  // The same expiry predicate as checkDecision (CS-6).
  if (cs.status === 'expired' || isExpiryDue(cs, now)) return 'expired';
  if (cs.status !== 'approved') return 'not_approved_status';
  const last = cs.approvalPlan?.steps.at(-1);
  if (last === undefined || !viewer.roles.includes(last)) return 'not_permitted';
  return undefined;
}

export function viewerBlock(cs: ChangeSetRecord, approvals: readonly ApprovalRecord[], viewer: PageViewer, now: Date): ViewerBlock {
  const r = checkDecision({
    changeset: cs,
    approvals,
    approver: toApprover(viewer),
    channel: 'page',
    decision: 'approve',
    hash: cs.hash ?? '',
    count: cs.stats.included,
    now,
  });
  // A missing step-up is solved by logging in again, so the panel still shows (design §5).
  // Submitting and excluding belong to the requester of an unexpired prepared change-set (UI-3).
  const own = viewer.subject === cs.requester && cs.status === 'prepared' && !isExpiryDue(cs, now);
  const reason = r === 'step_up_required' ? null : (r ?? null);
  return {
    canDecide: reason === null,
    reason,
    fresh: viewer.fresh,
    stepUpSatisfied: cs.approvalPlan?.stepUp === undefined || r !== 'step_up_required',
    canStart: checkPageStart(cs, approvals, viewer, now) === undefined,
    canSubmit: own,
    canExclude: own,
  };
}

/**
 * The viewer block for channel `widget` (APR-8): exactly what `decide_changeset` would answer for
 * an approve. The widget never starts, submits or excludes, and has no step-up path, so those
 * fields are fixed and fail closed.
 */
export function widgetViewerBlock(cs: ChangeSetRecord, approvals: readonly ApprovalRecord[], approver: Approver, now: Date): ViewerBlock {
  const r = checkDecision({
    changeset: cs,
    approvals,
    approver,
    channel: 'widget',
    decision: 'approve',
    hash: cs.hash ?? '',
    count: cs.stats.included,
    now,
  });
  const reason = r ?? null;
  return { canDecide: reason === null, reason, fresh: true, stepUpSatisfied: true, canStart: false, canSubmit: false, canExclude: false };
}

function stepDecision(a: ApprovalRecord): StepDecision {
  return {
    approver: a.approver,
    ...(a.approverName === undefined ? {} : { name: a.approverName }),
    decision: a.decision,
    channel: a.channel,
    ...(a.comment === undefined ? {} : { comment: a.comment }),
    ts: a.ts.toISOString(),
  };
}

function approvalOf(cs: ChangeSetRecord, approvals: readonly ApprovalRecord[]): ChangeSetDetail['approval'] {
  const plan = cs.approvalPlan;
  if (cs.approvalRound <= 0 || plan === undefined) return undefined;
  const round = approvals.filter((a) => a.round === cs.approvalRound);
  const steps = plan.steps.map((role, i): ApprovalStepView => {
    const decided = round.filter((a) => a.step === i + 1).at(-1);
    return { step: i + 1, role, ...(decided === undefined ? {} : { decision: stepDecision(decided) }) };
  });
  return {
    round: cs.approvalRound,
    steps,
    ...(cs.awaitingRole === undefined ? {} : { awaitingRole: cs.awaitingRole }),
    ...(plan.stepUp === undefined ? {} : { stepUp: { maxAgeSeconds: plan.stepUp.maxAgeSeconds } }),
  };
}

function operationOf(id: string, op: OperationDefinition | undefined): ChangeSetDetail['operation'] {
  if (op === undefined) return { id };
  return { id: op.id, title: op.title ?? op.id, description: op.description, risk: op.risk };
}

/** The page detail: the shared builder with the page viewer block (APR-5). */
export function changesetDetail(input: {
  changeset: ChangeSetRecord;
  approvals: readonly ApprovalRecord[];
  operation?: OperationDefinition;
  progress?: ExecutionProgress;
  viewer: PageViewer;
  now: Date;
  drift?: number;
  rollback: RollbackBlock;
}): ChangeSetDetail {
  const { viewer, now, ...rest } = input;
  return changesetDetailWith({ ...rest, viewer: viewerBlock(input.changeset, input.approvals, viewer, now) });
}

/** The change-set detail with a given viewer block, so pages and widgets build it alike (APR-5). */
export function changesetDetailWith(input: {
  changeset: ChangeSetRecord;
  approvals: readonly ApprovalRecord[];
  operation?: OperationDefinition;
  progress?: ExecutionProgress;
  viewer: ViewerBlock;
  drift?: number;
  rollback: RollbackBlock;
}): ChangeSetDetail {
  const { changeset: cs, approvals, progress } = input;
  const submission = cs.submission;
  const plan = cs.approvalPlan;
  const approval = approvalOf(cs, approvals);
  const kind = changesetKind(input.operation);
  return {
    id: cs.id,
    kind,
    action: cs.action ?? 'update',
    status: cs.status,
    ...(cs.hash === undefined ? {} : { hash: cs.hash }),
    ...(cs.derivedFrom === undefined ? {} : { derivedFrom: cs.derivedFrom }),
    operation: operationOf(cs.operation, input.operation),
    connection: cs.connection,
    request: {
      args: cs.args,
      requester: cs.requester,
      ...(cs.clientId === undefined ? {} : { clientId: cs.clientId }),
      createdAt: cs.createdAt.toISOString(),
      ...(submission === undefined ? {} : { submittedAt: submission.at.toISOString() }),
    },
    ...(submission === undefined
      ? {}
      : {
          policy: {
            rule: submission.rule,
            role: submission.role,
            ...(plan === undefined
              ? {}
              : {
                  approval: {
                    reason: plan.reason,
                    ...(plan.threshold === undefined ? {} : { threshold: plan.threshold }),
                    included: plan.included,
                  },
                }),
          },
        }),
    stats: cs.stats,
    expiresAt: cs.expiresAt.toISOString(),
    ...(progress === undefined
      ? {}
      : { progress: { total: progress.total, done: progress.done, failed: progress.failed, skipped: progress.skipped } }),
    ...(cs.errorCode === undefined ? {} : { errorCode: cs.errorCode }),
    ...(approval === undefined ? {} : { approval }),
    ...(input.drift === undefined ? {} : { drift: input.drift }),
    rollback: input.rollback,
    reasonTitles: reasonTitlesOf(input.operation),
    // CS-5: an opaque change-set has no items to exclude.
    viewer: kind === 'opaque' ? { ...input.viewer, canExclude: false } : input.viewer,
  };
}
