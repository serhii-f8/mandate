/**
 * `submit_for_approval` (MCP-8, Phase 5 slice; design part 3 §6): re-checks policy for a prepared
 * change-set with the caller's current identity and configuration (POL-6), and starts execution
 * when the allowing role needs no approval (POL-5), with that role's limits (POL-4). Answers carry
 * counts and IDs only (SEC-5).
 */
import type { CallToolResult } from '@modelcontextprotocol/server';
import { createSchemaCompiler, executionLimits } from '@aiops/config';
import { ExecutorUnavailable, TASK_TTL_MS, type StartOutcome } from '@aiops/core';
import { allowingRole } from '../changesets/allowing-role.js';
import { AUDIT_UNAVAILABLE } from './audited-tool.js';
import type { BuiltinToolDeps } from './builtin-tools.js';
import { load, notFound } from './changeset-tools.js';
import { deniedResult, recordDecision } from './policy-answers.js';
import { createTaskResult } from './tasks/task-result.js';
import type { BuiltinTool } from './tool-catalog.js';

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

const error = (text: string): CallToolResult => ({ isError: true, content: [{ type: 'text', text }] });

/** Fixed texts for the executor's refusals; the error code is the refusal reason. */
function refusalText(id: string, role: string, refusal: Exclude<StartOutcome, { ok: true }>): string {
  switch (refusal.reason) {
    case 'not_found':
      return `Change-set ${id} was not found.`;
    case 'hash_mismatch':
      return 'The change-set changed; review it again.';
    case 'expired':
      return `Change-set ${id} has expired.`;
    case 'not_executable':
      return `Change-set ${id} cannot be executed in its current state.`;
    case 'limit_exceeded':
      return `Execution refused: limit ${refusal.limit} of role ${role} reached.`;
  }
}

export function submitForApprovalTool(deps: BuiltinToolDeps): BuiltinTool {
  return {
    name: SUBMIT_TOOL,
    description: 'Submit a change-set you prepared, by its ID and hash; it is executed when your role needs no approval.',
    inputSchema: SUBMIT_SCHEMA,
    readOnlyHint: false,
    validate: createSchemaCompiler()(SUBMIT_SCHEMA),
    async handler(args, { caller, snapshot, correlationId, tasks, report }) {
      // `validate` guarantees the shape.
      const id = args.changeset_id as string;
      const hash = args.hash as string;

      // 1. Requester only; unknown and foreign IDs look the same (expires lazily, CS-6).
      const record = await load(deps, caller, correlationId, id);
      if (record === undefined) return notFound(id);

      // 2. Only a prepared change-set can be submitted; a second submit finds it executing.
      if (record.status !== 'prepared') return error(`Change-set ${id} cannot be submitted in status ${record.status}.`);

      // 3. POL-6: the stored arguments against the caller's current identity and configuration, audited (POL-8).
      const decision = snapshot.engine.evaluate({ caller, operationId: record.operation, args: record.args });
      const recorded = await recordDecision(deps, { caller, correlationId }, SUBMIT_TOOL, decision, { operation: record.operation, changesetId: id });
      if (decision.effect === 'deny') {
        report({ errorCode: 'policy_denied' });
        return deniedResult(decision);
      }
      if (!recorded) return AUDIT_UNAVAILABLE;

      // 4. POL-5: the allowing rule's role decides; Phase 5 executes only without approval.
      const role = allowingRole(decision.rule);
      if (role === undefined || snapshot.configuration.approval.get(role)?.required !== 'never') {
        report({ errorCode: 'approval_required' });
        return error('This change-set requires approval, which this installation cannot grant yet.');
      }

      // 5. Start with the role's limits (POL-4); a limit refusal's deny row is written by the start itself.
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
        });
      } catch (e) {
        if (!(e instanceof ExecutorUnavailable)) throw e;
        report({ errorCode: 'executor_unavailable' });
        return error(`Change-set ${id} could not be started: the execution service is unavailable.`);
      }
      if (!outcome.ok) {
        report({ errorCode: outcome.reason });
        return error(refusalText(id, role, outcome));
      }

      // 6. Started: a task for a declaring client (MCP-7), otherwise the plain answer (MCP-1).
      if (tasks) {
        const task = {
          taskId: deps.newId(),
          owner: caller.subject,
          ...(caller.clientId === undefined ? {} : { clientId: caller.clientId }),
          changesetId: id,
          kind: 'execute' as const,
          tool: SUBMIT_TOOL,
          createdAt: deps.now(),
          ttlMs: TASK_TTL_MS,
        };
        // The change-set ID is on the tool.call row even if the task write throws (AUD-1).
        report({ changesetId: id });
        // Committed before the handle is returned, so the first tasks/get finds it.
        await deps.tasks.create(task);
        report({ taskId: task.taskId });
        return createTaskResult(task);
      }
      const total = record.stats.included;
      return {
        content: [{ type: 'text', text: `Execution of ${String(total)} changes started. Call get_changeset with this ID to follow it.` }],
        structuredContent: { changesetId: id, status: 'executing', total },
      };
    },
  };
}
