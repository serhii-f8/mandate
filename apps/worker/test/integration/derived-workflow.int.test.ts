/**
 * A workflow started for a derived, already prepared change-set (CS-5, design §3): the unchanged
 * `changesetWorkflow` parks in `prepared`, executes on start and writes only the included items.
 */
import { randomUUID } from 'node:crypto';
import { deriveChangeSet, type ReadPage, type UpstreamReader } from '@aiops/core';
import { ScriptedWriter } from '@aiops/testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { changesetWorkflow } from '../../src/workflows/changeset.js';
import { EDITOR_GROUP } from '../support/configuration.js';
import { startInfrastructure, startTestWorker, type Infra } from '../support/harness.js';
import { preparedByWorkflow, statusOf, waitForWorkflowStatus } from '../support/prepared-by-workflow.js';

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

const handleOf = (id: string) => infra.client.workflow.getHandle<typeof changesetWorkflow>(id);

describe('changesetWorkflow derived change-sets', () => {
  it('EXE-1 CS-5 a workflow started for a derived, already prepared change-set waits, executes on start and writes only included items', async () => {
    const writer = new ScriptedWriter();
    const worker = await startTestWorker(infra, { reader: catalogReader, writer });
    try {
      const source = await preparedByWorkflow(infra, worker, ['t-0001', 't-0002', 't-0003']);
      if (source.hash === undefined) throw new Error('source change-set has no hash');
      const derivation = await deriveChangeSet(
        { repository: infra.repository, newId: randomUUID, now: () => new Date() },
        {
          sourceId: source.id,
          hash: source.hash,
          exclude: ['t-0002'],
          include: [],
          caller: { subject: 'alice', groups: [EDITOR_GROUP] },
          correlationId: 'corr-derive',
          excludable: () => true,
        },
      );
      if (!derivation.ok) throw new Error(`derivation refused: ${derivation.reason}`);
      const derived = derivation.changeset;
      if (derived.hash === undefined) throw new Error('derived change-set has no hash');

      await worker.starter.start(derived.id);
      await waitForWorkflowStatus(infra, derived.id, 'prepared');
      expect((await handleOf(derived.id).describe()).status.name).toBe('RUNNING');
      expect(writer.batches.flat()).toEqual([]);

      const started = await worker.executor.start({
        changesetId: derived.id,
        expectedHash: derived.hash,
        actor: 'alice',
        groups: [EDITOR_GROUP],
        correlationId: 'corr-exec',
      });
      expect(started).toEqual({ ok: true });
      await expect(handleOf(derived.id).result()).resolves.toEqual({ status: 'completed' });
      expect(writer.batches.flat()).toEqual(['t-0001', 't-0003']);

      // The source is untouched and still waiting.
      expect(await statusOf(infra, source.id)).toBe('prepared');
      await worker.executor.cancel({ changesetId: source.id, actor: 'alice', correlationId: 'corr-cleanup' });
      await expect(handleOf(source.id).result()).resolves.toEqual({ status: 'cancelled' });
    } finally {
      await worker.stop();
    }
  });
});
