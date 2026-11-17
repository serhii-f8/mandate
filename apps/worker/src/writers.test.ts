import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createOpenApiAdapter } from '@aiops/adapters';
import type { LoadedConfiguration } from '@aiops/config';
import {
  EMPTY_STATS,
  ManifestBatchWriter,
  UnsupportedWriter,
  type BatchContext,
  type BatchSubmission,
  type ChangeItemRecord,
  type ChangeSetRecord,
  type Clock,
} from '@aiops/core';
import { installFakeMagentoCatalog, startFakeUpstream, type FakeMagentoCatalog, type FakeUpstream } from '@aiops/testing';
import { createBulkWriter, createUpstreamReader, type UpstreamCallLog } from '@aiops/upstream';
import { loadMagentoPreset, MAGENTO_BASE_PATH, MemoryVault, vaultWithToken } from '../test/support/magento.js';
import { createWriterFor } from './writers.js';

const FAKE_TOKEN = 'writers-test-only-token';

/** An operation without a bulk binding on the preset's connection, next to the preset's own. */
const PLAIN_OPERATION = `version: 1
operations:
  - id: catalog.update_content_plain
    connection: magento
    risk: write
    description: Update product content without a bulk binding.
    input_schema:
      type: object
      properties:
        brand: { type: string }
        skus: { type: array, items: { type: string } }
        changes: { type: object, properties: { description: { type: string } }, additionalProperties: false }
      required: [brand, changes]
      additionalProperties: false
    upstream: { method: POST, path: /V1/products }
    manifest:
      id_field: sku
      ids_arg: skus
      values_arg: changes
      fields: [description]
      scope_args: { brand: brand }
      read_before:
        operation: catalog.get_products_by_sku
        ids_arg: skus
        args: { brand: { arg: brand } }
      batch_size: 100
      rollback: { strategy: replay_previous_state }
`;

/** Advances virtual time instead of sleeping. */
class FakeClock implements Clock {
  private t = 0;
  now(): number {
    return this.t;
  }
  sleep(ms: number): Promise<void> {
    this.t += ms;
    return Promise.resolve();
  }
}

class FakeBatch implements BatchContext {
  readonly key = 'cs-1:1';
  readonly recorded: BatchSubmission[] = [];
  /** Status polls the upstream had seen when the submission was recorded. */
  readonly pollsAtRecord: number[] = [];
  heartbeats = 0;
  submission?: BatchSubmission;
  constructor(
    private readonly polls: () => number,
    submission?: BatchSubmission,
    private readonly failRecord = false,
  ) {
    if (submission !== undefined) this.submission = submission;
  }
  recordSubmission(s: BatchSubmission): Promise<void> {
    this.recorded.push(s);
    this.pollsAtRecord.push(this.polls());
    if (this.failRecord) return Promise.reject(new Error('worker lost after recording'));
    this.submission = s;
    return Promise.resolve();
  }
  heartbeat(): void {
    this.heartbeats++;
  }
}

const ARGS = { brand: 'acme', skus: ['A', 'B'], changes: { description: 'new text' } };

function changesetFor(operation: string): ChangeSetRecord {
  return {
    id: 'cs-1',
    operation,
    connection: 'magento',
    requester: 'alice',
    args: ARGS,
    hash: 'h',
    status: 'executing',
    stats: EMPTY_STATS,
    configHash: 'c',
    correlationId: 'corr-cs-1',
    createdAt: new Date(0),
    expiresAt: new Date(86_400_000),
  };
}

const ITEMS: readonly ChangeItemRecord[] = [
  { targetId: 'A', status: 'pending', before: { description: 'old A' }, after: { description: 'new text' } },
  { targetId: 'B', status: 'pending', before: { description: 'old B' }, after: { description: 'new text' } },
];

describe('EXE-4 OPS-6 worker writerFor', () => {
  let up: FakeUpstream;
  let catalog: FakeMagentoCatalog;
  let configuration: LoadedConfiguration;
  let vault: MemoryVault;
  let lines: UpstreamCallLog[];

  beforeEach(async () => {
    up = await startFakeUpstream();
    catalog = installFakeMagentoCatalog(up, {
      basePath: MAGENTO_BASE_PATH,
      products: [
        { sku: 'A', name: 'Alpha', status: 2, brand: 'acme', description: 'old A' },
        { sku: 'B', name: 'Beta', status: 1, brand: 'acme', description: 'old B' },
      ],
    });
    configuration = await loadMagentoPreset(`${up.url}${MAGENTO_BASE_PATH}`, [{ file: 'operations.yaml', text: PLAIN_OPERATION }]);
    vault = await vaultWithToken(FAKE_TOKEN);
    lines = [];
  });
  afterEach(async () => {
    await up.close();
  });

  const writerFor = () =>
    createWriterFor({ vault, adapter: createOpenApiAdapter(), clock: new FakeClock(), log: (l) => lines.push(l) });
  const statusPolls = (): number => up.requests.filter((r) => r.method === 'GET' && r.path.endsWith('/detailed-status')).length;

  it('OPS-6 writerFor returns UnsupportedWriter without a bulk binding: every item failed/write_mode_unsupported', async () => {
    const writer = writerFor()(configuration, 'catalog.update_content_plain');
    expect(writer).toBeInstanceOf(UnsupportedWriter);
    expect(writerFor()(configuration, 'catalog.get_products_by_sku')).toBeInstanceOf(UnsupportedWriter);
    expect(writerFor()(configuration, 'catalog.unknown')).toBeInstanceOf(UnsupportedWriter);
    const outcomes = await writer.writeBatch({
      changeset: changesetFor('catalog.update_content_plain'),
      items: ITEMS,
      batch: new FakeBatch(statusPolls),
    });
    expect(outcomes).toEqual([
      { targetId: 'A', status: 'failed', error: 'write_mode_unsupported' },
      { targetId: 'B', status: 'failed', error: 'write_mode_unsupported' },
    ]);
    expect(up.requests).toEqual([]);
  });

  it('EXE-4 CS-7 writerFor writes a batch against the fake catalog: carry status kept, drift skipped, record before poll', async () => {
    catalog.set('B', { description: 'edited after preparation' });
    const writer = writerFor()(configuration, 'catalog.update_content');
    expect(writer).toBeInstanceOf(ManifestBatchWriter);
    const batch = new FakeBatch(statusPolls);

    const outcomes = await writer.writeBatch({ changeset: changesetFor('catalog.update_content'), items: ITEMS, batch });

    expect(catalog.submissions).toHaveLength(1);
    expect(catalog.submissions[0]?.skus).toEqual(['A']);
    expect(catalog.product('A')).toMatchObject({ description: 'new text', status: 2 });
    expect(catalog.product('B')).toMatchObject({ description: 'edited after preparation' });
    expect(batch.recorded).toHaveLength(1);
    expect(batch.pollsAtRecord).toEqual([0]);
    expect(statusPolls()).toBeGreaterThan(0);
    expect(outcomes).toEqual([
      { targetId: 'A', status: 'written' },
      { targetId: 'B', status: 'skipped', error: 'drift' },
    ]);
    // The bearer token reached the upstream; the log lines carry identifiers only (SEC-3).
    expect(up.requests.every((r) => r.headers.authorization === `Bearer ${FAKE_TOKEN}`)).toBe(true);
    expect(lines.length).toBeGreaterThan(0);
    expect(lines.every((l) => l.correlationId === 'corr-cs-1')).toBe(true);
    const logged = JSON.stringify(lines);
    expect(logged).not.toContain(FAKE_TOKEN);
    expect(logged).not.toContain('new text');
  });

  it('EXE-4 a submit without a stored credential (credential_missing) fails the to-write items upstream_rejected, sends no batch and is not retried', async () => {
    const operation = configuration.policy.operations.find((o) => o.id === 'catalog.update_content');
    const manifest = operation?.manifest;
    if (operation === undefined || manifest === undefined) throw new Error('preset operation missing');
    const adapter = createOpenApiAdapter();
    const readOperation = configuration.policy.operations.find((o) => o.id === manifest.readBefore.operation);
    // The read still has its credential; the bulk calls look theirs up in an empty vault.
    const writer = new ManifestBatchWriter({
      operation: { ...operation, manifest },
      readFieldsArg: readOperation?.fieldsArg,
      readerFor: (cs) => createUpstreamReader({ configuration, vault, adapter, correlationId: cs.correlationId }),
      bulkFor: (cs) => {
        const bulk = createBulkWriter({ configuration, vault: new MemoryVault(), adapter, operationId: operation.id, correlationId: cs.correlationId });
        if (bulk === undefined) throw new Error('preset operation has no bulk binding');
        return bulk;
      },
      clock: new FakeClock(),
    });
    const batch = new FakeBatch(statusPolls);

    const outcomes = await writer.writeBatch({ changeset: changesetFor('catalog.update_content'), items: ITEMS, batch });

    expect(outcomes).toEqual([
      { targetId: 'A', status: 'failed', error: 'upstream_rejected' },
      { targetId: 'B', status: 'failed', error: 'upstream_rejected' },
    ]);
    expect(catalog.submissions).toEqual([]);
    expect(batch.recorded).toEqual([]);
    expect(statusPolls()).toBe(0);
  });

  it('EXE-4 writerFor resumes a recorded submission without a second submission', async () => {
    const changeset = changesetFor('catalog.update_content');
    // First attempt: the worker is lost right after recording the submission, before any poll.
    const lost = new FakeBatch(statusPolls, undefined, true);
    await expect(writerFor()(configuration, 'catalog.update_content').writeBatch({ changeset, items: ITEMS, batch: lost })).rejects.toThrow(
      'worker lost after recording',
    );
    expect(catalog.submissions).toHaveLength(1);
    expect(statusPolls()).toBe(0);
    const submission = lost.recorded[0];
    if (submission === undefined) throw new Error('nothing was recorded');

    // The retry resumes from the recorded submission with a fresh writer.
    const resumed = new FakeBatch(statusPolls, submission);
    const outcomes = await writerFor()(configuration, 'catalog.update_content').writeBatch({ changeset, items: ITEMS, batch: resumed });

    expect(catalog.submissions).toHaveLength(1);
    expect(resumed.recorded).toEqual([]);
    expect(catalog.product('A')).toMatchObject({ description: 'new text', status: 2 });
    expect(outcomes).toEqual([
      { targetId: 'A', status: 'written' },
      { targetId: 'B', status: 'written' },
    ]);
  });
});
