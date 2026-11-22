// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Mandate Authors
import type { CallToolResult } from '@modelcontextprotocol/server';
import { describe, expect, it } from 'vitest';
import type { AuditEventInput, Caller, ChangeSetRepository, CreatePlanRefusal } from '@mandate/core';
import { InMemoryAuditLog, InMemoryChangeSetRepository } from '@mandate/testing';
import type { AuditDetails } from './audited-tool.js';
import { createPlanTool, PLAN_TOOL } from './plan-tool.js';
import { isTaskAnswer, type ToolAnswer } from './tasks/task-result.js';

const NOW = new Date('2026-11-22T10:00:00.000Z');
const LATER = new Date('2026-11-23T10:00:00.000Z');
const A = '11111111-1111-4111-8111-111111111111';
const B = '22222222-2222-4222-8222-222222222222';
const BOBS = '33333333-3333-4333-8333-333333333333';
const UNKNOWN = '99999999-9999-4999-8999-999999999999';
const PLAN_ID = '44444444-4444-4444-8444-444444444444';
const alice: Caller = { subject: 'alice', groups: ['content'], clientId: 'mandate-mcp' };

function plain(answer: ToolAnswer): CallToolResult {
  if (isTaskAnswer(answer)) throw new Error('unexpected task answer');
  return answer;
}

/** The repository as the tool sees it, recording every method called on it. */
function spied(repository: ChangeSetRepository): { repository: ChangeSetRepository; calls: string[] } {
  const calls: string[] = [];
  const proxy = new Proxy(repository, {
    get(target, prop, receiver) {
      const value: unknown = Reflect.get(target, prop, receiver);
      if (typeof value !== 'function') return value;
      return (...args: unknown[]) => {
        calls.push(String(prop));
        return (value as (...a: unknown[]) => unknown).apply(target, args);
      };
    },
  });
  return { repository: proxy, calls };
}

const event = (id: string, actor: string): AuditEventInput => ({ id: `e-${id}`, actor, action: 'changeset.transition', outcome: 'ok', correlationId: 'c0', details: {} });

/** A prepared change-set of one item, owned by `requester`, of operation `op`. */
async function prepared(repository: InMemoryChangeSetRepository, id: string, requester: string, op = 'shop.update_content'): Promise<void> {
  await repository.create(
    { id, operation: op, connection: 'shop', requester, args: { brand: 'acme' }, configHash: 'h', correlationId: 'c0', createdAt: NOW, expiresAt: LATER },
    event(id, requester),
  );
  await repository.appendItems(id, [{ targetId: 'SKU-SECRET-1', status: 'pending', before: { name: 'old' }, after: { name: 'new' } }]);
  await repository.completePreparation(
    id,
    { status: 'prepared', hashVersion: 1, hash: 'h', stats: { total: 1, included: 1, excluded: {}, written: 0, failed: 0, skipped: 0 }, preparedAt: NOW },
    event(`${id}-p`, requester),
  );
}

async function setup() {
  const audit = new InMemoryAuditLog();
  const store = new InMemoryChangeSetRepository(audit);
  await prepared(store, A, 'alice', 'shop.update_content');
  await prepared(store, B, 'alice', 'shop.retire_content');
  await prepared(store, BOBS, 'bob', 'shop.secret_operation');
  const { repository, calls } = spied(store);
  let ids = 0;
  const tool = createPlanTool({ repository, newId: () => (ids++ === 0 ? PLAN_ID : `00000000-0000-4000-8000-00000000000${String(ids)}`), now: () => NOW });
  const reports: AuditDetails[] = [];
  const run = async (args: Record<string, unknown>, caller: Caller = alice): Promise<CallToolResult> =>
    plain(await tool.handler(args, { caller, snapshot: undefined as never, correlationId: 'corr-plan', tasks: false, report: (d) => reports.push(d) }));
  return { store, audit, tool, calls, reports, run };
}

const refusal = (r: CallToolResult) => ({ isError: r.isError, structured: r.structuredContent });

describe('MCP-10 create_plan', () => {
  it('MCP-10 CS-9 a valid call creates the plan and answers its steps in list order', async () => {
    const { store, run, reports, audit } = await setup();
    const result = await run({ title: 'Spring launch', changesets: [B, A.toUpperCase()] });
    expect(result.isError).toBeUndefined();
    const plan = {
      id: PLAN_ID,
      title: 'Spring launch',
      steps: [
        { step: 1, id: B, operation: 'shop.retire_content', status: 'prepared' },
        { step: 2, id: A, operation: 'shop.update_content', status: 'prepared' },
      ],
    };
    expect(result.structuredContent).toEqual({ plan });
    expect(result.content[0]).toEqual({
      type: 'text',
      text: `Plan ${PLAN_ID} orders 2 change-sets: step 1 ${B} (shop.retire_content, prepared), step 2 ${A} (shop.update_content, prepared). Each step starts only after the one before it completed.`,
    });
    expect(result.content[1]).toEqual({ type: 'text', text: JSON.stringify({ plan }) });
    expect((await store.get(A))?.plan).toEqual({ id: PLAN_ID, step: 2 });
    // The caller is the plan's requester; the audit names the plan and its size, never the title (SEC-3).
    expect((await store.planSteps(PLAN_ID))?.plan.requester).toBe('alice');
    const created = audit.events.filter((e) => e.action === 'plan.created');
    expect(created).toMatchObject([{ actor: 'alice', clientId: 'mandate-mcp', correlationId: 'corr-plan', details: { planId: PLAN_ID, steps: 2 } }]);
    expect(JSON.stringify(created)).not.toContain('Spring launch');
    expect(reports).toEqual([{ planId: PLAN_ID, steps: 2 }]);
  });

  it('MCP-10 MCP-3 a non-UUID ID, a control character in the title and bounds are refused at validation', async () => {
    const { tool, run, calls } = await setup();
    const refused = [
      { title: 'Launch', changesets: [A, 'not-a-uuid'] },
      { title: 'Launch\u0007', changesets: [A, B] },
      { title: 'Launch\u009b', changesets: [A, B] },
      { title: '', changesets: [A, B] },
      { title: 'x'.repeat(201), changesets: [A, B] },
      { title: 'Launch', changesets: [A] },
      { title: 'Launch', changesets: Array.from({ length: 21 }, () => A) },
      { title: 'Launch', changesets: [A, B], extra: true },
      { changesets: [A, B] },
    ];
    for (const args of refused) expect(tool.validate(args).ok, JSON.stringify(args)).toBe(false);
    expect(tool.validate({ title: 'x'.repeat(200), changesets: [A, B] })).toEqual({ ok: true });
    // The handler re-parses: arguments that skipped validation reach no repository method.
    const direct = await run({ title: 'Launch\u0007', changesets: [A, B] });
    expect(direct.isError).toBe(true);
    expect(calls).toEqual([]);
  });

  it('MCP-10 CS-9 each refusal answers its fixed reason and the offending change-set', async () => {
    const { store, run } = await setup();
    const C = '55555555-5555-4555-8555-555555555555';
    await prepared(store, C, 'alice');
    expect((await run({ title: 'First', changesets: [A, C] })).isError).toBeUndefined();
    const D = '66666666-6666-4666-8666-666666666666';
    await prepared(store, D, 'alice');
    await store.transition(D, ['prepared'], 'cancelled', event('d-c', 'alice'));

    expect(refusal(await run({ title: 'x', changesets: [B, UNKNOWN] }))).toEqual({ isError: true, structured: { reason: 'not_found', changesetId: UNKNOWN } });
    expect(refusal(await run({ title: 'x', changesets: [B, D] }))).toEqual({ isError: true, structured: { reason: 'not_prepared', changesetId: D } });
    expect(refusal(await run({ title: 'x', changesets: [B, C] }))).toEqual({ isError: true, structured: { reason: 'already_in_plan', changesetId: C } });
    // Upper and lower case name the same change-set.
    expect(refusal(await run({ title: 'x', changesets: [B, B.toUpperCase()] }))).toEqual({ isError: true, structured: { reason: 'duplicate_step' } });
    expect((await run({ title: 'x', changesets: [B, UNKNOWN] })).content[0]).toEqual({ type: 'text', text: `Change-set ${UNKNOWN} was not found.` });
  });

  it('MCP-10 every repository refusal maps to its reason and fixed text', async () => {
    const texts: Record<CreatePlanRefusal, string> = {
      not_found: `Change-set ${B} was not found.`,
      // Another user's change-set reads as unknown (SEC-1, the get_changeset rule).
      not_requester: `Change-set ${B} was not found.`,
      not_prepared: `Change-set ${B} is not prepared, or has expired; only prepared change-sets can be put in a plan.`,
      already_in_plan: `Change-set ${B} is already in a plan.`,
      duplicate_step: 'Each change-set can be listed only once.',
      too_few_steps: 'A plan needs at least 2 change-sets.',
      too_many_steps: 'A plan holds at most 20 change-sets.',
    };
    for (const [reason, text] of Object.entries(texts) as [CreatePlanRefusal, string][]) {
      const { store } = await setup();
      const withId = reason !== 'duplicate_step' && reason !== 'too_few_steps' && reason !== 'too_many_steps';
      store.createPlan = () => Promise.resolve({ ok: false, reason, ...(withId ? { changesetId: B } : {}) });
      const reports: AuditDetails[] = [];
      const tool = createPlanTool({ repository: store, newId: () => PLAN_ID, now: () => NOW });
      const result = plain(await tool.handler({ title: 'x', changesets: [A, B] }, { caller: alice, snapshot: undefined as never, correlationId: 'c', tasks: false, report: (d) => reports.push(d) }));
      const answered = reason === 'not_requester' ? 'not_found' : reason;
      expect(result, reason).toEqual({ isError: true, content: [{ type: 'text', text }], structuredContent: { reason: answered, ...(withId ? { changesetId: B } : {}) } });
      expect(reports, reason).toEqual([{ errorCode: reason }]);
    }
  });

  it('MCP-10 SEC-1 another user\'s change-set reads as not found and never yields its operation or status', async () => {
    const { store, run, reports, calls } = await setup();
    for (const list of [[A, BOBS], [BOBS, A], [BOBS, UNKNOWN], [UNKNOWN, BOBS]]) {
      const result = await run({ title: 'x', changesets: list });
      const first = list.find((id) => id !== A) ?? '';
      expect(refusal(result), list.join()).toEqual({ isError: true, structured: { reason: 'not_found', changesetId: first } });
      const text = JSON.stringify(result);
      expect(text).not.toContain('shop.secret_operation');
      expect(text).not.toContain('prepared');
      expect(text).not.toContain('not_requester');
    }
    // The visibility check comes first: no plan is attempted, nothing is written.
    expect(calls).not.toContain('createPlan');
    expect(await store.get(BOBS)).not.toHaveProperty('plan');
    expect(reports.every((r) => r.errorCode === 'not_found')).toBe(true);
  });

  it('MCP-10 the tool changes state and is named create_plan', async () => {
    const { tool } = await setup();
    expect(tool.name).toBe(PLAN_TOOL);
    expect(PLAN_TOOL).toBe('create_plan');
    expect(tool.readOnlyHint).toBe(false);
    expect(tool.inputSchema).toMatchObject({
      type: 'object',
      required: ['title', 'changesets'],
      additionalProperties: false,
      properties: { changesets: { type: 'array', minItems: 2, maxItems: 20, items: { type: 'string', format: 'uuid' } }, title: { type: 'string', minLength: 1, maxLength: 200 } },
    });
  });
});
