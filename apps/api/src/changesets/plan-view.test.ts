// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Mandate Authors
import { describe, expect, it } from 'vitest';
import type { AuditEventInput } from '@mandate/core';
import { InMemoryAuditLog, InMemoryChangeSetRepository } from '@mandate/testing';
import { planBlock, planBlockFor } from './plan-view.js';

const NOW = new Date('2026-11-22T10:00:00.000Z');
const LATER = new Date('2026-11-23T10:00:00.000Z');
const A = '11111111-1111-4111-8111-111111111111';
const B = '22222222-2222-4222-8222-222222222222';
const PLAN_ID = '44444444-4444-4444-8444-444444444444';

const event = (id: string): AuditEventInput => ({ id: `e-${id}`, actor: 'alice', action: 'changeset.transition', outcome: 'ok', correlationId: 'c0', details: {} });

async function setup() {
  const repository = new InMemoryChangeSetRepository(new InMemoryAuditLog());
  for (const [id, op] of [[A, 'shop.retire_content'], [B, 'shop.update_content']] as const) {
    await repository.create({ id, operation: op, connection: 'shop', requester: 'alice', args: {}, configHash: 'h', correlationId: 'c0', createdAt: NOW, expiresAt: LATER }, event(id));
    await repository.completePreparation(
      id,
      { status: 'prepared', hashVersion: 1, hash: 'h', stats: { total: 0, included: 0, excluded: {}, written: 0, failed: 0, skipped: 0 }, preparedAt: NOW },
      event(`${id}-p`),
    );
  }
  const created = await repository.createPlan({ id: PLAN_ID, title: 'Spring launch', requester: 'alice', changesetIds: [A, B], now: NOW, audit: { ...event('plan'), action: 'plan.created' } });
  expect(created.ok).toBe(true);
  return repository;
}

describe('UI-4 CS-9 the plan block of a change-set', () => {
  it('UI-4 a change-set outside a plan has none', async () => {
    const repository = new InMemoryChangeSetRepository(new InMemoryAuditLog());
    await repository.create({ id: A, operation: 'shop.x', connection: 'shop', requester: 'alice', args: {}, configHash: 'h', correlationId: 'c0', createdAt: NOW, expiresAt: LATER }, event(A));
    const record = await repository.get(A);
    expect(record !== undefined && (await planBlockFor(repository, record, { subject: 'alice', roles: [] }))).toBeUndefined();
  });

  it('MCP-10 without a visibility check the steps carry no `visible`', async () => {
    const repository = await setup();
    const record = await repository.get(B);
    const block = record === undefined ? undefined : await planBlock(repository, record);
    expect(block?.steps).toEqual([
      { step: 1, id: A, operation: 'shop.retire_content', status: 'prepared' },
      { step: 2, id: B, operation: 'shop.update_content', status: 'prepared' },
    ]);
  });

  it('UI-4 the requester may open every step', async () => {
    const repository = await setup();
    const record = await repository.get(B);
    const block = record === undefined ? undefined : await planBlockFor(repository, record, { subject: 'alice', roles: [] });
    expect(block).toMatchObject({ id: PLAN_ID, title: 'Spring launch', step: 2, of: 2 });
    expect(block?.steps.map((s) => s.visible)).toEqual([true, true]);
  });

  it('UI-4 EXE-13 the block carries the line the views show for what the step waits for, built on the server', async () => {
    const repository = await setup();
    const blockOf = async (id: string) => {
      const record = await repository.get(id);
      return record === undefined ? undefined : planBlock(repository, record);
    };
    expect((await blockOf(B))?.startLine).toBe('Runs after step 1 completes (now: prepared)');
    // Step 1 has nothing to wait for.
    expect(await blockOf(A)).not.toHaveProperty('startLine');
    await repository.transition(A, ['prepared'], 'cancelled', event('a-cancel'));
    expect((await blockOf(B))?.startLine).toBe('Blocked: step 1 ended cancelled; this step cannot start');
  });

  it('UI-4 SEC-1 a sibling the viewer may not open is listed with `visible: false`; the shown step is always visible', async () => {
    const repository = await setup();
    const record = await repository.get(B);
    // Bob reached step 2 by another right, but holds none on step 1 (not requester, no role, no decision).
    const block = record === undefined ? undefined : await planBlockFor(repository, record, { subject: 'bob', roles: [] });
    expect(block?.steps).toEqual([
      { step: 1, id: A, operation: 'shop.retire_content', status: 'prepared', visible: false },
      { step: 2, id: B, operation: 'shop.update_content', status: 'prepared', visible: true },
    ]);
  });
});
