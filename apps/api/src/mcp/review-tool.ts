// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Mandate Authors
/**
 * `review_changeset` (APR-5, APR-8; design part 1 §8): the approver's view of a change-set in chat,
 * opened by the approval widget. The answer is the page detail built from storage by the same
 * functions as the page route, with the viewer block for channel `widget`, one item page and a
 * seeded sample. It writes nothing (no lazy expiry, as on the page); `decide_changeset` still
 * re-checks everything. Listed only to holders of a role named in some role's approval steps.
 * The text carries IDs, counts, statuses, roles and the hash only (SEC-5).
 */
import type { CallToolResult } from '@modelcontextprotocol/server';
import { allApprovalRules, createSchemaCompiler, type LoadedConfiguration } from '@mandate/config';
import { callerKind, canView, currentStep, encodeCursor, rolesOf, type ApprovalRecord, type Approver, type Caller, type ChangeSetRecord, type ItemStatus } from '@mandate/core';
import { changesetDetailWith, itemRow, widgetViewerBlock, type ViewerBlock } from '../approvals/detail.js';
import { decodeCursor, newSeed } from '../approvals/page-query.js';
import { fileRows } from '../files/file-rows.js';
import { planBlockFor } from '../changesets/plan-view.js';
import { rollbackBlock } from '../changesets/rollback.js';
import { DECISION_REFUSAL_TEXT } from '../approvals/texts.js';
import type { BuiltinToolDeps } from './builtin-tools.js';
import { isSummarised, notFound, progressOf } from './changeset-tools.js';
import type { BuiltinTool } from './tool-catalog.js';

export const REVIEW_TOOL = 'review_changeset';

const PAGE_SIZE = 50;
const SAMPLE_SIZE = 10;

const REVIEW_SCHEMA = {
  type: 'object',
  properties: {
    changeset_id: { type: 'string', format: 'uuid' },
    cursor: { type: 'string', maxLength: 512 },
    status: { enum: ['pending', 'excluded', 'written', 'failed', 'skipped'] },
    sample_seed: { type: 'string', pattern: '^[A-Za-z0-9_-]{1,64}$' },
  },
  required: ['changeset_id'],
  additionalProperties: false,
} as const;

/** Every role named in any role's approval steps. */
export function approvalStepRoles(configuration: LoadedConfiguration): ReadonlySet<string> {
  const roles = new Set<string>();
  for (const rule of allApprovalRules(configuration)) for (const role of rule.steps) roles.add(role);
  return roles;
}

/** A service account never decides an approval step (AUTH-4, APR-2), so it never sees the review. */
function holdsStepRole(caller: Caller, configuration: LoadedConfiguration): boolean {
  if (callerKind(caller) === 'service') return false;
  const steps = approvalStepRoles(configuration);
  return rolesOf(caller, configuration.policy).some((role) => steps.has(role));
}

/** The role `checkDecision` waits for (F11): the stored one, else the current step's, else the first. */
function awaitedRole(cs: ChangeSetRecord, approvals: readonly ApprovalRecord[]): string | undefined {
  const steps = cs.approvalPlan?.steps ?? [];
  return cs.awaitingRole ?? steps[(currentStep(cs, approvals) ?? 1) - 1] ?? steps[0];
}

function reviewText(cs: ChangeSetRecord, awaiting: string | undefined, viewer: ViewerBlock): string {
  const state = cs.status === 'pending_approval' && awaiting !== undefined ? `awaits ${awaiting}` : `is ${cs.status}`;
  const tail = viewer.reason === null ? 'You can decide it here or on the page.' : DECISION_REFUSAL_TEXT[viewer.reason](cs.id);
  // A change-set that never finished preparation has no hash to name.
  const hash = cs.hash === undefined ? '' : `, hash ${cs.hash}`;
  return `Change-set ${cs.id} (${cs.operation}) ${state}: ${String(cs.stats.included)} change(s)${hash}. ${tail}`;
}

const inputError = (text: string): CallToolResult => ({ isError: true, content: [{ type: 'text', text }] });

export function reviewChangesetTool(deps: BuiltinToolDeps): BuiltinTool {
  return {
    name: REVIEW_TOOL,
    description: 'Review a change-set you are asked to approve: its request, policy, approval steps, one page of changes and a random sample.',
    inputSchema: REVIEW_SCHEMA,
    readOnlyHint: true,
    widget: 'approval',
    visibleTo: holdsStepRole,
    validate: createSchemaCompiler()(REVIEW_SCHEMA),
    async handler(args, { caller, snapshot, report }): Promise<CallToolResult> {
      // `validate` guarantees the shape.
      const id = args.changeset_id as string;
      let after: string | undefined;
      if (typeof args.cursor === 'string') {
        after = decodeCursor(args.cursor);
        if (after === undefined) return inputError(`Input validation error: Invalid arguments for tool ${REVIEW_TOOL}: cursor is not valid`);
      }
      const configuration = snapshot.configuration;
      const roles = rolesOf(caller, configuration.policy);
      const cs = await deps.repository.get(id);
      if (cs === undefined) return notFound(id);
      const approvals = await deps.repository.approvals(id);
      if (!canView(cs, approvals, { subject: caller.subject, roles })) return notFound(id);

      // One more than shown tells whether another page follows.
      const rows = await deps.repository.itemsPage(id, {
        limit: PAGE_SIZE + 1,
        ...(after === undefined ? {} : { after }),
        ...(typeof args.status === 'string' ? { status: args.status as ItemStatus } : {}),
      });
      const page = rows.slice(0, PAGE_SIZE);
      const last = page.at(-1);
      const nextCursor = rows.length > PAGE_SIZE && last !== undefined ? encodeCursor(last.targetId) : undefined;
      const seed = typeof args.sample_seed === 'string' ? args.sample_seed : newSeed();
      const sample = await deps.repository.sampleItems(id, seed, SAMPLE_SIZE);
      const progress = await progressOf(deps, cs);
      // As the page detail route (F3): drift once execution is summarised.
      const drift = isSummarised(cs) ? ((await deps.repository.errorCounts(id)).drift ?? 0) : undefined;

      const approver: Approver = {
        subject: caller.subject,
        roles,
        ...(caller.clientId === undefined ? {} : { clientId: caller.clientId }),
        ...(caller.authTime === undefined ? {} : { authTime: caller.authTime }),
      };
      const viewer = widgetViewerBlock(cs, approvals, approver, deps.now());
      const operation = configuration.policy.operations.find((op) => op.id === cs.operation);
      // The same block as get_changeset: available only to the requester (T11/F3), who may also view here.
      const rollback = await rollbackBlock({ repository: deps.repository, snapshot, now: deps.now }, cs, caller);
      // UI-4, CS-9: the plan, each sibling marked with the same visibility check as the page.
      const plan = await planBlockFor(deps.repository, cs, { subject: caller.subject, roles });
      const files = await fileRows(deps.files, id);
      const detail = changesetDetailWith({
        changeset: cs,
        files,
        ...(plan === undefined ? {} : { plan }),
        approvals,
        ...(operation === undefined ? {} : { operation }),
        ...(progress === undefined ? {} : { progress }),
        ...(drift === undefined ? {} : { drift }),
        viewer,
        rollback,
      });
      report({ canDecide: viewer.canDecide });

      const structured: Record<string, unknown> = {
        changesetId: id,
        detail,
        items: page.map(itemRow),
        ...(nextCursor === undefined ? {} : { nextCursor }),
        sample: { seed, items: sample.map(itemRow) },
      };
      return {
        content: [
          { type: 'text', text: reviewText(cs, awaitedRole(cs, approvals), viewer) },
          { type: 'text', text: JSON.stringify(structured) },
        ],
        structuredContent: structured,
      };
    },
  };
}
