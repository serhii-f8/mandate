// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Mandate Authors
import type { CallToolResult } from '@modelcontextprotocol/server';
import { describe, expect, it } from 'vitest';
import type { LoadedConfiguration } from '@mandate/config';
import type {
  Caller,
  ChangeSetRepository,
  ChangeSetStatus,
  ItemOutcome,
  OperationDefinition,
  PolicyDecision,
  PolicyEngine,
  RollbackRequest,
  RollbackStrategy,
} from '@mandate/core';
import { InMemoryChangeSetRepository } from '@mandate/testing';
import { pageLink } from '../changesets/links.js';
import type { AuditDetails } from './audited-tool.js';
import { ROLLBACK_TOOL, rollbackChangesetTool } from './rollback-tool.js';
import { isTaskAnswer, type ToolAnswer } from './tasks/task-result.js';
import type { Snapshot } from './tool-pipeline.js';

const ID = '11111111-1111-4111-8111-111111111111';
const UNKNOWN = '99999999-9999-4999-8999-999999999999';
const HASH = `sha256:${'a'.repeat(64)}`;
const OTHER_HASH = `sha256:${'b'.repeat(64)}`;
const NOW = new Date('2026-11-19T10:00:00.000Z');
const UNTIL = new Date('2026-11-26T10:00:00.000Z');
const PUBLIC = new URL('https://mandate.example.test');
const OPERATION = 'shop.update_content';
const alice: Caller = { subject: 'alice', groups: ['content'], clientId: 'mandate-mcp' };
const bob: Caller = { subject: 'bob', groups: ['content'] };

function stubSnapshot(options: { strategy?: RollbackStrategy['strategy']; effect?: PolicyDecision['effect'] } = {}): Snapshot {
  // Only `manifest.rollback.strategy` is read from the definition.
  const operation = { id: OPERATION, manifest: { rollback: { strategy: options.strategy ?? 'replay_previous_state' } } } as unknown as OperationDefinition;
  const engine: PolicyEngine = { grantedOperations: () => [], evaluate: () => ({ effect: options.effect ?? 'allow', rule: 'test', roles: [] }) };
  // Only `policy.operations` is read from the configuration.
  return { configuration: { policy: { operations: [operation] } } as unknown as LoadedConfiguration, engine };
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

interface Setup {
  status?: ChangeSetStatus;
  written?: number;
  window?: boolean;
  rollbackRequest?: boolean;
}

/** alice's change-set of three items, `written` of them written, finished in `status` with its window open until UNTIL. */
async function setup(o: Setup = {}) {
  const repository = new InMemoryChangeSetRepository();
  const event = { id: 'e0', actor: 'alice', action: 'changeset.transition' as const, outcome: 'ok' as const, correlationId: 'c0', details: {} };
  await repository.create(
    { id: ID, operation: OPERATION, connection: 'shop', requester: 'alice', args: { brand: 'acme' }, configHash: 'h', correlationId: 'c0', createdAt: NOW, expiresAt: UNTIL },
    event,
  );
  const targets = ['a', 'b', 'c'];
  await repository.appendItems(ID, targets.map((targetId) => ({ targetId, status: 'pending' as const, before: { name: 'old' }, after: { name: 'new' } })));
  await repository.completePreparation(
    ID,
    { status: 'prepared', hashVersion: 1, hash: HASH, stats: { total: 3, included: 3, excluded: {}, written: 0, failed: 0, skipped: 0 }, preparedAt: NOW },
    { ...event, id: 'e1' },
  );
  const status = o.status ?? 'completed';
  if (status !== 'prepared') {
    await repository.transition(ID, ['prepared'], 'executing', { ...event, id: 'e2' });
    const written = o.written ?? 2;
    const outcomes: ItemOutcome[] = targets.map((targetId, i) => (i < written ? { targetId, status: 'written' } : { targetId, status: 'skipped', error: 'drift' }));
    await repository.recordItemOutcomes(ID, outcomes);
    if (status !== 'executing') await repository.transition(ID, ['executing'], status, { ...event, id: 'e3' });
  }
  if (o.window ?? true) await repository.openRollbackWindow(ID, UNTIL);
  if (o.rollbackRequest === true) {
    const request: RollbackRequest = { actor: 'alice', correlationId: 'c-rb', requestedAt: NOW };
    const r = await repository.requestRollback({ changesetId: ID, request, marginMs: 60_000, audit: [{ ...event, id: 'e4' }] });
    if (!r.ok) throw new Error(`requestRollback refused: ${r.reason}`);
  }
  const seen = spied(repository);
  // The tool gets no executor: it only checks and links to the page (SEC-8).
  const tool = rollbackChangesetTool({ repository: seen.repository, now: () => NOW, publicUrl: PUBLIC });
  const reports: AuditDetails[] = [];
  const call = async (caller: Caller, args: Record<string, unknown> = {}, snapshot: Snapshot = stubSnapshot()): Promise<CallToolResult> => {
    const full = { changeset_id: ID, hash: HASH, ...args };
    const check = tool.validate(full);
    if (!check.ok) throw new Error(check.message);
    const answer: ToolAnswer = await tool.handler(full, { caller, snapshot, correlationId: 'corr-rb', tasks: false, report: (d) => reports.push(d) });
    if (isTaskAnswer(answer)) throw new Error('unexpected task answer');
    return answer;
  };
  return { repository, tool, call, reports, repositoryCalls: seen.calls };
}

const first = (r: CallToolResult): string => (r.content[0]?.type === 'text' ? r.content[0].text : '');

describe('MCP-8 rollback_changeset', () => {
  it('MCP-3 the input takes a uuid and a hash, both required, and nothing else', async () => {
    const { tool } = await setup();
    expect(tool.validate({ changeset_id: ID, hash: HASH })).toEqual({ ok: true });
    for (const bad of [{ changeset_id: ID }, { hash: HASH }, { changeset_id: 'nope', hash: HASH }, { changeset_id: ID, hash: 'sha256:xyz' }, { changeset_id: ID, hash: HASH, extra: 1 }]) {
      expect(tool.validate(bad).ok, JSON.stringify(bad)).toBe(false);
    }
    expect(tool).toMatchObject({ name: ROLLBACK_TOOL, widget: 'changeset', readOnlyHint: false });
    expect(ROLLBACK_TOOL).toBe('rollback_changeset');
    // Listed to every caller, like cancel_changeset (SEC-1: the handler decides per change-set).
    expect('visibleTo' in tool).toBe(false);
  });

  it('MCP-8 success names the count, the window end and the page link', async () => {
    const { call, reports } = await setup();
    const result = await call(alice);
    const url = pageLink(PUBLIC, ID);
    expect(result.isError).toBeUndefined();
    expect(first(result)).toBe(`Rollback of 2 item(s) of change-set ${ID} is possible until ${UNTIL.toISOString()}. Confirm it on the page: ${url}`);
    expect(result.structuredContent).toStrictEqual({
      changesetId: ID,
      status: 'completed',
      rollback: { available: true, count: 2, until: UNTIL.toISOString() },
      pageUrl: url,
    });
    expect(reports).toStrictEqual([{ changesetId: ID, count: 2 }]);
  });

  it('MCP-8 each refusal has its fixed text and code', async () => {
    const cases: { name: string; setup: Setup; args?: Record<string, unknown>; snapshot?: Snapshot; code: string; reason?: string; text: string }[] = [
      { name: 'hash', setup: {}, args: { hash: OTHER_HASH }, code: 'hash_mismatch', text: 'The change-set changed; review it again.' },
      {
        name: 'requested',
        setup: { rollbackRequest: true },
        code: 'not_rollbackable',
        reason: 'already_rolled_back',
        text: `Change-set ${ID} was already rolled back, or a rollback was requested.`,
      },
      { name: 'executing', setup: { status: 'executing', window: false }, code: 'not_rollbackable', reason: 'not_finished', text: `Change-set ${ID} cannot be rolled back in status executing.` },
      {
        name: 'none',
        setup: {},
        snapshot: stubSnapshot({ strategy: 'none' }),
        code: 'not_rollbackable',
        reason: 'strategy_none',
        text: `The operation of change-set ${ID} does not allow rollback.`,
      },
      { name: 'window', setup: { window: false }, code: 'not_rollbackable', reason: 'window_closed', text: `The rollback window of change-set ${ID} has closed.` },
      { name: 'nothing', setup: { written: 0 }, code: 'not_rollbackable', reason: 'nothing_written', text: `Change-set ${ID} wrote no item that can be rolled back.` },
      {
        name: 'policy',
        setup: {},
        snapshot: stubSnapshot({ effect: 'deny' }),
        code: 'policy_denied',
        text: 'You may no longer run this operation, so you cannot roll it back.',
      },
    ];
    for (const c of cases) {
      const { call, reports } = await setup(c.setup);
      const result = await call(alice, c.args, c.snapshot);
      expect(result.isError, c.name).toBe(true);
      expect(first(result), c.name).toBe(c.text);
      // A refusal after the requester check names the change-set, so the pipeline adds its page link (MCP-6).
      expect(result.structuredContent, c.name).toStrictEqual({ changesetId: ID, rollback: { available: false, reason: c.reason ?? c.code } });
      expect(reports, c.name).toStrictEqual([{ errorCode: c.code }]);
    }
  });

  it('MCP-8 the refusals come in the fixed order: hash before status, policy last', async () => {
    const stale = await setup({ status: 'executing', window: false });
    expect((await stale.call(alice, { hash: OTHER_HASH })).structuredContent).toMatchObject({ rollback: { reason: 'hash_mismatch' } });
    const denied = await setup({ window: false });
    expect((await denied.call(alice, {}, stubSnapshot({ effect: 'deny' }))).structuredContent).toMatchObject({ rollback: { reason: 'window_closed' } });
  });

  it('SEC-1 a foreign change-set is not found without a link', async () => {
    const { call, reports } = await setup();
    for (const [caller, id] of [
      [bob, ID],
      [alice, UNKNOWN],
    ] as const) {
      const result = await call(caller, { changeset_id: id });
      expect(result).toStrictEqual({ isError: true, content: [{ type: 'text', text: `Change-set ${id} was not found.` }] });
    }
    expect(reports).toStrictEqual([{ errorCode: 'not_found' }, { errorCode: 'not_found' }]);
  });

  it('MCP-8 the tool never changes state', async () => {
    const { call, repository, repositoryCalls } = await setup();
    const before = await repository.get(ID);
    const itemsBefore = await repository.itemsPage(ID, { limit: 10 });
    await call(alice);
    await call(alice, { hash: OTHER_HASH });
    await call(bob);
    // Reads only: the change-set and its rollbackable count.
    expect(new Set(repositoryCalls)).toStrictEqual(new Set(['get', 'rollbackableCount']));
    expect(await repository.get(ID)).toStrictEqual(before);
    expect(await repository.itemsPage(ID, { limit: 10 })).toStrictEqual(itemsBefore);
  });
});
