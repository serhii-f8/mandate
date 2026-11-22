// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Mandate Authors
import { describe, expect, it } from 'vitest';
import type { LoadedConfiguration } from '@mandate/config';
import type { Caller, ChangeSetRecord, ItemOutcome, OperationDefinition, PolicyDecision, PolicyEngine, RollbackStrategy } from '@mandate/core';
import { InMemoryChangeSetRepository } from '@mandate/testing';
import type { Snapshot } from '../mcp/tool-pipeline.js';
import { eligibilityDeps, rollbackBlock } from './rollback.js';

const ID = '11111111-1111-4111-8111-111111111111';
const NOW = new Date('2026-11-19T10:00:00.000Z');
const UNTIL = new Date('2026-11-26T10:00:00.000Z');
const OPERATION = 'shop.update_content';
const alice: Caller = { subject: 'alice', groups: ['content'] };
const dave: Caller = { subject: 'dave', groups: ['leads'] };

/** The snapshot fields eligibility reads: the operations' rollback strategies and the engine's decision. */
function stubSnapshot(options: { strategy?: RollbackStrategy['strategy']; effect?: PolicyDecision['effect'] } = {}): Snapshot {
  // Only `manifest.rollback.strategy` is read from the definition.
  const operation = { id: OPERATION, manifest: { rollback: { strategy: options.strategy ?? 'replay_previous_state' } } } as unknown as OperationDefinition;
  const engine: PolicyEngine = {
    grantedOperations: () => [],
    evaluate: () => ({ effect: options.effect ?? 'allow', rule: 'test', roles: [] }),
  };
  // Only `policy.operations` is read from the configuration.
  return { configuration: { policy: { operations: [operation] } } as unknown as LoadedConfiguration, engine };
}

/** A completed change-set of alice with `written` written items and one skipped, its window open until UNTIL. */
async function executed(written = 2): Promise<InMemoryChangeSetRepository> {
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
    { status: 'prepared', hashVersion: 1, hash: 'sha256:x', stats: { total: 3, included: 3, excluded: {}, written: 0, failed: 0, skipped: 0 }, preparedAt: NOW },
    { ...event, id: 'e1' },
  );
  await repository.transition(ID, ['prepared'], 'executing', { ...event, id: 'e2' });
  const outcomes: ItemOutcome[] = targets.map((targetId, i) => (i < written ? { targetId, status: 'written' } : { targetId, status: 'skipped', error: 'drift' }));
  await repository.recordItemOutcomes(ID, outcomes);
  await repository.transition(ID, ['executing'], 'completed', { ...event, id: 'e3' });
  await repository.openRollbackWindow(ID, UNTIL);
  return repository;
}

async function record(repository: InMemoryChangeSetRepository): Promise<ChangeSetRecord> {
  const cs = await repository.get(ID);
  if (cs === undefined) throw new Error('missing change-set');
  return cs;
}

describe('UI-4 rollback block', () => {
  it('UI-4 the block is available for the requester of an eligible change-set and absent for others', async () => {
    const repository = await executed();
    const deps = { repository, snapshot: stubSnapshot(), now: () => NOW };
    const cs = await record(repository);
    expect(await rollbackBlock(deps, cs, alice)).toStrictEqual({ available: true, count: 2, until: UNTIL.toISOString() });
    // A viewer who is not the requester never sees it available (ruling R10, T11/F3).
    expect(await rollbackBlock(deps, cs, dave)).toStrictEqual({ available: false });
  });

  it('UI-4 the block names the reason and, once present, the rollback stats', async () => {
    const repository = await executed();
    const cs = await record(repository);
    const block = (snapshot: Snapshot, now = NOW, r: ChangeSetRecord = cs, caller: Caller = alice) =>
      rollbackBlock({ repository, snapshot, now: () => now }, r, caller);
    expect(await block(stubSnapshot({ strategy: 'none' }))).toStrictEqual({ available: false, reason: 'strategy_none' });
    expect(await block(stubSnapshot(), UNTIL)).toStrictEqual({ available: false, reason: 'window_closed' });
    expect(await block(stubSnapshot({ effect: 'deny' }))).toStrictEqual({ available: false, reason: 'policy_denied' });
    expect(await block(stubSnapshot(), NOW, cs, alice)).not.toHaveProperty('reason');

    const nothing = await executed(0);
    expect(await rollbackBlock({ repository: nothing, snapshot: stubSnapshot(), now: () => NOW }, await record(nothing), alice)).toStrictEqual({
      available: false,
      reason: 'nothing_written',
    });

    const stats = { restored: 1, skipped: 1, failed: 0 };
    const rolled = { ...cs, stats: { ...cs.stats, rollback: stats } };
    expect(await block(stubSnapshot(), NOW, rolled, dave)).toStrictEqual({ available: false, stats });
    expect(await block(stubSnapshot({ strategy: 'none' }), NOW, rolled)).toStrictEqual({ available: false, reason: 'strategy_none', stats });
  });

  it('UI-4 eligibilityDeps takes the engine and the operations from the snapshot', () => {
    const snapshot = stubSnapshot();
    const repository = new InMemoryChangeSetRepository();
    const now = () => NOW;
    expect(eligibilityDeps(repository, snapshot, now)).toStrictEqual({ repository, engine: snapshot.engine, operations: snapshot.configuration.policy.operations, now });
  });
});
