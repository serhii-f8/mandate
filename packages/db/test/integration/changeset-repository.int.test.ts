// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Mandate Authors
import { randomUUID } from 'node:crypto';
import { asc } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  compareTargetIds,
  type AuditEventInput,
  type AuditLog,
  type ChangeItemRecord,
  type ItemOutcome,
} from '@mandate/core';
import {
  describeApprovalRepositoryContract,
  describeChangeSetRepositoryContract,
  recordApproval,
  startPostgres,
  submitChangeSet,
  type ChangeSetRepositoryHarness,
  type StartedPostgres,
} from '@mandate/testing';
import { DrizzleAuditLog } from '../../src/audit-log.js';
import { PostgresChangeSetRepository } from '../../src/changeset-repository.js';
import { createDb, type Database } from '../../src/client.js';
import { PostgresNotificationOutbox } from '../../src/notification-outbox.js';
import { runMigrations } from '../../src/migrate.js';
import { auditEvent } from '../../src/schema.js';

let postgres: StartedPostgres;
let database: Database;

beforeAll(async () => {
  postgres = await startPostgres();
  const url = await postgres.createDatabase();
  await runMigrations(url);
  database = createDb(url, { onError: () => undefined });
});

afterAll(async () => {
  await database.close();
  await postgres.stop();
});

async function allAuditEvents(): Promise<AuditEventInput[]> {
  const rows = await database.db.select().from(auditEvent).orderBy(asc(auditEvent.seq));
  return rows.map((r) => ({
    id: r.id,
    actor: r.actor,
    ...(r.clientId === null ? {} : { clientId: r.clientId }),
    action: r.action as AuditEventInput['action'],
    ...(r.subject === null ? {} : { subject: r.subject }),
    ...(r.decision === null ? {} : { decision: r.decision as NonNullable<AuditEventInput['decision']> }),
    outcome: r.outcome as AuditEventInput['outcome'],
    correlationId: r.correlationId,
    ...(r.changesetId === null ? {} : { changesetId: r.changesetId }),
    details: r.details,
  }));
}

// One database for the whole suite (the audit table is append-only); every case uses fresh UUIDs.
function harness(): Promise<ChangeSetRepositoryHarness> {
  let failNext = false;
  const repository = new PostgresChangeSetRepository(database.db, {
    auditFor: (tx): AuditLog => {
      const real = new DrizzleAuditLog(tx);
      return {
        append: async (event) => {
          if (failNext) {
            failNext = false;
            throw new Error('audit down');
          }
          await real.append(event);
        },
      };
    },
  });
  return Promise.resolve({
    repository,
    auditEvents: allAuditEvents,
    failNextAudit: () => {
      failNext = true;
    },
    notifications: (changesetId) => new PostgresNotificationOutbox(database.db).listFor(changesetId),
  });
}

describeChangeSetRepositoryContract('postgres', harness);
describeApprovalRepositoryContract('postgres', harness);

function audit(changesetId: string): AuditEventInput {
  return {
    id: randomUUID(),
    actor: 'alice',
    action: 'changeset.transition',
    outcome: 'ok',
    correlationId: 'corr-imm',
    changesetId,
    details: {},
  };
}

function item(targetId: string, over: Partial<ChangeItemRecord> = {}): ChangeItemRecord {
  return { targetId, status: 'pending', before: { v: 1 }, after: { v: 2 }, ...over };
}

async function preparedWithItems(): Promise<string> {
  const repo = new PostgresChangeSetRepository(database.db);
  const id = randomUUID();
  await repo.create(
    {
      id,
      operation: 'catalog.update',
      connection: 'shop',
      requester: 'alice',
      args: { sku: 'a' },
      configHash: 'cfg',
      correlationId: 'corr-imm',
      createdAt: new Date('2026-01-01T00:00:00.000Z'),
      expiresAt: new Date('2026-01-02T00:00:00.000Z'),
    },
    audit(id),
  );
  await repo.appendItems(id, [item('p1'), item('p2'), item('x1', { status: 'excluded', reason: 'no_change' })]);
  const stats = await repo.stats(id);
  await repo.completePreparation(
    id,
    { status: 'prepared', hashVersion: 1, hash: 'h', stats, preparedAt: new Date('2026-01-01T00:00:01.000Z') },
    audit(id),
  );
  return id;
}

async function executingWithItems(): Promise<string> {
  const id = await preparedWithItems();
  await new PostgresChangeSetRepository(database.db).transition(id, ['prepared'], 'executing', audit(id));
  return id;
}

/** The statement must be refused by an immutability trigger (every trigger message says "rejected"). */
async function sqlRejects(text: string, params: unknown[]): Promise<void> {
  await expect(database.pool.query(text, params)).rejects.toThrow(/rejected/);
}

describe('CS-4 change-sets are immutable after prepared', () => {
  it('CS-4 change_set hash and identity columns cannot change after prepared', async () => {
    const id = await preparedWithItems();
    await sqlRejects('UPDATE change_set SET hash = $2 WHERE id = $1', [id, 'other']);
    await sqlRejects('UPDATE change_set SET prepared_at = now() WHERE id = $1', [id]);
    await sqlRejects(`UPDATE change_set SET args = '{"sku":"b"}'::jsonb WHERE id = $1`, [id]);
    await sqlRejects('UPDATE change_set SET operation = $2 WHERE id = $1', [id, 'other']);
    await sqlRejects('UPDATE change_set SET expires_at = now() WHERE id = $1', [id]);
    await sqlRejects('UPDATE change_set SET requester = $2 WHERE id = $1', [id, 'mallory']);
  });

  it('CS-4 change items cannot be changed, added or deleted after prepared', async () => {
    const id = await preparedWithItems();
    await sqlRejects(`UPDATE change_item SET after = '{"v":3}'::jsonb WHERE changeset_id = $1 AND target_id = 'p1'`, [id]);
    await sqlRejects(`UPDATE change_item SET before = '{"v":3}'::jsonb WHERE changeset_id = $1 AND target_id = 'p1'`, [id]);
    await sqlRejects(`UPDATE change_item SET reason = 'not_found' WHERE changeset_id = $1 AND target_id = 'x1'`, [id]);
    await sqlRejects(`UPDATE change_item SET target_id = 'p9' WHERE changeset_id = $1 AND target_id = 'p1'`, [id]);
    await sqlRejects(
      `INSERT INTO change_item (changeset_id, target_id, status, before, after) VALUES ($1, 'p3', 'pending', 'null', 'null')`,
      [id],
    );
    await sqlRejects('DELETE FROM change_item WHERE changeset_id = $1', [id]);
    await sqlRejects('DELETE FROM change_set WHERE id = $1', [id]);
  });

  it('CS-4 an excluded item stays excluded and no item becomes excluded', async () => {
    const id = await preparedWithItems();
    await sqlRejects(`UPDATE change_item SET status = 'pending' WHERE changeset_id = $1 AND target_id = 'x1'`, [id]);
    await sqlRejects(`UPDATE change_item SET status = 'excluded' WHERE changeset_id = $1 AND target_id = 'p1'`, [id]);
  });

  it('CS-4 item status and error cannot change while the change-set is not executing', async () => {
    const id = await preparedWithItems();
    await sqlRejects(`UPDATE change_item SET status = 'written' WHERE changeset_id = $1 AND target_id = 'p1'`, [id]);
    await sqlRejects(`UPDATE change_item SET error = 'x' WHERE changeset_id = $1 AND target_id = 'p1'`, [id]);
    await database.pool.query(`UPDATE change_set SET status = 'cancelled' WHERE id = $1`, [id]);
    await sqlRejects(`UPDATE change_item SET status = 'written' WHERE changeset_id = $1 AND target_id = 'p1'`, [id]);
  });

  it('CS-4 execution columns of non-excluded items stay updatable while executing', async () => {
    const id = await executingWithItems();
    const res = await database.pool.query(
      `UPDATE change_item SET status = 'written', error = NULL WHERE changeset_id = $1 AND target_id = 'p1'`,
      [id],
    );
    expect(res.rowCount).toBe(1);
    const repo = new PostgresChangeSetRepository(database.db);
    await repo.recordItemOutcomes(id, [{ targetId: 'p2', status: 'failed', error: 'upstream_5xx' }]);
    const rec = await repo.get(id);
    expect(rec?.stats).toMatchObject({ total: 3, included: 2, written: 1, failed: 1 });
    expect(rec?.hash).toBe('h');
  });

  it('CS-4 status transitions after prepared are allowed (checked in core, CAS in the repository)', async () => {
    const id = await preparedWithItems();
    const repo = new PostgresChangeSetRepository(database.db);
    const rec = await repo.transition(id, ['prepared'], 'pending_approval', audit(id));
    expect(rec?.status).toBe('pending_approval');
  });

  it('CS-4 target_id ordering in the database matches compareTargetIds', async () => {
    const repo = new PostgresChangeSetRepository(database.db);
    const id = randomUUID();
    await repo.create(
      {
        id,
        operation: 'catalog.update',
        connection: 'shop',
        requester: 'alice',
        args: {},
        configHash: 'cfg',
        correlationId: 'corr-imm',
        createdAt: new Date(),
        expiresAt: new Date(Date.now() + 60_000),
      },
      audit(id),
    );
    const ids = ['\u{1F600}', 'é', 'a', 'Z', '�', 'B', 'aa', 'A'];
    await repo.appendItems(id, ids.map((t) => item(t)));
    const res = await database.pool.query<{ target_id: string }>(
      'SELECT target_id FROM change_item WHERE changeset_id = $1 ORDER BY target_id',
      [id],
    );
    expect(res.rows.map((r) => r.target_id)).toEqual([...ids].sort(compareTargetIds));
  });
});

describe('NFR-7 change-set repository in PostgreSQL', () => {
  it('NFR-7 pages a large change-set by keyset without gaps or duplicates', async () => {
    const repo = new PostgresChangeSetRepository(database.db);
    const id = randomUUID();
    await repo.create(
      {
        id,
        operation: 'catalog.update',
        connection: 'shop',
        requester: 'alice',
        args: {},
        configHash: 'cfg',
        correlationId: 'corr-imm',
        createdAt: new Date(),
        expiresAt: new Date(Date.now() + 60_000),
      },
      audit(id),
    );
    const n = 1_234;
    for (let start = 0; start < n; start += 500) {
      const batch: ChangeItemRecord[] = [];
      for (let i = start; i < Math.min(n, start + 500); i += 1) batch.push(item(`sku-${String(i).padStart(5, '0')}`));
      expect(await repo.appendItems(id, batch)).toBe(batch.length);
    }
    const seen: string[] = [];
    let after: string | undefined;
    for (;;) {
      const page = await repo.itemsPage(id, { limit: 500, ...(after === undefined ? {} : { after }) });
      if (page.length === 0) break;
      seen.push(...page.map((p) => p.targetId));
      after = page[page.length - 1]?.targetId;
    }
    expect(seen).toHaveLength(n);
    expect(new Set(seen).size).toBe(n);
    expect((await repo.stats(id)).total).toBe(n);
  });

  it('CS-2 lookups with a malformed change-set id behave like unknown ids', async () => {
    const repo = new PostgresChangeSetRepository(database.db);
    expect(await repo.get('not-a-uuid')).toBeUndefined();
    expect(await repo.itemsPage('not-a-uuid', { limit: 10 })).toEqual([]);
    expect((await repo.stats('not-a-uuid')).total).toBe(0);
    expect(await repo.transition('not-a-uuid', ['prepared'], 'cancelled', audit(randomUUID()))).toBeUndefined();
    await expect(repo.appendItems('not-a-uuid', [item('a')])).rejects.toThrow();
  });
});

describe('CS-4 a change-set that reached prepared always has a hash', () => {
  async function preparing(): Promise<string> {
    const id = randomUUID();
    await new PostgresChangeSetRepository(database.db).create(
      {
        id,
        operation: 'catalog.update',
        connection: 'shop',
        requester: 'alice',
        args: {},
        configHash: 'cfg',
        correlationId: 'corr-imm',
        createdAt: new Date(),
        expiresAt: new Date(Date.now() + 60_000),
      },
      audit(id),
    );
    return id;
  }

  it('CS-4 statuses at or after prepared are refused without a hash', async () => {
    for (const status of [
      'prepared',
      'pending_approval',
      'approved',
      'executing',
      'completed',
      'completed_with_errors',
      'rolling_back',
      'rolled_back',
    ]) {
      const id = await preparing();
      await expect(
        database.pool.query('UPDATE change_set SET status = $2 WHERE id = $1', [id, status]),
      ).rejects.toThrow(/change_set_hash_when_prepared/);
    }
  });

  it('CS-4 failed, cancelled and expired may lack a hash', async () => {
    for (const status of ['failed', 'cancelled', 'expired']) {
      const id = await preparing();
      const res = await database.pool.query('UPDATE change_set SET status = $2 WHERE id = $1', [id, status]);
      expect(res.rowCount).toBe(1);
    }
  });
});

describe('CS-4 status never returns to preparing', () => {
  it('CS-4 the database refuses a status change back to preparing', async () => {
    const id = await preparedWithItems();
    await sqlRejects(`UPDATE change_set SET status = 'preparing' WHERE id = $1`, [id]);
    await database.pool.query(`UPDATE change_set SET status = 'cancelled' WHERE id = $1`, [id]);
    await sqlRejects(`UPDATE change_set SET status = 'preparing' WHERE id = $1`, [id]);
  });
});

describe('SEC-3 database errors never quote statement parameters', () => {
  async function thrownMessage(run: () => Promise<unknown>): Promise<string> {
    try {
      await run();
    } catch (error) {
      // No cause either: drizzle's error, the one that quotes parameters, must not travel along.
      expect(error).not.toHaveProperty('cause');
      return error instanceof Error ? error.message : String(error);
    }
    throw new Error('expected the call to throw');
  }

  it('SEC-3 transition refused by the database throws a fixed message with the SQLSTATE only', async () => {
    const id = await preparedWithItems();
    const repo = new PostgresChangeSetRepository(database.db);
    const message = await thrownMessage(() =>
      repo.transition(id, ['prepared'], 'preparing', audit(id), { errorCode: 'secret-error-code-41' }),
    );
    expect(message).not.toContain('secret-error-code-41');
    expect(message).not.toContain(id);
    expect(message).toMatch(/sqlstate 23000/);
    expect((await repo.get(id))?.status).toBe('prepared');
  });

  it('SEC-3 recordItemOutcomes refused by the database throws a fixed message with the SQLSTATE only', async () => {
    const id = await executingWithItems();
    const repo = new PostgresChangeSetRepository(database.db);
    // Not a valid outcome status: forces the trigger refusal (no item becomes excluded).
    const outcome = { targetId: 'p1', status: 'excluded', error: 'secret-upstream-text-77' } as unknown as ItemOutcome;
    const message = await thrownMessage(() => repo.recordItemOutcomes(id, [outcome]));
    expect(message).not.toContain('secret-upstream-text-77');
    expect(message).not.toContain('p1');
    expect(message).not.toContain(id);
    expect(message).toMatch(/sqlstate 23000/);
  });
});

describe('APR-3 recordDecision answers not_pending only for the step key', () => {
  it('APR-3 a duplicate approval id on another change-set is rethrown, not answered not_pending', async () => {
    const repo = new PostgresChangeSetRepository(database.db);
    const at = new Date('2026-01-01T00:00:02.000Z');
    const first = await repo.get(await preparedWithItems());
    const second = await repo.get(await preparedWithItems());
    if (first === undefined || second === undefined) throw new Error('missing change-set');
    await recordApproval(repo, await submitChangeSet(repo, first, { at }), { approver: 'bob' });
    const [stored] = await repo.approvals(first.id);
    if (stored === undefined) throw new Error('missing approval row');
    const pending = await submitChangeSet(repo, second, { at });
    const attempt = repo.recordDecision({
      changesetId: pending.id,
      round: 1,
      step: 1,
      record: { ...stored, changesetId: pending.id },
      next: { kind: 'approved' },
      audit: [audit(pending.id)],
      notifications: [],
    });
    await expect(attempt).rejects.toThrow(/sqlstate 23505/);
    expect(await repo.approvals(pending.id)).toEqual([]);
    expect((await repo.get(pending.id))?.status).toBe('pending_approval');
  });
});
