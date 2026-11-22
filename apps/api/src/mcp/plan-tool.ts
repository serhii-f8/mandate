// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Mandate Authors
/**
 * `create_plan` (MCP-10, CS-9, ADR 0074): the requester puts 2 to 20 of their prepared change-sets in an order;
 * a step then starts only after the one before it completed (EXE-13). Every authenticated caller sees the tool;
 * it authorizes by ownership. A change-set the caller did not request answers exactly as an unknown one, by the
 * rule `get_changeset` uses (SEC-1), checked in list order before anything is written, so the answer never tells
 * an existing foreign change-set from a missing one. Answers and audit details carry IDs, counts and codes; the
 * title stays out of the audit (SEC-3).
 */
import type { CallToolResult } from '@modelcontextprotocol/server';
import { z } from 'zod';
import type { ArgumentCheck } from '@mandate/config';
import {
  PLAN_MAX_STEPS,
  PLAN_MIN_STEPS,
  planCreatedEvent,
  planShapeRefusal,
  type ChangeSetRepository,
  type CreatePlanRefusal,
  type PlanRecord,
} from '@mandate/core';
import type { BuiltinTool } from './tool-catalog.js';

export const PLAN_TOOL = 'create_plan';

/** CS-9: the title is 1 to 200 characters without control characters; the IDs are UUIDs. */
const PLAN_ARGS = z.strictObject({
  title: z
    .string()
    .min(1)
    .max(200)
    .regex(/^\P{Cc}*$/u, 'must not contain control characters'),
  changesets: z.array(z.uuid()).min(PLAN_MIN_STEPS).max(PLAN_MAX_STEPS),
});

type PlanArgs = z.infer<typeof PLAN_ARGS>;

/** Published in `tools/list`: the same schema as the one that validates (JSON Schema 2020-12, MCP's default dialect). */
const PLAN_SCHEMA: Readonly<Record<string, unknown>> = z.toJSONSchema(PLAN_ARGS);

export interface PlanToolDeps {
  readonly repository: ChangeSetRepository;
  readonly newId: () => string;
  readonly now: () => Date;
}

/** What a caller is told; `not_requester` reads as `not_found` (SEC-1). */
type AnsweredRefusal = Exclude<CreatePlanRefusal, 'not_requester'>;

const REFUSAL_TEXT: Readonly<Record<AnsweredRefusal, (id: string) => string>> = {
  not_found: (id) => `Change-set ${id} was not found.`,
  not_prepared: (id) => `Change-set ${id} is not prepared, or has expired; only prepared change-sets can be put in a plan.`,
  already_in_plan: (id) => `Change-set ${id} is already in a plan.`,
  duplicate_step: () => 'Each change-set can be listed only once.',
  too_few_steps: () => `A plan needs at least ${String(PLAN_MIN_STEPS)} change-sets.`,
  too_many_steps: () => `A plan holds at most ${String(PLAN_MAX_STEPS)} change-sets.`,
};

function refused(reason: CreatePlanRefusal, changesetId?: string): CallToolResult {
  const answered: AnsweredRefusal = reason === 'not_requester' ? 'not_found' : reason;
  return {
    isError: true,
    content: [{ type: 'text', text: REFUSAL_TEXT[answered](changesetId ?? '') }],
    structuredContent: { reason: answered, ...(changesetId === undefined ? {} : { changesetId }) },
  };
}

function validate(args: unknown): ArgumentCheck {
  const parsed = PLAN_ARGS.safeParse(args);
  if (parsed.success) return { ok: true };
  // Paths and Zod's fixed messages only: never the values.
  const message = parsed.error.issues.map((i) => (i.path.length === 0 ? i.message : `${i.path.join('.')}: ${i.message}`)).join('; ');
  return { ok: false, message };
}

export function createPlanTool(deps: PlanToolDeps): BuiltinTool {
  /** The first listed ID the caller may not see: unknown or someone else's look the same (get_changeset's rule). */
  async function firstInvisible(ids: readonly string[], subject: string): Promise<string | undefined> {
    for (const id of ids) {
      if ((await deps.repository.get(id))?.requester !== subject) return id;
    }
    return undefined;
  }

  return {
    name: PLAN_TOOL,
    description:
      'Put 2 to 20 change-sets you prepared in an order. Each keeps its own approval; a step starts only after the one before it completed.',
    inputSchema: PLAN_SCHEMA,
    // It writes the plan, so clients must not treat it as a pure read.
    readOnlyHint: false,
    validate,
    async handler(args, { caller, correlationId, report }): Promise<CallToolResult> {
      // Parsed again so the handler's types come from the schema; `validate` already admitted the shape.
      const parsed = PLAN_ARGS.safeParse(args);
      if (!parsed.success) return { isError: true, content: [{ type: 'text', text: `Input validation error: Invalid arguments for tool ${PLAN_TOOL}` }] };
      const input: PlanArgs = parsed.data;
      // The in-memory store matches IDs exactly; PostgreSQL ignores case. One spelling for both.
      const ids = input.changesets.map((id) => id.toLowerCase());
      const shape = planShapeRefusal(ids);
      if (shape !== undefined) {
        report({ errorCode: shape });
        return refused(shape);
      }
      const invisible = await firstInvisible(ids, caller.subject);
      if (invisible !== undefined) {
        report({ errorCode: 'not_found' });
        return refused('not_found', invisible);
      }
      const now = deps.now();
      const plan: PlanRecord = { id: deps.newId(), title: input.title, requester: caller.subject, createdAt: now };
      const result = await deps.repository.createPlan({
        id: plan.id,
        title: plan.title,
        requester: plan.requester,
        changesetIds: ids,
        now,
        audit: planCreatedEvent({
          id: deps.newId(),
          plan,
          steps: ids.length,
          correlationId,
          ...(caller.clientId === undefined ? {} : { clientId: caller.clientId }),
        }),
      });
      if (!result.ok) {
        report({ errorCode: result.reason });
        return refused(result.reason, result.changesetId);
      }
      const stored = await deps.repository.planSteps(result.plan.id);
      // Created in this call and never deleted; a missing plan is a storage fault, not an answer.
      if (stored === undefined) throw new Error('created plan not found');
      const steps = stored.steps.map((s) => ({ step: s.step, id: s.changesetId, operation: s.operation, status: s.status }));
      report({ planId: result.plan.id, steps: steps.length });
      const structured = { plan: { id: result.plan.id, title: result.plan.title, steps } };
      const list = steps.map((s) => `step ${String(s.step)} ${s.id} (${s.operation}, ${s.status})`).join(', ');
      const text = `Plan ${result.plan.id} orders ${String(steps.length)} change-sets: ${list}. Each step starts only after the one before it completed.`;
      // MCP-4: summary first, then the structured data as JSON.
      return { content: [{ type: 'text', text }, { type: 'text', text: JSON.stringify(structured) }], structuredContent: structured };
    },
  };
}
