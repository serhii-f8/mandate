/**
 * `changesetWorkflow` across the approval statuses (design §7): the workflow's command sequence is
 * unchanged from Phase 5; it waits in `pending_approval` and `approved` as in `prepared`, ends on the
 * terminal statuses a decision stores, and executes once started. The replay fixtures of these paths
 * are recorded by `scripts/record-history.ts` (EXE-10).
 */
import type { ReadPage, UpstreamReader } from '@aiops/core';
import { PROGRESS_QUERY, type WorkflowProgress } from '@aiops/temporal';
import { recordApproval, ScriptedWriter } from '@aiops/testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { changesetWorkflow } from '../../src/workflows/changeset.js';
import { APPROVING_GROUP, REVIEWER_GROUP } from '../support/configuration.js';
import { startInfrastructure, startTestWorker, type Infra, type TestWorker, type TestWorkerOptions } from '../support/harness.js';
import { preparedByWorkflow, SHORT_EXPIRY_MS, submitted, waitForWorkflowStatus } from '../support/prepared-by-workflow.js';

let infra: Infra;

beforeAll(async () => {
  infra = await startInfrastructure();
});

afterAll(async () => {
  await infra.close();
});

/** Reads answer every requested SKU with brand `acme`. */
const catalogReader: UpstreamReader = {
  read(_operationId, args): Promise<ReadPage> {
    const skus = Array.isArray(args.skus) ? args.skus.filter((s): s is string => typeof s === 'string') : [];
    return Promise.resolve({ ok: true, items: skus.map((sku) => ({ sku, brand: 'acme', name: `old ${sku}` })), truncated: false });
  },
};

async function withWorker<T>(opts: TestWorkerOptions, fn: (worker: TestWorker) => Promise<T>): Promise<T> {
  const worker = await startTestWorker(infra, { reader: catalogReader, ...opts });
  try {
    return await fn(worker);
  } finally {
    await worker.stop();
  }
}

const handleOf = (id: string) => infra.client.workflow.getHandle<typeof changesetWorkflow>(id);

describe('changesetWorkflow approvals', () => {
  it('EXE-1 APR-1 a change-set in pending_approval stays parked; the progress query answers pending_approval', async () => {
    await withWorker({}, async (worker) => {
      const cs = await preparedByWorkflow(infra, worker, ['t-0001', 't-0002']);
      await submitted(infra, worker, cs);
      await waitForWorkflowStatus(infra, cs.id, 'pending_approval');
      const handle = handleOf(cs.id);
      expect((await handle.describe()).status.name).toBe('RUNNING');
      await expect(handle.query<WorkflowProgress>(PROGRESS_QUERY)).resolves.toMatchObject({ status: 'pending_approval', total: 2 });
      expect((await infra.repository.get(cs.id))?.status).toBe('pending_approval');

      await worker.executor.cancel({ changesetId: cs.id, actor: 'alice', correlationId: 'corr-cleanup' });
      await expect(handle.result()).resolves.toEqual({ status: 'cancelled' });
    });
  });

  it('APR-1 POL-6 approved, then started with the requester identity, runs to completed', async () => {
    const writer = new ScriptedWriter();
    await withWorker({ writer }, async (worker) => {
      const cs = await preparedByWorkflow(infra, worker, ['t-0001', 't-0002', 't-0003']);
      const approved = await recordApproval(infra.repository, await submitted(infra, worker, cs), { approver: 'rita' });
      expect(approved.status).toBe('approved');
      if (approved.hash === undefined) throw new Error('approved change-set has no hash');
      const started = await worker.executor.start({
        changesetId: cs.id,
        expectedHash: approved.hash,
        actor: 'rita',
        groups: [REVIEWER_GROUP],
        correlationId: 'corr-exec',
        requester: { subject: 'alice', groups: [APPROVING_GROUP] },
      });
      expect(started).toEqual({ ok: true });
      await expect(handleOf(cs.id).result()).resolves.toEqual({ status: 'completed' });
      // The execution is the requester's (POL-6): the worker's guard re-checked alice's groups.
      expect((await infra.repository.get(cs.id))?.executionRequest).toMatchObject({
        actor: 'alice',
        groups: [APPROVING_GROUP],
        correlationId: 'corr-exec',
      });
    });
    const all = writer.batches.flat();
    expect(all).toEqual(['t-0001', 't-0002', 't-0003']);
  });

  it('APR-4 rejected while pending: the wake ends the workflow with status rejected', async () => {
    await withWorker({}, async (worker) => {
      const cs = await preparedByWorkflow(infra, worker, ['t-0001']);
      const pending = await submitted(infra, worker, cs);
      await waitForWorkflowStatus(infra, cs.id, 'pending_approval');
      await recordApproval(infra.repository, pending, { approver: 'rita', decision: 'rejected' });
      await worker.executor.wake(cs.id);
      await expect(handleOf(cs.id).result()).resolves.toEqual({ status: 'rejected' });
      expect((await infra.repository.get(cs.id))?.status).toBe('rejected');
    });
  });

  it('APR-4 returned, resubmitted as round 2, then expired: the workflow ends expired', async () => {
    await withWorker({}, async (worker) => {
      const cs = await preparedByWorkflow(infra, worker, ['t-0001'], { expiresAt: new Date(Date.now() + SHORT_EXPIRY_MS) });
      const pending = await submitted(infra, worker, cs);
      await waitForWorkflowStatus(infra, cs.id, 'pending_approval');
      const returned = await recordApproval(infra.repository, pending, { approver: 'rita', decision: 'returned', comment: 'fix the name' });
      expect(returned).toMatchObject({ status: 'prepared', approvalRound: 1 });
      await worker.executor.wake(cs.id);
      await waitForWorkflowStatus(infra, cs.id, 'prepared');
      const round2 = await submitted(infra, worker, returned);
      expect(round2).toMatchObject({ status: 'pending_approval', approvalRound: 2 });
      await expect(handleOf(cs.id).result()).resolves.toEqual({ status: 'expired' });
      expect(await infra.repository.get(cs.id)).toMatchObject({ status: 'expired', approvalRound: 2 });
    });
  });

  it('CS-6 a change-set in pending_approval expires by the workflow timer', async () => {
    await withWorker({}, async (worker) => {
      const cs = await preparedByWorkflow(infra, worker, ['t-0001'], { expiresAt: new Date(Date.now() + SHORT_EXPIRY_MS) });
      await submitted(infra, worker, cs);
      await waitForWorkflowStatus(infra, cs.id, 'pending_approval');
      await expect(handleOf(cs.id).result()).resolves.toEqual({ status: 'expired' });
      expect((await infra.repository.get(cs.id))?.status).toBe('expired');
    });
  });
});
