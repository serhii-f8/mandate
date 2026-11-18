/**
 * `submit_for_approval` (MCP-8; design part 1 §5): re-checks policy for a prepared or approved
 * change-set with the caller's current identity and configuration (POL-6). A prepared one starts
 * when the allowing role needs no approval (POL-5), with that role's limits (POL-4), or moves to
 * `pending_approval` for the role's approval steps; an approved one starts with the identity it was
 * submitted under. The steps live in `SubmitService`; this tool maps its outcome to texts, tasks and
 * `tool.call` details. Answers carry counts and IDs only (SEC-5).
 */
import type { CallToolResult } from '@modelcontextprotocol/server';
import { createSchemaCompiler } from '@aiops/config';
import { TASK_TTL_MS, type ApprovalPlan, type ChangeSetRecord, type StartOutcome } from '@aiops/core';
import { SUBMIT_TOOL, SubmitService, type SubmitOutcome } from '../changesets/submit-service.js';
import { AUDIT_UNAVAILABLE } from './audited-tool.js';
import type { BuiltinToolDeps } from './builtin-tools.js';
import { notFound } from './changeset-tools.js';
import { deniedResult } from './policy-answers.js';
import { createTaskResult, type ToolAnswer } from './tasks/task-result.js';
import type { BuiltinContext, BuiltinTool } from './tool-catalog.js';

export { SUBMIT_TOOL };

const SUBMIT_SCHEMA = {
  type: 'object',
  properties: {
    changeset_id: { type: 'string', format: 'uuid' },
    hash: { type: 'string', pattern: '^sha256:[0-9a-f]{64}$' },
  },
  required: ['changeset_id', 'hash'],
  additionalProperties: false,
} as const;

const HASH_MISMATCH_TEXT = 'The change-set changed; review it again.';

const error = (text: string): CallToolResult => ({ isError: true, content: [{ type: 'text', text }] });
const wrongStatus = (id: string, status: string): CallToolResult => error(`Change-set ${id} cannot be submitted in status ${status}.`);
const unavailable = (id: string): CallToolResult => error(`Change-set ${id} could not be started: the execution service is unavailable.`);

/** Fixed texts for the executor's refusals; the error code is the refusal reason. */
function refusalText(id: string, role: string, refusal: Exclude<StartOutcome, { ok: true }>): string {
  switch (refusal.reason) {
    case 'not_found':
      return `Change-set ${id} was not found.`;
    case 'hash_mismatch':
      return HASH_MISMATCH_TEXT;
    case 'expired':
      return `Change-set ${id} has expired.`;
    case 'not_executable':
      return `Change-set ${id} cannot be executed in its current state.`;
    case 'not_approved':
      return `Change-set ${id} lacks the approvals its execution needs.`;
    case 'limit_exceeded':
      return `Execution refused: limit ${refusal.limit} of role ${role} reached.`;
  }
}

type Call = Omit<BuiltinContext, 'snapshot'>;

export function submitForApprovalTool(deps: BuiltinToolDeps): BuiltinTool {
  const service = new SubmitService(deps);

  /** Started: a task for a declaring client (MCP-7), otherwise the plain answer (MCP-1). */
  async function started(call: Call, record: ChangeSetRecord): Promise<ToolAnswer> {
    const { caller } = call;
    if (call.tasks) {
      const task = {
        taskId: deps.newId(),
        owner: caller.subject,
        ...(caller.clientId === undefined ? {} : { clientId: caller.clientId }),
        changesetId: record.id,
        kind: 'execute' as const,
        tool: SUBMIT_TOOL,
        createdAt: deps.now(),
        ttlMs: TASK_TTL_MS,
      };
      // The change-set ID is on the tool.call row even if the task write throws (AUD-1).
      call.report({ changesetId: record.id });
      // Committed before the handle is returned, so the first tasks/get finds it.
      await deps.tasks.create(task);
      call.report({ taskId: task.taskId });
      return createTaskResult(task);
    }
    const total = record.stats.included;
    return {
      content: [{ type: 'text', text: `Execution of ${String(total)} changes started. Call get_changeset with this ID to follow it.` }],
      structuredContent: { changesetId: record.id, status: 'executing', total },
    };
  }

  /** Required approval (POL-5): no task, since it waits for people (APR-1). */
  function pendingApproval(record: ChangeSetRecord, plan: ApprovalPlan): ToolAnswer {
    const id = record.id;
    // A required plan always has steps (SubmitService checks it before the transaction).
    const first = plan.steps[0] ?? '';
    const url = new URL(`/app/changesets/${id}`, deps.publicUrl).href;
    const total = record.stats.included;
    return {
      content: [
        {
          type: 'text',
          text: `Change-set ${id} (${String(total)} changes) awaits approval by role ${first} (step 1 of ${String(plan.steps.length)}). Approvers decide on ${url}.`,
        },
      ],
      structuredContent: { changesetId: id, status: 'pending_approval', total, approval: { step: 1, steps: plan.steps, url } },
    };
  }

  /** Today's text and `errorCode` for every outcome; no code for an unknown ID, a wrong status or a failed audit write. */
  function answer(call: Call, id: string, outcome: SubmitOutcome): Promise<ToolAnswer> | ToolAnswer {
    switch (outcome.kind) {
      case 'started':
        return started(call, outcome.changeset);
      case 'pending_approval':
        return pendingApproval(outcome.changeset, outcome.plan);
      case 'refused':
        break;
    }
    switch (outcome.reason) {
      case 'not_found':
        // Unknown and foreign IDs are not reported; the lost race is (ruling F2).
        if ('raced' in outcome) call.report({ errorCode: 'not_found' });
        return notFound(id);
      case 'wrong_status':
        return wrongStatus(id, outcome.status);
      case 'audit_unavailable':
        return AUDIT_UNAVAILABLE;
      case 'policy_denied':
        call.report({ errorCode: 'policy_denied' });
        return deniedResult(outcome.decision);
      case 'hash_mismatch':
        call.report({ errorCode: 'hash_mismatch' });
        return error(HASH_MISMATCH_TEXT);
      case 'expired':
        call.report({ errorCode: 'expired' });
        return error(`Change-set ${id} has expired.`);
      case 'not_prepared':
        call.report({ errorCode: 'not_prepared' });
        return wrongStatus(id, outcome.status);
      case 'approval_unroutable':
        call.report({ errorCode: 'approval_unroutable' });
        return error(`Change-set ${id} needs approval, but its role has no approval steps configured.`);
      case 'executor_unavailable':
        call.report({ errorCode: 'executor_unavailable' });
        return unavailable(id);
      case 'start_refused':
        call.report({ errorCode: outcome.refusal.reason });
        return error(refusalText(id, outcome.role, outcome.refusal));
    }
  }

  return {
    name: SUBMIT_TOOL,
    description: 'Submit a change-set you prepared, by its ID and hash: it is executed, or sent for approval when your role requires it.',
    inputSchema: SUBMIT_SCHEMA,
    widget: 'changeset',
    readOnlyHint: false,
    validate: createSchemaCompiler()(SUBMIT_SCHEMA),
    async handler(args, { caller, snapshot, correlationId, tasks, report }) {
      // `validate` guarantees the shape.
      const id = args.changeset_id as string;
      const hash = args.hash as string;
      const call: Call = { caller, correlationId, tasks, report };
      return answer(call, id, await service.submit({ caller, correlationId, changesetId: id, hash, snapshot }));
    },
  };
}
