/**
 * `submit_for_approval` (MCP-8; design part 1 §5): re-checks policy for a prepared or approved
 * change-set with the caller's current identity and configuration (POL-6). A prepared one starts
 * when the allowing role needs no approval (POL-5), with that role's limits (POL-4), or moves to
 * `pending_approval` for the role's approval steps; an approved one starts with the identity it was
 * submitted under. Answers carry counts and IDs only (SEC-5).
 */
import type { CallToolResult } from '@modelcontextprotocol/server';
import { createSchemaCompiler, executionLimits } from '@aiops/config';
import {
  allowingRole,
  approvalRequestedEvent,
  approvalRequirement,
  changesetTransitionEvent,
  ExecutorUnavailable,
  TASK_TTL_MS,
  type ApprovalPlan,
  type ChangeSetRecord,
  type StartOutcome,
  type Submission,
} from '@aiops/core';
import { AUDIT_UNAVAILABLE } from './audited-tool.js';
import type { BuiltinToolDeps } from './builtin-tools.js';
import { load, notFound } from './changeset-tools.js';
import { deniedResult, recordDecision } from './policy-answers.js';
import { createTaskResult, type ToolAnswer } from './tasks/task-result.js';
import type { BuiltinContext, BuiltinTool } from './tool-catalog.js';

export const SUBMIT_TOOL = 'submit_for_approval';

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

  /** Required approval (POL-5): one transaction to `pending_approval`; no task, since it waits for people (APR-1). */
  async function sendForApproval(call: Call, record: ChangeSetRecord, hash: string, submission: Submission, plan: ApprovalPlan): Promise<ToolAnswer> {
    const { caller, correlationId } = call;
    const id = record.id;
    const first = plan.steps[0];
    // A required plan always has steps; the unroutable case was answered before.
    if (first === undefined) throw new Error('approval plan has no steps');
    const clientId = caller.clientId === undefined ? {} : { clientId: caller.clientId };
    const outcome = await deps.repository.submitForApproval({
      changesetId: id,
      expectedHash: hash,
      submission,
      plan,
      audit: {
        transition: changesetTransitionEvent({
          id: deps.newId(),
          actor: caller.subject,
          ...clientId,
          changeset: record,
          from: 'prepared',
          to: 'pending_approval',
          correlationId,
        }),
        requested: approvalRequestedEvent({
          id: deps.newId(),
          actor: caller.subject,
          ...clientId,
          changeset: record,
          round: record.approvalRound + 1,
          step: 1,
          role: first,
          correlationId,
        }),
      },
      notifications: [],
    });
    if (!outcome.ok) {
      call.report({ errorCode: outcome.reason });
      switch (outcome.reason) {
        case 'not_found':
          return notFound(id);
        case 'hash_mismatch':
          return error(HASH_MISMATCH_TEXT);
        case 'expired':
          return error(`Change-set ${id} has expired.`);
        case 'not_prepared':
          // Someone else moved it first: name the status it has now.
          return wrongStatus(id, (await deps.repository.get(id))?.status ?? record.status);
      }
    }
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

  return {
    name: SUBMIT_TOOL,
    description: 'Submit a change-set you prepared, by its ID and hash: it is executed, or sent for approval when your role requires it.',
    inputSchema: SUBMIT_SCHEMA,
    readOnlyHint: false,
    validate: createSchemaCompiler()(SUBMIT_SCHEMA),
    async handler(args, { caller, snapshot, correlationId, tasks, report }) {
      // `validate` guarantees the shape.
      const id = args.changeset_id as string;
      const hash = args.hash as string;
      const call: Call = { caller, correlationId, tasks, report };

      // 1. Requester only; unknown and foreign IDs look the same (expires lazily, CS-6).
      const record = await load(deps, caller, correlationId, id);
      if (record === undefined) return notFound(id);

      // 2. Only prepared and approved change-sets can be submitted; a second submit finds it pending or executing.
      if (record.status !== 'prepared' && record.status !== 'approved') return wrongStatus(id, record.status);

      // 3. SEC-9: the hash the caller reviewed, on every path and before anything changes.
      if (record.hash !== hash) {
        report({ errorCode: 'hash_mismatch' });
        return error(HASH_MISMATCH_TEXT);
      }

      // 4. POL-6: the stored arguments against the caller's current identity and configuration, audited (POL-8).
      const decision = snapshot.engine.evaluate({ caller, operationId: record.operation, args: record.args });
      const recorded = await recordDecision(deps, { caller, correlationId }, SUBMIT_TOOL, decision, { operation: record.operation, changesetId: id });
      if (decision.effect === 'deny') {
        report({ errorCode: 'policy_denied' });
        return deniedResult(decision);
      }
      if (!recorded) return AUDIT_UNAVAILABLE;

      // 5. Approved: start with the identity and role it was submitted under (POL-6, design §6).
      if (record.status === 'approved') {
        const outcome = await deps.approvals.startApproved({
          changesetId: id,
          actor: caller.subject,
          ...(caller.clientId === undefined ? {} : { clientId: caller.clientId }),
          correlationId,
          snapshot: snapshot.configuration,
        });
        if (!outcome.ok) {
          report({ errorCode: outcome.reason });
          if (outcome.reason === 'executor_unavailable') return unavailable(id);
          return error(refusalText(id, record.submission?.role ?? '', outcome));
        }
        return started(call, record);
      }

      // 6. Prepared: the allowing rule's role decides approval (POL-5), as it decides limits (ADR 0027).
      const role = allowingRole(decision.rule);
      const rule = role === undefined ? undefined : snapshot.configuration.approval.get(role);
      // An operation the engine allowed is in the snapshot; the strictest risk stands in otherwise.
      const risk = snapshot.configuration.policy.operations.find((op) => op.id === record.operation)?.risk ?? 'destructive';
      const requirement = approvalRequirement({ risk, ...(rule === undefined ? {} : { rule }), included: record.stats.included });
      if (role === undefined || (requirement.required && requirement.unroutable === true)) {
        report({ errorCode: 'approval_unroutable' });
        return error(`Change-set ${id} needs approval, but its role has no approval steps configured.`);
      }
      const submission: Submission = {
        actor: caller.subject,
        groups: caller.groups,
        ...(caller.clientId === undefined ? {} : { clientId: caller.clientId }),
        correlationId,
        at: deps.now(),
        role,
        rule: decision.rule,
      };
      if (requirement.required) {
        const { required: _required, unroutable: _unroutable, ...plan } = requirement; // eslint-disable-line @typescript-eslint/no-unused-vars -- not part of the plan
        return sendForApproval(call, record, hash, submission, plan);
      }

      // 7. No approval: start with the role's limits (POL-4); a limit refusal's deny row is written by the start itself.
      const limits = executionLimits(snapshot.configuration, role);
      let outcome: StartOutcome;
      try {
        outcome = await deps.executor.start({
          changesetId: id,
          expectedHash: hash,
          actor: caller.subject,
          correlationId,
          groups: caller.groups,
          ...(limits === undefined ? {} : { limits }),
          ...(caller.clientId === undefined ? {} : { clientId: caller.clientId }),
          submission,
        });
      } catch (e) {
        if (!(e instanceof ExecutorUnavailable)) throw e;
        report({ errorCode: 'executor_unavailable' });
        return unavailable(id);
      }
      if (!outcome.ok) {
        report({ errorCode: outcome.reason });
        return error(refusalText(id, role, outcome));
      }
      return started(call, record);
    },
  };
}
