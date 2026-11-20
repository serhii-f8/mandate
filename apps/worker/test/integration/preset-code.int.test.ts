/**
 * Preset code and per-record writes end to end (design phase 9 §4, §6; OPS-5, OPS-6, EXE-4,
 * NFR-2): a real `changesetWorkflow` on Temporal and PostgreSQL prepares and executes change-sets
 * of the code fixture preset against `installFakeItems`, through the production `createWriterFor`,
 * `createRollbackWriterFor` and `createUpstreamReader` over `createAdapters()`.
 */
import { randomUUID } from 'node:crypto';
import { createAdapters, createOpenApiAdapter } from '@aiops/adapters';
import type { LoadedConfiguration } from '@aiops/config';
import type { ReadAdapter, WriteAdapter } from '@aiops/connector-sdk';
import { createChangeSet, ManifestBatchWriter, ROLLBACK_REQUEST_MARGIN_MS, UnsupportedWriter, type ChangeItemRecord } from '@aiops/core';
import { installFakeItems, startFakeUpstream, type FakeItem, type FakeItems, type FakeUpstream } from '@aiops/testing';
import { createUpstreamReader } from '@aiops/upstream';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { executionSettings } from '../../src/activities/settings.js';
import { createRollbackWriterFor, createWriterFor } from '../../src/writers.js';
import { CODE_FIXTURE_GROUP, codeFixtureVault, loadCodeFixture } from '../support/code-fixture.js';
import { startInfrastructure, startTestWorker, type Infra, type TestWorker } from '../support/harness.js';
import type { MemoryVault } from '../support/magento.js';

const FAKE_TOKEN = 'preset-code-test-only-token';

const SEED: readonly FakeItem[] = [
  { id: '1', title: 'Item 1', state: 'open', tags: ['red'] },
  { id: '2', title: 'Item 2', state: 'open', tags: ['green'] },
  { id: '3', title: 'Item 3', state: 'open', tags: [] },
  { id: '4', title: 'Item 4', state: 'closed', tags: ['blue'] },
];

/**
 * A per-record write on connection `items` whose rollback is the inverse operation
 * `items.restore_titles`, a per-record write that POSTs each record (`{ id, title }`) to
 * `/items/restore` (served by this file's route). Load requires every non-MCP write to carry a
 * manifest (manifest.ts check 1), so the inverse has one; the rollback still takes its records from
 * the original's manifest and only the inverse's binding (ruling on T11 I1).
 */
const INVERSE_OPERATIONS = `version: 1
operations:
  - id: items.retitle
    connection: items
    risk: write
    description: Change the title of items by ID.
    input_schema:
      type: object
      properties:
        ids: { type: array, minItems: 1, items: { type: string, minLength: 1, maxLength: 64 } }
        changes: { type: object, properties: { title: { type: string, minLength: 1 } }, required: [title], additionalProperties: false }
      required: [ids, changes]
      additionalProperties: false
    upstream:
      method: PATCH
      path: /items/{id}
      path_params: { id: { record: id } }
    manifest:
      id_field: id
      ids_arg: ids
      values_arg: changes
      fields: [title]
      read_before: { operation: fixture.get_many, ids_arg: ids, args: {} }
      rollback: { strategy: inverse_operation, operation: items.restore_titles }
  - id: items.restore_titles
    connection: items
    risk: write
    description: Put back the titles of items.
    input_schema:
      type: object
      properties:
        ids: { type: array, minItems: 1, items: { type: string, minLength: 1, maxLength: 64 } }
        changes: { type: object, properties: { title: { type: string, minLength: 1 } }, required: [title], additionalProperties: false }
      required: [ids, changes]
      additionalProperties: false
    upstream: { method: POST, path: /items/restore }
    manifest:
      id_field: id
      ids_arg: ids
      values_arg: changes
      fields: [title]
      read_before: { operation: fixture.get_many, ids_arg: ids, args: {} }
      rollback: { strategy: none }
`;

let infra: Infra;

beforeAll(async () => {
  infra = await startInfrastructure();
});

afterAll(async () => {
  await infra.close();
});

const statusOf = async (id: string) => (await infra.repository.get(id))?.status;

async function itemsOf(changesetId: string): Promise<readonly ChangeItemRecord[]> {
  return infra.repository.itemsPage(changesetId, { limit: 500 });
}

async function itemOutcomes(changesetId: string): Promise<Record<string, [string, string | undefined]>> {
  return Object.fromEntries((await itemsOf(changesetId)).map((i) => [i.targetId, [i.status, i.error]]));
}

describe('OPS-5 OPS-6 preset code and per-record writes through changesetWorkflow', () => {
  let up: FakeUpstream;
  let fake: FakeItems;
  let configuration: LoadedConfiguration;
  let vault: MemoryVault;
  let worker: TestWorker;
  /** The rollback window the next execution opens (EXE-8); 0 lets `settled` see the workflow close. */
  let windowHours: number;

  beforeEach(async () => {
    windowHours = 0;
    up = await startFakeUpstream();
    fake = installFakeItems(up, SEED);
    const adapter = createAdapters();
    // POST /items/restore puts back the title of the one item in its body (the inverse operation).
    up.route('POST', '/items/restore', (req) => {
      const body = JSON.parse(req.body) as { id?: unknown; title?: unknown };
      const item = typeof body.id === 'string' ? fake.items.get(body.id) : undefined;
      if (item === undefined || typeof body.title !== 'string') return { status: 400, body: { error: 'bad restore' } };
      item.title = body.title;
      return { status: 200, body: {} };
    });
    configuration = await loadCodeFixture(up.url, {
      maxConcurrency: 1,
      resolver: adapter.resolver,
      extra: [{ file: 'operations.yaml', text: INVERSE_OPERATIONS }],
      grants: ['items.retitle'],
    });
    vault = await codeFixtureVault(FAKE_TOKEN);
    worker = await startTestWorker(infra, {
      configuration,
      writerFor: createWriterFor({ vault, adapter }),
      rollbackWriterFor: createRollbackWriterFor({ vault, adapter }),
      readerFor: (current, correlationId) => createUpstreamReader({ configuration: current, vault, adapter, correlationId }),
      // The production settings (batch size from the manifest, 1 for the opaque call), with the window of this test.
      settingsFor: (current, operationId) => ({ ...executionSettings(current, operationId), rollbackWindowHours: windowHours }),
    });
  });

  afterEach(async () => {
    await worker.stop();
    await up.close();
  });

  /** Creates the change-set as the api does and lets its workflow prepare it. */
  async function prepared(operationId: string, args: Readonly<Record<string, unknown>>): Promise<{ id: string; hash: string }> {
    const operation = configuration.policy.operations.find((o) => o.id === operationId);
    if (operation === undefined) throw new Error(`fixture operation ${operationId} missing`);
    const created = await createChangeSet(
      { repository: infra.repository, newId: randomUUID, now: () => new Date() },
      {
        operation,
        args,
        caller: { subject: 'alice', groups: [CODE_FIXTURE_GROUP] },
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

  async function startExecution(cs: { id: string; hash: string }): Promise<void> {
    expect(
      await worker.executor.start({
        changesetId: cs.id,
        expectedHash: cs.hash,
        actor: 'alice',
        groups: [CODE_FIXTURE_GROUP],
        correlationId: `corr-exec-${randomUUID()}`,
      }),
    ).toEqual({ ok: true });
  }

  async function execute(cs: { id: string; hash: string }): Promise<void> {
    await startExecution(cs);
    await worker.executor.settled(cs.id);
  }

  /** Executes with a rollback window open (EXE-8) and waits until execution has completed. */
  async function executeWithWindow(cs: { id: string; hash: string }): Promise<void> {
    await startExecution(cs);
    await expect
      .poll(async () => {
        const record = await infra.repository.get(cs.id);
        return [record?.status, record?.rollbackUntil !== undefined];
      }, { timeout: 30_000 })
      .toEqual(['completed', true]);
  }

  /** Requests the rollback as the executor does and waits for the workflow to close rolled back. */
  async function rollBack(changesetId: string): Promise<void> {
    const requested = await infra.repository.requestRollback({
      changesetId,
      request: { actor: 'alice', correlationId: `corr-rollback-${randomUUID()}`, requestedAt: new Date() },
      marginMs: ROLLBACK_REQUEST_MARGIN_MS,
      audit: [],
    });
    expect(requested.ok).toBe(true);
    await worker.executor.wake(changesetId);
    await expect(infra.client.workflow.getHandle(changesetId).result()).resolves.toEqual({ status: 'rolled_back' });
  }

  it('OPS-6 EXE-4 NFR-2 a per-record write retried after a 503 reports already_applied for the first record and writes the rest once', async () => {
    const cs = await prepared('fixture.update', { ids: ['1', '2', '3'], changes: { title: 'Renamed' } });
    fake.failNext('PATCH', '/items/2', 503);

    await execute(cs);

    // Attempt 1 wrote item 1, got 503 for item 2 and started nothing after it (ruling F10); attempt 2
    // re-read, found item 1 written and sent items 2 and 3 once each.
    expect(fake.requestsTo('PATCH', '/items/1')).toBe(1);
    expect(fake.requestsTo('PATCH', '/items/2')).toBe(2);
    expect(fake.requestsTo('PATCH', '/items/3')).toBe(1);
    expect(await itemOutcomes(cs.id)).toEqual({
      '1': ['written', 'already_applied'],
      '2': ['written', undefined],
      '3': ['written', undefined],
    });
    expect(await statusOf(cs.id)).toBe('completed');
    expect(['1', '2', '3'].map((id) => fake.items.get(id)?.title)).toEqual(['Renamed', 'Renamed', 'Renamed']);
    expect(fake.items.get('4')?.title).toBe('Item 4');
    // The bearer token reached the upstream on every call.
    expect(up.requests.every((r) => r.headers.authorization === `Bearer ${FAKE_TOKEN}`)).toBe(true);
  });

  it('OPS-5 OPS-3 a code write executes and rolls back through the workflow', async () => {
    windowHours = 1;
    const cs = await prepared('fixture.set_tags', { ids: ['1', '2', '3'], changes: { tags: ['new', 'shiny'] } });
    await executeWithWindow(cs);
    expect(await itemOutcomes(cs.id)).toEqual({ '1': ['written', undefined], '2': ['written', undefined], '3': ['written', undefined] });
    expect(['1', '2', '3'].map((id) => fake.items.get(id)?.tags)).toEqual([['new', 'shiny'], ['new', 'shiny'], ['new', 'shiny']]);

    // EXE-8: the rollback replays the before values through the same code operation.
    await rollBack(cs.id);
    expect(['1', '2', '3'].map((id) => fake.items.get(id)?.tags)).toEqual([['red'], ['green'], []]);
    expect((await itemsOf(cs.id)).map((i) => i.rollbackStatus)).toEqual(['restored', 'restored', 'restored']);
    expect(fake.requestsTo('PUT', '/items/1/tags')).toBe(2);

    // Ruling F9: a change-set applies one `changes` to every item, so the refused tag is a second change-set.
    windowHours = 0;
    const refused = await prepared('fixture.set_tags', { ids: ['1'], changes: { tags: ['unknown'] } });
    await execute(refused);
    expect(await itemOutcomes(refused.id)).toEqual({ '1': ['failed', 'upstream_failed'] });
    expect(await statusOf(refused.id)).toBe('failed');
    expect(fake.items.get('1')?.tags).toEqual(['red']);
  }, 60_000);

  it('OPS-6 OPS-3 EXE-8 a per-record write rolls back through its own binding', async () => {
    windowHours = 1;
    const cs = await prepared('fixture.update', { ids: ['1', '2'], changes: { title: 'Renamed' } });
    await executeWithWindow(cs);
    expect(['1', '2'].map((id) => fake.items.get(id)?.title)).toEqual(['Renamed', 'Renamed']);

    await rollBack(cs.id);

    expect(['1', '2', '3'].map((id) => fake.items.get(id)?.title)).toEqual(['Item 1', 'Item 2', 'Item 3']);
    expect((await itemsOf(cs.id)).map((i) => [i.targetId, i.rollbackStatus])).toEqual([
      ['1', 'restored'],
      ['2', 'restored'],
    ]);
    // One PATCH per item forward and one back (replay_previous_state).
    expect([fake.requestsTo('PATCH', '/items/1'), fake.requestsTo('PATCH', '/items/2')]).toEqual([2, 2]);
  }, 60_000);

  it('OPS-3 EXE-8 an inverse_operation rollback of a per-record write sends through the inverse binding', async () => {
    windowHours = 1;
    const cs = await prepared('items.retitle', { ids: ['1', '2'], changes: { title: 'Renamed' } });
    await executeWithWindow(cs);
    expect(['1', '2'].map((id) => fake.items.get(id)?.title)).toEqual(['Renamed', 'Renamed']);

    await rollBack(cs.id);

    // The original's manifest gave the records; the inverse's binding sent one POST per record.
    expect(['1', '2'].map((id) => fake.items.get(id)?.title)).toEqual(['Item 1', 'Item 2']);
    const restores = up.requests.filter((r) => r.method === 'POST' && r.path === '/items/restore').map((r) => JSON.parse(r.body) as unknown);
    expect(restores).toEqual([
      { id: '1', title: 'Item 1' },
      { id: '2', title: 'Item 2' },
    ]);
    expect((await itemsOf(cs.id)).map((i) => [i.targetId, i.rollbackStatus])).toEqual([
      ['1', 'restored'],
      ['2', 'restored'],
    ]);
  }, 60_000);

  it('OPS-5 OPS-4 a selector through the HTTP search and a code read_before prepare the change-set', async () => {
    const cs = await prepared('fixture.update', { state: 'open', changes: { title: 'Renamed' } });

    // The selector paged GET /items?state=open (a bare array, `items: '$'`).
    const searches = up.requests.filter((r) => r.method === 'GET' && r.path === '/items');
    expect(searches.length).toBeGreaterThanOrEqual(1);
    expect(searches.every((r) => r.query.get('state') === 'open')).toBe(true);
    // The before values came from the code read get_many: one GET /items/{id} per selected item.
    expect(['1', '2', '3', '4'].map((id) => fake.requestsTo('GET', `/items/${id}`))).toEqual([1, 1, 1, 0]);
    const items = await itemsOf(cs.id);
    expect(items.map((i) => [i.targetId, i.status, i.before, i.after])).toEqual([
      ['1', 'pending', { title: 'Item 1' }, { title: 'Renamed' }],
      ['2', 'pending', { title: 'Item 2' }, { title: 'Renamed' }],
      ['3', 'pending', { title: 'Item 3' }, { title: 'Renamed' }],
    ]);
    // Preparation wrote nothing.
    expect(up.requests.every((r) => r.method === 'GET')).toBe(true);
  });

  it('OPS-5 EXE-4 a write_opaque code call is sent exactly once', async () => {
    const cs = await prepared('fixture.ping', { message: 'hello' });
    expect(up.requests).toEqual([]);

    await execute(cs);

    expect(fake.requestsTo('POST', '/ping')).toBe(1);
    expect(up.requests).toHaveLength(1);
    expect(JSON.parse(up.requests[0]?.body ?? 'null')).toEqual({ message: 'hello' });
    expect((await itemsOf(cs.id)).map((i) => [i.targetId, i.status, i.error])).toEqual([['call', 'written', undefined]]);
    expect(await statusOf(cs.id)).toBe('completed');
  });

  it('OPS-6 a write binding without bulk no longer fails with write_mode_unsupported', () => {
    const adapter = createAdapters();
    const writerFor = createWriterFor({ vault, adapter });
    const rollbackWriterFor = createRollbackWriterFor({ vault, adapter });
    // Per-record (HTTP PATCH without bulk) and code bindings get a manifest writer both ways.
    for (const operationId of ['fixture.update', 'fixture.set_tags']) {
      expect(writerFor(configuration, operationId)).toBeInstanceOf(ManifestBatchWriter);
      expect(rollbackWriterFor(configuration, operationId)).toBeInstanceOf(ManifestBatchWriter);
    }
    // T11 I1: an inverse operation without a manifest of its own still gets a rollback writer; the
    // records come from the original's manifest (the bulk path never required one either).
    const operations = configuration.policy.operations.map((op) => {
      if (op.id !== 'items.restore_titles') return op;
      const rest = { ...op };
      delete rest.manifest;
      return rest;
    });
    const bareInverse: LoadedConfiguration = { ...configuration, policy: { ...configuration.policy, operations } };
    expect(rollbackWriterFor(bareInverse, 'items.retitle')).toBeInstanceOf(ManifestBatchWriter);
    // The OpenAPI adapter alone also writes per record and runs code.
    expect(createWriterFor({ vault, adapter: createOpenApiAdapter() })(configuration, 'fixture.update')).toBeInstanceOf(ManifestBatchWriter);
    // Fail closed (ruling F14): an adapter that cannot write per record or run code gets UnsupportedWriter.
    const bulkOnly: ReadAdapter & WriteAdapter = {
      read: (input) => adapter.read(input),
      detectScopes: (input) => adapter.detectScopes(input),
      submitBulk: (input) => adapter.submitBulk(input),
      bulkStatus: (input) => adapter.bulkStatus(input),
      callOnce: (input) => adapter.callOnce(input),
    };
    for (const operationId of ['fixture.update', 'fixture.set_tags']) {
      expect(createWriterFor({ vault, adapter: bulkOnly })(configuration, operationId)).toBeInstanceOf(UnsupportedWriter);
      expect(createRollbackWriterFor({ vault, adapter: bulkOnly })(configuration, operationId)).toBeUndefined();
    }
    expect(up.requests).toEqual([]);
  });
});
