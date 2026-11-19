import type { CallToolResult } from '@modelcontextprotocol/server';
import { describe, expect, it } from 'vitest';
import { CHANGESET_TEXT, READ_RESULT_TEXT, type Caller, type ChangeSetStatus } from '@aiops/core';
import { InMemoryAuditLog, InMemoryChangeSetRepository } from '@aiops/testing';
import { preparedAnswer } from '../changesets/results.js';
import type { AuditDetails } from './audited-tool.js';
import { EXCLUDE_TOOL, excludeChangesetItemsTool } from './exclude-tool.js';
import { isTaskAnswer, type ToolAnswer } from './tasks/task-result.js';

function plain(answer: ToolAnswer): CallToolResult {
  if (isTaskAnswer(answer)) throw new Error('unexpected task answer');
  return answer;
}

function texts(result: CallToolResult): string[] {
  return result.content.map((c) => (c.type === 'text' ? c.text : ''));
}

const SOURCE = '11111111-1111-4111-8111-111111111111';
const UNKNOWN = '99999999-9999-4999-8999-999999999999';
const HASH = `sha256:${'a'.repeat(64)}`;
const NOW = new Date('2026-11-17T10:00:00.000Z');
const EXPIRES = new Date('2026-11-18T10:00:00.000Z');
const TARGETS = ['SECRET-T1', 'SECRET-T2', 'SECRET-T3'];
const alice: Caller = { subject: 'alice', clientId: 'aiops-mcp', groups: ['content'] };
const bob: Caller = { subject: 'bob', groups: ['content'] };

/** A source of three pending items and one `not_found` exclusion, owned by alice, in `stage`. */
async function setup(options: { expiresAt?: Date; stage?: ChangeSetStatus; risk?: 'write' | 'write_opaque' } = {}) {
  const repository = new InMemoryChangeSetRepository(new InMemoryAuditLog());
  const event = { id: 'a0', actor: 'alice', action: 'changeset.transition' as const, outcome: 'ok' as const, correlationId: 'c0', details: {} };
  await repository.create(
    {
      id: SOURCE,
      operation: 'catalog.update_content',
      connection: 'magento',
      requester: 'alice',
      args: { brand: 'acme' },
      configHash: 'h',
      correlationId: 'c0',
      createdAt: NOW,
      expiresAt: options.expiresAt ?? EXPIRES,
    },
    event,
  );
  await repository.appendItems(SOURCE, [
    ...TARGETS.map((targetId) => ({ targetId, status: 'pending' as const, before: { name: 'old' }, after: { name: 'new' } })),
    { targetId: 'SECRET-T4', status: 'excluded' as const, reason: 'not_found' as const, before: null, after: null },
  ]);
  await repository.completePreparation(
    SOURCE,
    { status: 'prepared', hash: HASH, stats: { total: 4, included: 3, excluded: { not_found: 1 }, written: 0, failed: 0, skipped: 0 }, preparedAt: NOW },
    { ...event, id: 'a1' },
  );
  if (options.stage !== undefined && options.stage !== 'prepared') {
    const moved = await repository.transition(SOURCE, ['prepared'], options.stage, { ...event, id: 'a2' });
    if (moved === undefined) throw new Error('transition failed');
  }
  let n = 0;
  const started: string[] = [];
  const tool = excludeChangesetItemsTool({
    repository,
    starter: {
      start: (id) => {
        started.push(id);
        return Promise.resolve();
      },
    },
    newId: () => `00000000-0000-4000-8000-${String(++n).padStart(12, '0')}`,
    now: () => NOW,
    onStartFailure: () => undefined,
  });
  const reported: AuditDetails[] = [];
  const ctx = (caller: Caller) => ({
    caller,
    // The tool reads only the operations' risk and manifest from the snapshot.
    snapshot: { configuration: { policy: { operations: [{ id: 'catalog.update_content', risk: options.risk ?? 'write', manifest: {} }] } } } as never,
    correlationId: 'corr-6',
    tasks: false,
    report: (d: AuditDetails) => {
      reported.push(d);
    },
  });
  const reportedAll = (): AuditDetails => Object.assign({}, ...reported) as AuditDetails;
  return { repository, tool, ctx, reportedAll, started };
}

describe('MCP-8 CS-5 exclude_changeset_items', () => {
  it('MCP-8 SEC-1 publishes a strict schema without root combinators and readOnlyHint false', async () => {
    const { tool } = await setup();
    const targets = { type: 'array', maxItems: 1000, items: { type: 'string', minLength: 1, maxLength: 512 } };
    expect(tool.name).toBe(EXCLUDE_TOOL);
    expect(EXCLUDE_TOOL).toBe('exclude_changeset_items');
    expect(tool.readOnlyHint).toBe(false);
    expect(tool.description).toBe(
      'Remove items from a change-set you prepared (or put back items you removed) before submitting it: this creates a new change-set with its own ID and hash; the original stays unchanged.',
    );
    expect(tool.inputSchema).toEqual({
      type: 'object',
      properties: {
        changeset_id: { type: 'string', format: 'uuid' },
        hash: { type: 'string', pattern: '^sha256:[0-9a-f]{64}$' },
        exclude: targets,
        include: targets,
      },
      required: ['changeset_id', 'hash'],
      additionalProperties: false,
    });
    for (const combinator of ['allOf', 'anyOf', 'oneOf', 'not', 'if']) expect(tool.inputSchema).not.toHaveProperty(combinator);
    expect(tool.validate({ changeset_id: SOURCE, hash: HASH, exclude: ['x'] })).toEqual({ ok: true });
    expect(tool.validate({ changeset_id: 'nope', hash: HASH }).ok).toBe(false);
    expect(tool.validate({ changeset_id: SOURCE, hash: 'sha256:x' }).ok).toBe(false);
    expect(tool.validate({ changeset_id: SOURCE, hash: HASH, exclude: [''] }).ok).toBe(false);
    expect(tool.validate({ changeset_id: SOURCE, hash: HASH, exclude: ['x'.repeat(513)] }).ok).toBe(false);
    expect(tool.validate({ changeset_id: SOURCE, hash: HASH, exclude: Array.from({ length: 1001 }, () => 'x') }).ok).toBe(false);
    expect(tool.validate({ changeset_id: SOURCE, hash: HASH, other: 1 }).ok).toBe(false);
  });

  it('CS-5 answers the prepared result of the new change-set with derivedFrom', async () => {
    const { tool, ctx, repository, reportedAll, started } = await setup();
    const result = plain(await tool.handler({ changeset_id: SOURCE, hash: HASH, exclude: ['SECRET-T1'] }, ctx(alice)));
    expect(result.isError).toBeUndefined();
    const derived = await repository.get(started[0] ?? '');
    if (derived === undefined) throw new Error('no derived change-set was started');
    expect(derived.derivedFrom).toBe(SOURCE);
    const expected = { ...(await preparedAnswer(repository, derived)).structured, derivedFrom: SOURCE };
    expect(result.structuredContent).toEqual(expected);
    const [summary, data, ...rest] = texts(result);
    expect(rest).toEqual([]);
    expect(summary).toBe(
      `Change-set ${derived.id} replaces ${SOURCE} for your submission: 2 change(s), 2 excluded (1 by you). ` +
        `New hash ${derived.hash ?? ''}; expires ${EXPIRES.toISOString()}. ${CHANGESET_TEXT.nothingWritten} ${CHANGESET_TEXT.seeAll} ${READ_RESULT_TEXT.dataNote}`,
    );
    expect(data).toBe(JSON.stringify(result.structuredContent));
    expect(derived.hash).not.toBe(HASH);
    expect(reportedAll()).toEqual({ changesetId: derived.id, derivedFrom: SOURCE, excludeCount: 1, includeCount: 0 });
    // The source is unchanged.
    expect(await repository.get(SOURCE)).toMatchObject({ status: 'prepared', hash: HASH });
  });

  describe('CS-5 every refusal has its fixed text', () => {
    const cases: {
      name: string;
      code: string;
      setup?: Parameters<typeof setup>[0];
      caller?: Caller;
      args: Record<string, unknown>;
      text: string;
    }[] = [
      { name: 'unknown change-set', code: 'not_found', args: { changeset_id: UNKNOWN, hash: HASH, exclude: ['SECRET-T1'] }, text: `Change-set ${UNKNOWN} was not found.` },
      { name: 'foreign change-set', code: 'not_found', caller: bob, args: { changeset_id: SOURCE, hash: HASH, exclude: ['SECRET-T1'] }, text: `Change-set ${SOURCE} was not found.` },
      { name: 'due to expire', code: 'expired', setup: { expiresAt: NOW }, args: { changeset_id: SOURCE, hash: HASH, exclude: ['SECRET-T1'] }, text: `Change-set ${SOURCE} has expired.` },
      { name: 'already expired', code: 'expired', setup: { stage: 'expired' }, args: { changeset_id: SOURCE, hash: HASH, exclude: ['SECRET-T1'] }, text: `Change-set ${SOURCE} has expired.` },
      { name: 'not prepared', code: 'not_prepared', setup: { stage: 'executing' }, args: { changeset_id: SOURCE, hash: HASH, exclude: ['SECRET-T1'] }, text: `Change-set ${SOURCE} cannot be edited in status executing.` },
      { name: 'stale hash', code: 'hash_mismatch', args: { changeset_id: SOURCE, hash: `sha256:${'b'.repeat(64)}`, exclude: ['SECRET-T1'] }, text: 'The change-set changed; review it again.' },
      {
        name: 'control character',
        code: 'invalid_request',
        args: { changeset_id: SOURCE, hash: HASH, exclude: ['SECRET\u0000T1'] },
        text: 'At most 1000 target IDs per call, each 1 to 512 characters without control characters.',
      },
      {
        name: 'more than 1000 together',
        code: 'invalid_request',
        args: { changeset_id: SOURCE, hash: HASH, exclude: Array.from({ length: 600 }, () => 'x'), include: Array.from({ length: 401 }, () => 'y') },
        text: 'At most 1000 target IDs per call, each 1 to 512 characters without control characters.',
      },
      { name: 'nothing named', code: 'empty_request', args: { changeset_id: SOURCE, hash: HASH }, text: 'Name at least one item to exclude or include.' },
      {
        name: 'unknown items',
        code: 'unknown_items',
        args: { changeset_id: SOURCE, hash: HASH, exclude: ['SECRET-T4', 'SECRET-T9'] },
        text: '2 of the named items cannot be changed: exclude only included items, include only items you excluded.',
      },
      { name: 'nothing left', code: 'nothing_left', args: { changeset_id: SOURCE, hash: HASH, exclude: TARGETS }, text: 'Excluding these items would leave nothing to change.' },
    ];
    it.each(cases)('CS-5 $name answers $code', async (c) => {
      const { tool, ctx, reportedAll, started } = await setup(c.setup);
      expect(tool.validate(c.args)).toEqual({ ok: true });
      const result = plain(await tool.handler(c.args, ctx(c.caller ?? alice)));
      // MCP-6: a refusal for the caller's own change-set names it, so the pipeline links its page.
      const named = c.code === 'not_found' ? {} : { structuredContent: { changesetId: SOURCE } };
      expect(result).toEqual({ isError: true, content: [{ type: 'text', text: c.text }], ...named });
      expect(reportedAll()).toEqual({ errorCode: c.code });
      expect(started).toEqual([]);
    });
  });

  it('CS-5 exclude_changeset_items refuses an opaque change-set', async () => {
    const { tool, ctx, reportedAll, started } = await setup({ risk: 'write_opaque' });
    const result = plain(await tool.handler({ changeset_id: SOURCE, hash: HASH, exclude: ['SECRET-T1'] }, ctx(alice)));
    expect(result).toEqual({
      isError: true,
      content: [{ type: 'text', text: `Change-set ${SOURCE} is a single upstream call; it has no items to exclude.` }],
      structuredContent: { changesetId: SOURCE },
    });
    expect(reportedAll()).toEqual({ errorCode: 'not_excludable' });
    expect(started).toEqual([]);
  });

  it('MCP-6 a refusal after the requester check names the source change-set; not_found names none', async () => {
    const { tool, ctx } = await setup();
    const stale = plain(await tool.handler({ changeset_id: SOURCE, hash: `sha256:${'b'.repeat(64)}`, exclude: ['SECRET-T1'] }, ctx(alice)));
    expect(stale.structuredContent).toEqual({ changesetId: SOURCE });
    const foreign = plain(await tool.handler({ changeset_id: SOURCE, hash: HASH, exclude: ['SECRET-T1'] }, ctx(bob)));
    expect(foreign).not.toHaveProperty('structuredContent');
  });

  it('AUD-1 SEC-3 the reported details carry counts and ids, never target ids', async () => {
    const { tool, ctx, reportedAll } = await setup();
    plain(await tool.handler({ changeset_id: SOURCE, hash: HASH, exclude: ['SECRET-T1', 'SECRET-T2'] }, ctx(alice)));
    const first = reportedAll();
    plain(await tool.handler({ changeset_id: SOURCE, hash: HASH, exclude: ['SECRET-T9'] }, ctx(alice)));
    for (const details of [first, reportedAll()]) {
      expect(JSON.stringify(details)).not.toContain('SECRET');
      expect(JSON.stringify(details)).not.toContain('sha256:');
    }
    expect(first).toMatchObject({ excludeCount: 2, includeCount: 0, derivedFrom: SOURCE });
  });
});
