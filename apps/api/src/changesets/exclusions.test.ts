// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The AI Operations Layer Authors
import { describe, expect, it } from 'vitest';
import type { Caller, WorkflowStarter } from '@aiops/core';
import { InMemoryAuditLog, InMemoryChangeSetRepository } from '@aiops/testing';
import { excludeItems } from './exclusions.js';

const SOURCE = '11111111-1111-4111-8111-111111111111';
const HASH = `sha256:${'a'.repeat(64)}`;
const NOW = new Date('2026-11-17T10:00:00.000Z');
const alice: Caller = { subject: 'alice', clientId: 'aiops-mcp', groups: ['content'] };

class RecordingStarter implements WorkflowStarter {
  readonly started: string[] = [];
  fail = false;

  start(changesetId: string): Promise<void> {
    if (this.fail) return Promise.reject(new Error('temporal down'));
    this.started.push(changesetId);
    return Promise.resolve();
  }
}

/** A prepared source of three pending items owned by alice. */
async function setup() {
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
      expiresAt: new Date('2026-11-18T10:00:00.000Z'),
    },
    event,
  );
  await repository.appendItems(SOURCE, ['t-1', 't-2', 't-3'].map((targetId) => ({ targetId, status: 'pending' as const, before: null, after: null })));
  await repository.completePreparation(
    SOURCE,
    { status: 'prepared', hash: HASH, stats: { total: 3, included: 3, excluded: {}, written: 0, failed: 0, skipped: 0 }, preparedAt: NOW },
    { ...event, id: 'a1' },
  );
  let n = 0;
  const starter = new RecordingStarter();
  const failures: { id: string; error: unknown }[] = [];
  const deps = {
    repository,
    starter,
    newId: () => `00000000-0000-4000-8000-${String(++n).padStart(12, '0')}`,
    now: () => NOW,
    onStartFailure: (id: string, error: unknown) => {
      failures.push({ id, error });
    },
  };
  const request = (exclude: string[], hash = HASH) => ({ sourceId: SOURCE, hash, exclude, include: [], caller: alice, correlationId: 'corr-1', excludable: () => true });
  return { repository, starter, failures, deps, request };
}

describe('EXE-1 CS-5 excludeItems', () => {
  it('EXE-1 CS-5 a derived change-set gets its workflow started', async () => {
    const { deps, starter, request } = await setup();
    const outcome = await excludeItems(deps, request(['t-1']));
    if (!outcome.ok) throw new Error(outcome.reason);
    expect(outcome.changeset.id).not.toBe(SOURCE);
    expect(starter.started).toEqual([outcome.changeset.id]);
  });

  it('EXE-1 a refused derivation starts nothing', async () => {
    const { deps, starter, failures, request } = await setup();
    const outcome = await excludeItems(deps, request(['t-1'], `sha256:${'b'.repeat(64)}`));
    expect(outcome).toEqual({ ok: false, reason: 'hash_mismatch' });
    expect(starter.started).toEqual([]);
    expect(failures).toEqual([]);
  });

  it('EXE-1 a failed workflow start is reported and the derivation still succeeds', async () => {
    const { deps, starter, failures, repository, request } = await setup();
    starter.fail = true;
    const outcome = await excludeItems(deps, request(['t-1']));
    if (!outcome.ok) throw new Error(outcome.reason);
    expect(failures).toHaveLength(1);
    expect(failures[0]?.id).toBe(outcome.changeset.id);
    expect(failures[0]?.error).toBeInstanceOf(Error);
    expect((await repository.get(outcome.changeset.id))?.status).toBe('prepared');
  });
});
