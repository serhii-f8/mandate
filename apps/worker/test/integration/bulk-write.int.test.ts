/**
 * Bulk writes end to end (EXE-4, CS-7, NFR-2; design part 2): a real `changesetWorkflow` prepares
 * a change-set through the Magento preset 0.3.0 against the fake catalog, then executes it with
 * the production `createWriterFor`: one async bulk submission, recorded before the first status
 * poll, verified by a read, with drift, already applied, gone and failed items reported per item.
 * The worker runs on the real clock, so a batch takes about 2.5 s (1 s + 1.5 s polls).
 */
import { randomUUID } from 'node:crypto';
import { createOpenApiAdapter } from '@aiops/adapters';
import type { LoadedConfiguration } from '@aiops/config';
import { createChangeSet, type ChangeItemRecord } from '@aiops/core';
import { installFakeMagentoCatalog, startFakeUpstream, type FakeMagentoCatalog, type FakeUpstream } from '@aiops/testing';
import { createUpstreamReader } from '@aiops/upstream';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createWriterFor } from '../../src/writers.js';
import { startInfrastructure, startTestWorker, type Infra, type TestWorker } from '../support/harness.js';
import { loadMagentoPreset, MAGENTO_BASE_PATH, vaultWithToken, type MemoryVault } from '../support/magento.js';
import { auditEventsOf } from '../support/postgres.js';

const OPERATION = 'catalog.update_content';
const EDITOR_GROUP = 'editors';
const FAKE_TOKEN = 'bulk-write-test-only-token';
const ROLES = `version: 1
roles:
  - id: editor
    grants:
      - operation: catalog.update_content
        scope: { brand: [acme] }
    approval: { required: never }
role_mapping:
  - group: editors
    roles: [editor]
`;

const skus = (n: number): string[] => Array.from({ length: n }, (_, i) => `ACME-${String(i + 1).padStart(3, '0')}`);

let infra: Infra;

beforeAll(async () => {
  infra = await startInfrastructure();
});

afterAll(async () => {
  await infra.close();
});

interface BatchRow {
  readonly attempt: number;
  readonly state: string;
  readonly upstream_batch_id: string | null;
  readonly plan: unknown;
}

async function batchRow(changesetId: string, batchNo: number): Promise<BatchRow> {
  const result = await infra.database.pool.query<BatchRow>(
    'SELECT attempt, state, upstream_batch_id, plan FROM change_batch WHERE changeset_id = $1 AND batch_no = $2',
    [changesetId, batchNo],
  );
  const row = result.rows[0];
  if (row === undefined) throw new Error(`no batch ${String(batchNo)} for ${changesetId}`);
  return row;
}

async function itemsOf(changesetId: string): Promise<readonly ChangeItemRecord[]> {
  return infra.repository.itemsPage(changesetId, { limit: 500 });
}

async function itemOutcomes(changesetId: string): Promise<Record<string, [string, string | undefined]>> {
  return Object.fromEntries((await itemsOf(changesetId)).map((i) => [i.targetId, [i.status, i.error]]));
}

const statusOf = async (id: string) => (await infra.repository.get(id))?.status;

describe('EXE-4 CS-7 NFR-2 bulk writes through changesetWorkflow', () => {
  let up: FakeUpstream;
  let catalog: FakeMagentoCatalog;
  let configuration: LoadedConfiguration;
  let vault: MemoryVault;
  let worker: TestWorker;
  /** The change-set of the first case, inspected again by the SEC-3 case. */
  let mixedChangeset: string | undefined;

  beforeEach(async () => {
    up = await startFakeUpstream();
    catalog = installFakeMagentoCatalog(up, {
      basePath: MAGENTO_BASE_PATH,
      products: skus(6).map((sku) => ({ sku, name: `Product ${sku}`, status: sku === 'ACME-003' ? 2 : 1, brand: 'acme', description: 'old' })),
    });
    configuration = await loadMagentoPreset(`${up.url}${MAGENTO_BASE_PATH}`, [{ file: 'roles.yaml', text: ROLES }]);
    vault = await vaultWithToken(FAKE_TOKEN);
    const adapter = createOpenApiAdapter();
    worker = await startTestWorker(infra, {
      configuration,
      writerFor: createWriterFor({ vault, adapter }),
      readerFor: (current, correlationId) => createUpstreamReader({ configuration: current, vault, adapter, correlationId }),
      settings: { batchSize: 100 },
    });
  });

  afterEach(async () => {
    await worker.stop();
    await up.close();
  });

  /** Creates the change-set as the api does, lets its workflow prepare it, and returns it prepared. */
  async function prepared(targets: readonly string[]): Promise<{ id: string; hash: string }> {
    const operation = configuration.policy.operations.find((o) => o.id === OPERATION);
    const manifest = operation?.manifest;
    if (operation === undefined || manifest === undefined) throw new Error('preset operation missing');
    const created = await createChangeSet(
      { repository: infra.repository, newId: randomUUID, now: () => new Date() },
      {
        operation: { ...operation, manifest },
        args: { brand: 'acme', skus: targets, changes: { description: 'new' } },
        caller: { subject: 'alice', groups: [EDITOR_GROUP] },
        correlationId: `corr-create-${randomUUID()}`,
        configHash: configuration.hash,
        expireAfterHours: 1,
      },
    );
    if (!created.ok) throw new Error(`change-set not created: ${created.code}`);
    const { id } = created.changeset;
    await worker.starter.start(id);
    await expect.poll(() => statusOf(id), { timeout: 30_000 }).toBe('prepared');
    const record = await infra.repository.get(id);
    if (record?.hash === undefined) throw new Error('prepared change-set has no hash');
    return { id, hash: record.hash };
  }

  async function execute(cs: { id: string; hash: string }): Promise<void> {
    expect(
      await worker.executor.start({
        changesetId: cs.id,
        expectedHash: cs.hash,
        actor: 'alice',
        groups: [EDITOR_GROUP],
        correlationId: `corr-exec-${randomUUID()}`,
      }),
    ).toEqual({ ok: true });
    await worker.executor.settled(cs.id);
  }

  it('EXE-4 CS-7 NFR-2 EXE-5 a real workflow writes once, keeps status, and reports drift, already_applied, gone and upstream_failed', async () => {
    const cs = await prepared(skus(6));
    mixedChangeset = cs.id;
    expect((await itemsOf(cs.id)).map((i) => i.status)).toEqual(Array(6).fill('pending'));

    catalog.set('ACME-002', { description: 'edited elsewhere' }); // drift
    catalog.set('ACME-004', { description: 'new' }); // already applied
    catalog.set('ACME-005', { brand: 'globex' }); // out of scope now: gone
    catalog.failItems(['ACME-006']); // status 3: upstream_failed

    await execute(cs);

    expect(await statusOf(cs.id)).toBe('completed_with_errors');
    expect(await itemOutcomes(cs.id)).toEqual({
      'ACME-001': ['written', undefined],
      'ACME-002': ['skipped', 'drift'],
      'ACME-003': ['written', undefined],
      'ACME-004': ['written', 'already_applied'],
      'ACME-005': ['skipped', 'gone'],
      'ACME-006': ['failed', 'upstream_failed'],
    });
    expect(catalog.submissions).toHaveLength(1);
    expect(catalog.submissions[0]?.skus).toEqual(['ACME-001', 'ACME-003', 'ACME-006']);
    // The carried status survives the async write (ADR 0007 hazard).
    expect(catalog.product('ACME-003')).toMatchObject({ description: 'new', status: 2 });
    // A product edited after preparation is never overwritten (CS-7).
    expect(catalog.product('ACME-002')).toMatchObject({ description: 'edited elsewhere' });
    // The submission is recorded with its plan; the plan has no values.
    const row = await batchRow(cs.id, 0);
    expect(row).toMatchObject({ state: 'done', upstream_batch_id: 'fake-bulk-1' });
    expect(JSON.stringify(row.plan)).not.toContain('new');
    // The bearer token reached the upstream on every call.
    expect(up.requests.every((r) => r.headers.authorization === `Bearer ${FAKE_TOKEN}`)).toBe(true);
  });

  it('EXE-4 NFR-2 a batch whose status polls fail is retried by Temporal, resumes the recorded upstream batch and never resubmits', async () => {
    const cs = await prepared(skus(2));
    // = the connection's retry.max_attempts: the first activity attempt throws status_failed.
    catalog.failStatusRequests(3);

    await execute(cs);

    expect(catalog.submissions).toHaveLength(1);
    expect(await statusOf(cs.id)).toBe('completed');
    expect(await itemOutcomes(cs.id)).toEqual({ 'ACME-001': ['written', undefined], 'ACME-002': ['written', undefined] });
    const row = await batchRow(cs.id, 0);
    expect(row.attempt).toBeGreaterThanOrEqual(2);
    expect(row.upstream_batch_id).toBe('fake-bulk-1');
  });

  it('SEC-3 SEC-5 no upstream message text reaches items, batch rows or audit', async () => {
    if (mixedChangeset === undefined) throw new Error('the first case did not run');
    const stored = JSON.stringify({
      items: await itemsOf(mixedChangeset),
      batch: await batchRow(mixedChangeset, 0),
      audit: await auditEventsOf(infra.database, mixedChangeset),
    });
    expect(stored).toContain('upstream_failed');
    expect(stored).not.toContain('fake upstream message');
    expect(stored).not.toContain(FAKE_TOKEN);
  });
});
