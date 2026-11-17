import { describe, expect, it } from 'vitest';
import { encodeCursor, type Caller } from '@aiops/core';
import { InMemoryChangeSetRepository } from '@aiops/testing';
import { createChangesetTools } from './changeset-tools.js';

const alice: Caller = { subject: 'alice', groups: [] };
const bob: Caller = { subject: 'bob', groups: [] };
const ID = '11111111-1111-4111-8111-111111111111';
const NOW = new Date('2026-01-01T12:00:00Z');

async function setup(expiresAt = new Date('2026-01-02T12:00:00Z')) {
  const repository = new InMemoryChangeSetRepository();
  const base = { operation: 'shop.update_content', connection: 'shop', requester: 'alice', args: {}, configHash: 'h', correlationId: 'c0', createdAt: NOW, expiresAt };
  const audit = { id: 'a0', actor: 'alice', action: 'changeset.transition' as const, outcome: 'ok' as const, correlationId: 'c0', details: {} };
  await repository.create({ id: ID, ...base }, audit);
  await repository.appendItems(ID, ['a', 'b', 'c'].map((targetId) => ({ targetId, status: 'pending' as const, before: null, after: null })));
  await repository.completePreparation(
    ID,
    { status: 'prepared', hash: 'sha256:x', stats: { total: 3, included: 3, excluded: {}, written: 0, failed: 0, skipped: 0 }, preparedAt: NOW },
    { ...audit, id: 'a1' },
  );
  let n = 0;
  const [get, cancel] = createChangesetTools({ repository, newId: () => `id-${String(n++)}`, now: () => NOW });
  if (get === undefined || cancel === undefined) throw new Error('tools missing');
  // The handlers under test use only the caller and the correlation ID from the context.
  const ctx = (caller: Caller) => ({ caller, snapshot: undefined as never, correlationId: 'c1' });
  return { repository, get, cancel, ctx };
}

describe('MCP-8 CS-6 built-in change-set tools', () => {
  it('MCP-8 get_changeset pages items with an opaque cursor', async () => {
    const { get, ctx } = await setup();
    const first = await get.handler({ changeset_id: ID, page_size: 2 }, ctx(alice));
    const s = first.structuredContent as { items: { targetId: string }[]; nextCursor?: string };
    expect(s.items.map((i) => i.targetId)).toEqual(['a', 'b']);
    expect(s.nextCursor).toBe(encodeCursor('b'));
    expect(first.content[0]?.type === 'text' ? first.content[0].text : '').toContain('is prepared: 3 change(s), 0 excluded. Showing 2 item(s); more with cursor.');
    const second = await get.handler({ changeset_id: ID, page_size: 2, cursor: s.nextCursor }, ctx(alice));
    expect((second.structuredContent as { items: unknown[]; nextCursor?: string }).nextCursor).toBeUndefined();
  });

  it('MCP-8 an invalid cursor is refused without echoing it', async () => {
    const { get, ctx } = await setup();
    const result = await get.handler({ changeset_id: ID, cursor: '!!bad!!' }, ctx(alice));
    expect(result).toEqual({ isError: true, content: [{ type: 'text', text: 'Input validation error: Invalid arguments for tool get_changeset: cursor is not valid' }] });
  });

  it('MCP-8 a foreign change-set looks like an unknown one', async () => {
    const { get, cancel, ctx } = await setup();
    for (const tool of [get, cancel]) {
      const result = await tool.handler({ changeset_id: ID }, ctx(bob));
      expect(result.content).toEqual([{ type: 'text', text: `Change-set ${ID} was not found.` }]);
      expect(result.isError).toBe(true);
    }
  });

  it('MCP-8 input schemas require a uuid and reject extra arguments', async () => {
    const { get } = await setup();
    expect(get.validate({ changeset_id: 'nope' }).ok).toBe(false);
    expect(get.validate({ changeset_id: ID, page_size: 101 }).ok).toBe(false);
    expect(get.validate({ changeset_id: ID, extra: 1 }).ok).toBe(false);
  });

  it('CS-6 a due change-set expires lazily with actor system', async () => {
    const { get, ctx, repository } = await setup(new Date('2026-01-01T11:00:00Z'));
    const result = await get.handler({ changeset_id: ID }, ctx(alice));
    expect((result.structuredContent as { changeset: { status: string } }).changeset.status).toBe('expired');
    expect(repository.audit.events.at(-1)).toMatchObject({ actor: 'system', action: 'changeset.transition', details: { from: 'prepared', to: 'expired' } });
  });

  it('MCP-8 cancel works once, then reports the status', async () => {
    const { cancel, ctx, repository } = await setup();
    const done = await cancel.handler({ changeset_id: ID }, ctx(alice));
    expect(done.content).toEqual([{ type: 'text', text: `Change-set ${ID} was cancelled.` }]);
    expect(repository.audit.events.at(-1)).toMatchObject({ actor: 'alice', details: { from: 'prepared', to: 'cancelled' } });
    const again = await cancel.handler({ changeset_id: ID }, ctx(alice));
    expect(again).toEqual({ isError: true, content: [{ type: 'text', text: `Change-set ${ID} cannot be cancelled in status cancelled.` }] });
  });
});
