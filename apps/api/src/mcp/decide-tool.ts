// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Mandate Authors
/**
 * `decide_changeset` (APR-8; design part 1 §8): the widget's decision on the current approval step.
 * Listed only to holders of a step role of some role whose approval allows the widget, and published
 * with `_meta.ui.visibility: ["app"]` so hosts keep it away from the model. Every check of
 * `checkDecision` still applies through `ApprovalService.decide`; a plan without `widget` (destructive
 * or step-up change-sets included) is refused there (SEC-8). Answers carry IDs and statuses only (SEC-5).
 */
import type { CallToolResult } from '@modelcontextprotocol/server';
import { createSchemaCompiler, type LoadedConfiguration } from '@mandate/config';
import { callerKind, rolesOf, type Approver, type Caller, type DecisionRequest } from '@mandate/core';
import type { DecideResult } from '../approvals/approval-service.js';
import { DECISION_REFUSAL_TEXT } from '../approvals/texts.js';
import type { BuiltinToolDeps } from './builtin-tools.js';
import type { BuiltinTool } from './tool-catalog.js';

export const DECIDE_TOOL = 'decide_changeset';

const DECIDE_SCHEMA = {
  type: 'object',
  properties: {
    // A UUID before the service sees it: refusals are audited against the change-set ID column.
    changeset_id: { type: 'string', format: 'uuid' },
    decision: { type: 'string', enum: ['approve', 'reject', 'return'] },
    hash: { type: 'string', pattern: '^sha256:[0-9a-f]{64}$' },
    count: { type: 'integer', minimum: 0 },
    comment: { type: 'string', maxLength: 2000 },
  },
  required: ['changeset_id', 'decision', 'hash', 'count'],
  additionalProperties: false,
} as const;

/** The step roles of every role whose approval allows widget decisions (APR-8). */
export function widgetApproverRoles(configuration: LoadedConfiguration): ReadonlySet<string> {
  const roles = new Set<string>();
  for (const rule of configuration.approval.values()) {
    if (rule.allowWidget) for (const role of rule.steps) roles.add(role);
  }
  return roles;
}

/** A service account never decides an approval step (AUTH-4, APR-8), so it never sees the widget tool. */
function holdsWidgetRole(caller: Caller, configuration: LoadedConfiguration): boolean {
  if (callerKind(caller) === 'service') return false;
  const widget = widgetApproverRoles(configuration);
  return rolesOf(caller, configuration.policy).some((role) => widget.has(role));
}

function startText(start: NonNullable<Extract<DecideResult, { ok: true }>['start']>): string {
  if (start === 'executor_unavailable') return ` Execution did not start: ${start}.`;
  return start.ok ? ' Execution started.' : ` Execution did not start: ${start.reason}.`;
}

export function decideChangesetTool(deps: BuiltinToolDeps): BuiltinTool {
  return {
    name: DECIDE_TOOL,
    description: 'Approve, reject or return the change-set step you are asked to decide, by its ID, hash and number of changes.',
    inputSchema: DECIDE_SCHEMA,
    readOnlyHint: false,
    meta: { ui: { visibility: ['app'] } },
    visibleTo: holdsWidgetRole,
    validate: createSchemaCompiler()(DECIDE_SCHEMA),
    async handler(args, { caller, snapshot, correlationId, report }): Promise<CallToolResult> {
      // `validate` guarantees the shape.
      const id = args.changeset_id as string;
      const comment = args.comment as string | undefined;
      const configuration = snapshot.configuration;
      const approver: Approver = {
        subject: caller.subject,
        roles: rolesOf(caller, configuration.policy),
        ...(caller.clientId === undefined ? {} : { clientId: caller.clientId }),
        ...(caller.authTime === undefined ? {} : { authTime: caller.authTime }),
      };
      const result = await deps.approvals.decide({
        changesetId: id,
        decision: args.decision as DecisionRequest,
        hash: args.hash as string,
        count: args.count as number,
        ...(comment === undefined ? {} : { comment }),
        approver,
        channel: 'widget',
        correlationId,
        snapshot: configuration,
      });
      if (!result.ok) {
        report({ errorCode: result.reason });
        return { isError: true, content: [{ type: 'text', text: DECISION_REFUSAL_TEXT[result.reason](id) }] };
      }
      const { status, start } = result;
      return {
        content: [{ type: 'text', text: `Decision recorded for change-set ${id}: ${status}.${start === undefined ? '' : startText(start)}` }],
        structuredContent: { changesetId: id, status, ...(start === undefined ? {} : { start }) },
      };
    },
  };
}
