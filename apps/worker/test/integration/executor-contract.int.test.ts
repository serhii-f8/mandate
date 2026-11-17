/**
 * The executor contract (EXE-11) against `TemporalExecutor`: the same cases as the in-memory
 * executor, run through `changesetWorkflow` on a real worker. The contract's change-sets carry a
 * fixed hash and no configuration, so the worker uses the allow-all guard (ADR 0027).
 */
import { randomUUID } from 'node:crypto';
import { EMPTY_STATS, type AuditEventInput, type ChangeSetRecord } from '@aiops/core';
import { allowAllGuard, describeExecutorContract, EXECUTOR_CONTRACT_HASH, ScriptedWriter } from '@aiops/testing';
import { afterAll, beforeAll } from 'vitest';
import { startInfrastructure, startTestWorker, TEST_SETTINGS, type Infra } from '../support/harness.js';

let infra: Infra;

beforeAll(async () => {
  infra = await startInfrastructure();
});

afterAll(async () => {
  await infra.close();
});

interface AuditRow {
  readonly id: string;
  readonly actor: string;
  readonly clientId: string | null;
  readonly action: AuditEventInput['action'];
  readonly subject: string | null;
  readonly outcome: AuditEventInput['outcome'];
  readonly correlationId: string;
  readonly changesetId: string | null;
  readonly details: AuditEventInput['details'];
}

async function allAuditEvents(): Promise<AuditEventInput[]> {
  const result = await infra.database.pool.query<AuditRow>(
    `SELECT id, actor, client_id AS "clientId", action, subject, outcome, correlation_id AS "correlationId",
            changeset_id AS "changesetId", details
       FROM audit_event ORDER BY seq`,
  );
  return result.rows.map((r) => ({
    id: r.id,
    actor: r.actor,
    ...(r.clientId === null ? {} : { clientId: r.clientId }),
    action: r.action,
    ...(r.subject === null ? {} : { subject: r.subject }),
    outcome: r.outcome,
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

// One database and Temporal environment for the file; one worker, task queue and writer per case.
describeExecutorContract('temporal', async () => {
  const { repository } = infra;
  const writer = new ScriptedWriter();
  const settings = { batchSize: 2, failureThreshold: 0.5, itemsPerRun: TEST_SETTINGS.itemsPerRun };
  const worker = await startTestWorker(infra, { writer, guard: allowAllGuard, settings });
  const prepared = async (items: number, opts: { expiresAt?: Date; requester?: string } = {}): Promise<ChangeSetRecord> => {
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
      { status: 'prepared', hash: EXECUTOR_CONTRACT_HASH, stats, preparedAt: now },
      event(id, { from: 'preparing', to: 'prepared' }),
    );
    if (record === undefined) throw new Error('preparation failed');
    return record;
  };
  return {
    executor: worker.executor,
    repository,
    writer,
    batchSize: settings.batchSize,
    failureThreshold: settings.failureThreshold,
    prepared,
    auditEvents: allAuditEvents,
    close: () => worker.stop(),
  };
});
