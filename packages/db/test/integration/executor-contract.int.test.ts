// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Mandate Authors
import { randomUUID } from 'node:crypto';
import { asc } from 'drizzle-orm';
import { afterAll, beforeAll } from 'vitest';
import { EMPTY_STATS, type AuditEventInput, type ChangeSetRecord } from '@mandate/core';
import {
  describeExecutorContract,
  describeRollbackRun,
  EXECUTOR_CONTRACT_HASH,
  InMemoryExecutor,
  ScriptedWriter,
  startPostgres,
  type StartedPostgres,
} from '@mandate/testing';
import { PostgresChangeSetRepository } from '../../src/changeset-repository.js';
import { createDb, type Database } from '../../src/client.js';
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
    outcome: r.outcome as AuditEventInput['outcome'],
    correlationId: r.correlationId,
    ...(r.changesetId === null ? {} : { changesetId: r.changesetId }),
    details: r.details,
  }));
}

function event(changesetId: string, details: AuditEventInput['details'] = {}): AuditEventInput {
  return {
    id: randomUUID(),
    actor: 'system',
    action: 'changeset.transition',
    outcome: 'ok',
    correlationId: 'corr-prep',
    changesetId,
    details,
  };
}

function harness(rollbackWriter?: ScriptedWriter) {
  const repository = new PostgresChangeSetRepository(database.db);
  const writer = new ScriptedWriter();
  const batchSize = 2;
  const failureThreshold = 0.5;
  const executor = new InMemoryExecutor({
    repository,
    writer,
    ...(rollbackWriter === undefined ? {} : { rollbackWriter }),
    batchSizeOf: () => batchSize,
    failureThreshold,
  });
  const prepared = async (
    items: number,
    opts: { expiresAt?: Date; requester?: string } = {},
  ): Promise<ChangeSetRecord> => {
    const id = randomUUID();
    const now = new Date();
    await repository.create(
      {
        id,
        operation: 'catalog.update',
        connection: 'shop',
        requester: opts.requester ?? 'alice',
        args: {},
        configHash: 'cfg',
        correlationId: 'corr-prep',
        createdAt: now,
        expiresAt: opts.expiresAt ?? new Date(now.getTime() + 86_400_000),
      },
      event(id),
    );
    await repository.appendItems(
      id,
      Array.from({ length: items }, (_, i) => ({
        targetId: `t-${String(i + 1).padStart(4, '0')}`,
        status: 'pending' as const,
        before: { v: 1 },
        after: { v: 2 },
      })),
    );
    const stats = { ...EMPTY_STATS, ...(await repository.stats(id)) };
    const record = await repository.completePreparation(
      id,
      { status: 'prepared', hashVersion: 1, hash: EXECUTOR_CONTRACT_HASH, stats, preparedAt: now },
      event(id, { from: 'preparing', to: 'prepared' }),
    );
    if (record === undefined) throw new Error('preparation failed');
    return record;
  };
  return { executor, repository, writer, batchSize, failureThreshold, prepared, auditEvents: allAuditEvents };
}

// One database for the whole suite (the audit table is append-only); every case uses fresh UUIDs.
describeExecutorContract('postgres', () => Promise.resolve(harness()));

describeRollbackRun('postgres', () => {
  const rollbackWriter = new ScriptedWriter();
  return Promise.resolve({ ...harness(rollbackWriter), rollbackWriter });
});
