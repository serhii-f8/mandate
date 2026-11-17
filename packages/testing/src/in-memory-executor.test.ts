import { randomUUID } from 'node:crypto';
import { EMPTY_STATS, type ChangeSetRecord } from '@aiops/core';
import { describeExecutorContract, EXECUTOR_CONTRACT_HASH } from './executor-contract.js';
import { InMemoryAuditLog } from './in-memory-audit-log.js';
import { InMemoryChangeSetRepository } from './in-memory-changeset-repository.js';
import { InMemoryExecutor, ScriptedWriter } from './in-memory-executor.js';

describeExecutorContract('in-memory', () => {
  const audit = new InMemoryAuditLog();
  const repository = new InMemoryChangeSetRepository(audit);
  const writer = new ScriptedWriter();
  const batchSize = 2;
  const executor = new InMemoryExecutor({ repository, writer, batchSizeOf: () => batchSize });
  const prepared = async (items: number, opts: { expiresAt?: Date } = {}): Promise<ChangeSetRecord> => {
    const id = randomUUID();
    const now = new Date();
    await repository.create(
      {
        id,
        operation: 'catalog.update',
        connection: 'shop',
        requester: 'alice',
        args: {},
        configHash: 'cfg',
        correlationId: 'corr-prep',
        createdAt: now,
        expiresAt: opts.expiresAt ?? new Date(now.getTime() + 86_400_000),
      },
      { id: randomUUID(), actor: 'alice', action: 'changeset.transition', outcome: 'ok', correlationId: 'corr-prep', changesetId: id, details: {} },
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
      { id: randomUUID(), actor: 'system', action: 'changeset.transition', outcome: 'ok', correlationId: 'corr-prep', changesetId: id, details: { from: 'preparing', to: 'prepared' } },
    );
    if (record === undefined) throw new Error('preparation failed');
    return record;
  };
  return Promise.resolve({
    executor,
    repository,
    writer,
    batchSize,
    prepared,
    auditEvents: () => Promise.resolve([...audit.events]),
  });
});
