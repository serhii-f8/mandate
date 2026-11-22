// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Mandate Authors
import type {
  ApprovalStateModel,
  ApprovalViewModel,
  ChangeSetViewModel,
  ItemFilter,
  ItemRowModel,
  ItemsPageModel,
  PlanModel,
} from '@mandate/widgets';
import type { ChangeSetDetail, ItemRow, ItemsPage, Sample } from './api.js';
import { changesetPath } from './routes.js';

/** The page entry's mapping from the typed REST answers to the shared view models (UI-1). */

function toItemRow(row: ItemRow): ItemRowModel {
  return {
    targetId: row.targetId,
    status: row.status,
    ...(row.reason === undefined ? {} : { reason: row.reason }),
    before: row.before,
    after: row.after,
    ...(row.error === undefined ? {} : { error: row.error }),
    ...(row.verificationStatus === undefined ? {} : { verificationStatus: row.verificationStatus }),
    ...(row.verificationCode === undefined ? {} : { verificationCode: row.verificationCode }),
  };
}

export function toItemsPage(page: ItemsPage): ItemsPageModel {
  return { items: page.items.map(toItemRow), ...(page.next === undefined ? {} : { next: page.next }) };
}

/** Decisions name the approver's display name when known, else the subject (APR-5). */
function toApproval(approval: NonNullable<ChangeSetDetail['approval']>): ApprovalStateModel {
  return {
    round: approval.round,
    steps: approval.steps.map((s) => {
      const d = s.decision;
      return {
        step: s.step,
        role: s.role,
        ...(d === undefined
          ? {}
          : {
              decision: {
                decision: d.decision,
                by: d.name ?? d.approver,
                channel: d.channel,
                ...(d.comment === undefined ? {} : { comment: d.comment }),
                ts: d.ts,
              },
            }),
      };
    }),
    ...(approval.awaitingRole === undefined ? {} : { awaitingRole: approval.awaitingRole }),
  };
}

/** The action only when it is not the default, so an update's model is unchanged (APR-6). */
function actionOf(detail: ChangeSetDetail): { action?: 'create' | 'delete' } {
  return detail.action === 'create' || detail.action === 'delete' ? { action: detail.action } : {};
}

/** CS-3: the check titles only when there are any, so a model without checks is unchanged. */
function reasonTitlesOf(detail: ChangeSetDetail): { reasonTitles?: Record<string, string> } {
  const titles = detail.reasonTitles;
  return titles === undefined || Object.keys(titles).length === 0 ? {} : { reasonTitles: titles };
}

/** EXE-12: the verification texts only when there are any, so an unverified model is unchanged. */
function verificationTitlesOf(detail: ChangeSetDetail): { verificationTitles?: Record<string, string> } {
  const titles = detail.verificationTitles;
  return titles === undefined || Object.keys(titles).length === 0 ? {} : { verificationTitles: titles };
}

/** CS-9, UI-4: the plan; a step links to its page only when the server marked it `visible` (SEC-1). */
function planOf(detail: ChangeSetDetail): { plan?: PlanModel } {
  const plan = detail.plan;
  if (plan === undefined) return {};
  return {
    plan: {
      title: plan.title,
      step: plan.step,
      of: plan.of,
      steps: plan.steps.map((s) => ({
        step: s.step,
        id: s.id,
        operation: s.operation,
        status: s.status,
        ...(s.visible === true ? { href: changesetPath(s.id) } : {}),
      })),
    },
  };
}

/**
 * The requester's model. Permissions come from the server's viewer block; the page has no cancel
 * route in this phase, and it is the page itself, so there is no `pageUrl`.
 */
export function toChangeSetModel(detail: ChangeSetDetail, items: ItemsPage, filter?: ItemFilter): ChangeSetViewModel {
  const { operation } = detail;
  const kind = detail.kind ?? 'diff';
  return {
    id: detail.id,
    kind,
    ...actionOf(detail),
    ...reasonTitlesOf(detail),
    ...verificationTitlesOf(detail),
    ...planOf(detail),
    ...(kind === 'opaque' ? { args: detail.request.args } : {}),
    operation: { id: operation.id, ...(operation.title === undefined ? {} : { title: operation.title }) },
    status: detail.status,
    ...(detail.hash === undefined ? {} : { hash: detail.hash }),
    createdAt: detail.request.createdAt,
    expiresAt: detail.expiresAt,
    stats: detail.stats,
    items: toItemsPage(items),
    ...(filter === undefined ? {} : { itemFilter: filter }),
    ...(detail.progress === undefined ? {} : { progress: detail.progress }),
    ...(detail.approval === undefined ? {} : { approval: toApproval(detail.approval) }),
    ...(detail.drift === undefined ? {} : { drift: detail.drift }),
    ...(detail.errorCode === undefined ? {} : { errorCode: detail.errorCode }),
    ...(detail.derivedFrom === undefined ? {} : { derivedFrom: detail.derivedFrom }),
    rollback: {
      available: detail.rollback.available,
      ...(detail.rollback.count === undefined ? {} : { count: detail.rollback.count }),
      ...(detail.rollback.until === undefined ? {} : { until: detail.rollback.until }),
      ...(detail.rollback.stats === undefined ? {} : { stats: detail.rollback.stats }),
    },
    permissions: { canExclude: detail.viewer.canExclude, canSubmit: detail.viewer.canSubmit, canCancel: false },
  };
}

/**
 * The approver's model on the page channel. A decider whose login is stale or misses the step-up
 * is sent to `freshLoginUrl` (SEC-8, AUTH-6).
 */
export function toApprovalModel(
  detail: ChangeSetDetail,
  items: ItemsPage,
  sample: Sample,
  freshLoginUrl: string,
  filter?: ItemFilter,
): ApprovalViewModel {
  const { viewer } = detail;
  return {
    id: detail.id,
    kind: detail.kind ?? 'diff',
    ...actionOf(detail),
    ...reasonTitlesOf(detail),
    ...planOf(detail),
    status: detail.status,
    ...(detail.hash === undefined ? {} : { hash: detail.hash }),
    operation: detail.operation,
    request: detail.request,
    ...(detail.policy === undefined ? {} : { policy: detail.policy }),
    stats: detail.stats,
    expiresAt: detail.expiresAt,
    ...(detail.approval === undefined ? {} : { approval: toApproval(detail.approval) }),
    sample: { seed: sample.seed, items: sample.items.map(toItemRow) },
    items: toItemsPage(items),
    ...(filter === undefined ? {} : { itemFilter: filter }),
    viewer: {
      channel: 'page',
      canDecide: viewer.canDecide,
      reason: viewer.reason,
      needsFreshLogin: viewer.canDecide && (!viewer.fresh || !viewer.stepUpSatisfied),
      canStart: viewer.canStart,
    },
    freshLoginUrl,
  };
}
