import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createOpenApiAdapter } from '@aiops/adapters';
import { loadConfigurationSources, type LoadedConfiguration } from '@aiops/config';
import {
  EMPTY_STATS,
  ManifestBatchWriter,
  UnsupportedWriter,
  type BatchContext,
  type BatchSubmission,
  type ChangeItemRecord,
  type ChangeSetRecord,
  type Clock,
  type CredentialHandle,
  type CredentialStatus,
  type CredentialVault,
} from '@aiops/core';
import { installFakeMagentoCatalog, startFakeUpstream, type FakeMagentoCatalog, type FakeUpstream } from '@aiops/testing';
import type { UpstreamCallLog } from '@aiops/upstream';
import { createWriterFor } from './writers.js';

const BASE_PATH = '/rest/all';
const FAKE_TOKEN = 'writers-test-only-token';

/** The preset's 0.3.0 bulk block (design part 2 §6), inline until the preset bump (Task 10). */
function configText(baseUrl: string): string {
  return `version: 1
connections:
  - id: magento
    adapter: openapi
    base_url: ${baseUrl}
    credential_ref: magento-token
    auth: { scheme: bearer }
    allow_private_network: true
operations:
  - id: catalog.get_products_by_sku
    connection: magento
    risk: read
    description: Products by SKU.
    input_schema:
      type: object
      properties:
        brand: { type: string }
        skus: { type: array, items: { type: string } }
        fields: { type: array, items: { type: string } }
      required: [brand, skus, fields]
      additionalProperties: false
    fields_arg: fields
    upstream:
      method: GET
      path: /V1/products
      query:
        searchCriteria[filter_groups][0][filters][0][field]: brand
        searchCriteria[filter_groups][0][filters][0][value]: { arg: brand }
        searchCriteria[filter_groups][0][filters][0][condition_type]: eq
        searchCriteria[filter_groups][1][filters][0][field]: sku
        searchCriteria[filter_groups][1][filters][0][value]: { arg: skus, join: ',' }
        searchCriteria[filter_groups][1][filters][0][condition_type]: in
        searchCriteria[pageSize]: 100
      response:
        items: items
        total: total_count
        flatten: { path: custom_attributes, key: attribute_code, value: value }
        fields_from_arg: fields
        max_items: 100
  - id: catalog.update_content
    connection: magento
    risk: write
    description: Update product content.
    input_schema: &write_schema
      type: object
      properties:
        brand: { type: string }
        skus: { type: array, items: { type: string } }
        changes: { type: object, properties: { name: { type: string }, description: { type: string } }, additionalProperties: false }
      required: [brand, changes]
      additionalProperties: false
    upstream:
      method: POST
      path: /async/bulk/V1/products
      bulk:
        body:
          wrap: product
          nest: { path: custom_attributes, key: attribute_code, value: value, keep: [sku, name, status] }
        batch_id: bulk_uuid
        status:
          method: GET
          path: /V1/bulk/{batch_id}/detailed-status
          items: operations_list
          index: id
          state: status
          states: { ok: [1], retriable: [2], failed: [3, 5], open: [4] }
    manifest: &manifest
      id_field: sku
      ids_arg: skus
      values_arg: changes
      fields: [name, description]
      scope_args: { brand: brand }
      read_before:
        operation: catalog.get_products_by_sku
        ids_arg: skus
        args: { brand: { arg: brand } }
      write: { carry_fields: [status] }
      batch_size: 100
      rollback: { strategy: replay_previous_state }
  - id: catalog.update_content_plain
    connection: magento
    risk: write
    description: Update product content without a bulk binding.
    input_schema: *write_schema
    upstream: { method: POST, path: /V1/products }
    manifest: *manifest
`;
}

async function loadConfig(baseUrl: string): Promise<LoadedConfiguration> {
  const result = await loadConfigurationSources([{ file: 'config.yaml', text: configText(baseUrl) }]);
  if (!result.ok) throw new Error(`configuration did not load: ${JSON.stringify(result.issues)}`);
  return result.configuration;
}

class MemoryVault implements CredentialVault {
  readonly rows = new Map<string, { scheme: string; secret: Readonly<Record<string, string>> }>();
  put(input: { ref: string; scheme: string; secret: Readonly<Record<string, string>>; actor: string }): Promise<{ keyVersion: number }> {
    this.rows.set(input.ref, { scheme: input.scheme, secret: input.secret });
    return Promise.resolve({ keyVersion: 1 });
  }
  describe(refs: readonly string[]): Promise<CredentialStatus[]> {
    return Promise.resolve(refs.map((ref) => ({ ref, set: this.rows.has(ref) })));
  }
  handle(ref: string): Promise<CredentialHandle | undefined> {
    const row = this.rows.get(ref);
    if (row === undefined) return Promise.resolve(undefined);
    return Promise.resolve({ ref, scheme: row.scheme, open: () => Promise.resolve(row.secret) });
  }
}

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
      basePath: BASE_PATH,
      products: [
        { sku: 'A', name: 'Alpha', status: 2, brand: 'acme', description: 'old A' },
        { sku: 'B', name: 'Beta', status: 1, brand: 'acme', description: 'old B' },
      ],
    });
    configuration = await loadConfig(`${up.url}${BASE_PATH}`);
    vault = new MemoryVault();
    await vault.put({ ref: 'magento-token', scheme: 'bearer', secret: { token: FAKE_TOKEN }, actor: 'test' });
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
