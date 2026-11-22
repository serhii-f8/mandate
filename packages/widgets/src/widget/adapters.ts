// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Mandate Authors
/**
 * The widget entry's mapping from tool answers to the shared view models (UI-1). Answers are
 * parsed with `safeParse`: an answer the widget does not understand becomes its text and the page
 * link, never a crash (Review Focus 1).
 */
import type { CallToolResult } from '@modelcontextprotocol/client';
import type { ApprovalStateModel, ApprovalViewModel, ChangeSetViewModel, ItemFilter, ItemRowModel, ItemsPageModel, StatsModel } from '../model.js';
import { changeSetAnswerSchema, isPageUrl, reviewAnswerSchema, uuidSchema, type ChangeSetAnswer, type ItemAnswer, type ReviewAnswer } from './schemas.js';

export type ChangeSetTrigger =
  | { kind: 'view'; model: ChangeSetViewModel }
  | { kind: 'load'; id: string; pageUrl?: string }
  | { kind: 'text'; text: string; pageUrl?: string };
export type ApprovalTrigger = { kind: 'view'; model: ApprovalViewModel } | { kind: 'text'; text: string; pageUrl?: string };

/** The first text block of a result; `''` when there is none. */
export function textOf(result: CallToolResult): string {
  for (const block of result.content) if (block.type === 'text') return block.text;
  return '';
}

/** The action only when it is not the default, so an update's model is unchanged (APR-6). */
function actionOf(action: 'update' | 'create' | 'delete' | undefined): { action?: 'create' | 'delete' } {
  return action === 'create' || action === 'delete' ? { action } : {};
}

/** CS-3: the check titles only when there are any, so a model without checks is unchanged. */
function reasonTitlesOf(titles: Record<string, string> | undefined): { reasonTitles?: Record<string, string> } {
  return titles === undefined || Object.keys(titles).length === 0 ? {} : { reasonTitles: titles };
}

/** EXE-12: the verification texts only when there are any, so an unverified model is unchanged. */
function verificationTitlesOf(titles: Record<string, string> | undefined): { verificationTitles?: Record<string, string> } {
  return titles === undefined || Object.keys(titles).length === 0 ? {} : { verificationTitles: titles };
}

function toStats(stats: ChangeSetAnswer['changeset']['stats']): StatsModel {
  const { verification, ...rest } = stats;
  return verification === undefined ? rest : { ...rest, verification };
}

function toItemRow(row: ItemAnswer): ItemRowModel {
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

function toItemsPage(items: readonly ItemAnswer[], next: string | undefined): ItemsPageModel {
  return { items: items.map(toItemRow), ...(next === undefined ? {} : { next }) };
}

/**
 * One step per plan step; a step's decision is the last one recorded for it in this round, and the
 * awaited role is that of the first undecided step while the change-set is pending (APR-5).
 */
function toApprovalState(approval: NonNullable<ChangeSetAnswer['approval']>, status: string): ApprovalStateModel {
  const steps = approval.plan.steps.map((role, i) => {
    const d = approval.decisions.filter((x) => x.step === i + 1).at(-1);
    return {
      step: i + 1,
      role,
      ...(d === undefined
        ? {}
        : {
            decision: {
              decision: d.decision,
              by: d.approver,
              channel: d.channel,
              ts: d.ts,
              ...(d.comment === undefined ? {} : { comment: d.comment }),
            },
          }),
    };
  });
  const awaiting = status === 'pending_approval' ? steps.find((s) => s.decision === undefined)?.role : undefined;
  return { round: approval.round, steps, ...(awaiting === undefined ? {} : { awaitingRole: awaiting }) };
}

/**
 * The requester's model from a `get_changeset`, prepared or `exclude_changeset_items` answer.
 * Permissions follow the status only; the server re-checks every call (SEC-1).
 */
export function fromGetChangeset(structured: unknown, filter?: ItemFilter): ChangeSetViewModel | undefined {
  const parsed = changeSetAnswerSchema.safeParse(structured);
  if (!parsed.success) return undefined;
  const a = parsed.data;
  const cs = a.changeset;
  const kind = cs.kind ?? 'diff';
  return {
    id: cs.id,
    kind,
    ...actionOf(cs.action),
    ...verificationTitlesOf(a.verificationTitles),
    ...(kind === 'opaque' && cs.args !== undefined ? { args: cs.args } : {}),
    operation: { id: cs.operation.id, ...(cs.operation.title === undefined ? {} : { title: cs.operation.title }) },
    status: cs.status,
    ...(cs.hash === undefined ? {} : { hash: cs.hash }),
    createdAt: cs.createdAt,
    expiresAt: cs.expiresAt,
    stats: toStats(cs.stats),
    items: toItemsPage(a.items, a.nextCursor),
    ...(filter === undefined ? {} : { itemFilter: filter }),
    ...(a.progress === undefined ? {} : { progress: a.progress }),
    ...(a.approval === undefined ? {} : { approval: toApprovalState(a.approval, cs.status) }),
    ...(a.execution === undefined ? {} : { drift: a.execution.drift }),
    ...(cs.errorCode === undefined ? {} : { errorCode: cs.errorCode }),
    ...(a.derivedFrom === undefined ? {} : { derivedFrom: a.derivedFrom }),
    rollback: {
      available: a.rollback?.available ?? false,
      ...(a.rollback?.count === undefined ? {} : { count: a.rollback.count }),
      ...(a.rollback?.until === undefined ? {} : { until: a.rollback.until }),
      ...(a.rollback?.stats === undefined ? {} : { stats: a.rollback.stats }),
    },
    ...(a.pageUrl === undefined ? {} : { pageUrl: a.pageUrl }),
    permissions: { canExclude: cs.status === 'prepared' && kind !== 'opaque', canSubmit: cs.status === 'prepared', canCancel: cs.status === 'executing' },
  };
}

function toDetailApproval(approval: NonNullable<ReviewAnswer['detail']['approval']>): ApprovalStateModel {
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
                ts: d.ts,
                ...(d.comment === undefined ? {} : { comment: d.comment }),
              },
            }),
      };
    }),
    ...(approval.awaitingRole === undefined ? {} : { awaitingRole: approval.awaitingRole }),
  };
}

/** The approver's model on the widget channel from a `review_changeset` answer (APR-8). */
export function fromReviewChangeset(structured: unknown, filter?: ItemFilter): ApprovalViewModel | undefined {
  const parsed = reviewAnswerSchema.safeParse(structured);
  if (!parsed.success) return undefined;
  const { detail, items, nextCursor, sample, pageUrl } = parsed.data;
  const op = detail.operation;
  const req = detail.request;
  const policy = detail.policy;
  return {
    id: detail.id,
    kind: detail.kind ?? 'diff',
    ...actionOf(detail.action),
    ...reasonTitlesOf(detail.reasonTitles),
    status: detail.status,
    ...(detail.hash === undefined ? {} : { hash: detail.hash }),
    operation: {
      id: op.id,
      ...(op.title === undefined ? {} : { title: op.title }),
      ...(op.description === undefined ? {} : { description: op.description }),
      ...(op.risk === undefined ? {} : { risk: op.risk }),
    },
    request: {
      args: req.args,
      requester: req.requester,
      ...(req.clientId === undefined ? {} : { clientId: req.clientId }),
      createdAt: req.createdAt,
      ...(req.submittedAt === undefined ? {} : { submittedAt: req.submittedAt }),
    },
    ...(policy === undefined
      ? {}
      : {
          policy: {
            rule: policy.rule,
            role: policy.role,
            ...(policy.approval === undefined
              ? {}
              : {
                  approval: {
                    reason: policy.approval.reason,
                    ...(policy.approval.threshold === undefined ? {} : { threshold: policy.approval.threshold }),
                    included: policy.approval.included,
                  },
                }),
          },
        }),
    stats: toStats(detail.stats),
    expiresAt: detail.expiresAt,
    ...(detail.approval === undefined ? {} : { approval: toDetailApproval(detail.approval) }),
    sample: { seed: sample.seed, items: sample.items.map(toItemRow) },
    items: toItemsPage(items, nextCursor),
    ...(filter === undefined ? {} : { itemFilter: filter }),
    viewer: { channel: 'widget', canDecide: detail.viewer.canDecide, reason: detail.viewer.reason, needsFreshLogin: false, canStart: false },
    ...(pageUrl === undefined ? {} : { pageUrl }),
  };
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function pageUrlOf(structured: Record<string, unknown> | undefined): { pageUrl?: string } {
  const url = structured?.pageUrl;
  return isPageUrl(url) ? { pageUrl: url } : {};
}

/** The change-set ID a result names, as `changesetId` or `changeset.id`, when it is a UUID. */
function idOf(structured: Record<string, unknown> | undefined): string | undefined {
  if (structured === undefined) return undefined;
  const nested = isRecord(structured.changeset) ? structured.changeset.id : undefined;
  for (const candidate of [structured.changesetId, nested]) {
    const id = uuidSchema.safeParse(candidate);
    if (id.success) return id.data;
  }
  return undefined;
}

/** What the change-set widget shows for the result that opened it (design part 2 §4.1). */
export function parseChangeSetTrigger(result: CallToolResult): ChangeSetTrigger {
  const structured = isRecord(result.structuredContent) ? result.structuredContent : undefined;
  if (result.isError !== true) {
    const model = fromGetChangeset(structured);
    if (model !== undefined) return { kind: 'view', model };
  }
  // An error that names a change-set still shows its stored state.
  const id = idOf(structured);
  if (id !== undefined) return { kind: 'load', id, ...pageUrlOf(structured) };
  return { kind: 'text', text: textOf(result), ...pageUrlOf(structured) };
}

/** What the approval widget shows for the `review_changeset` result that opened it. */
export function parseApprovalTrigger(result: CallToolResult): ApprovalTrigger {
  const structured = isRecord(result.structuredContent) ? result.structuredContent : undefined;
  if (result.isError !== true) {
    const model = fromReviewChangeset(structured);
    if (model !== undefined) return { kind: 'view', model };
  }
  return { kind: 'text', text: textOf(result), ...pageUrlOf(structured) };
}
