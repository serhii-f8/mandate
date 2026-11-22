// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Mandate Authors
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createOpenApiAdapter } from '@mandate/adapters';
import { loadConfigurationSources, type LoadedConfiguration } from '@mandate/config';
import {
  mcpToolHash,
  type BulkStatusOutcome,
  type BulkSubmitOutcome,
  type CallOutcome,
  type McpToolDefinition,
  type ReadAdapter,
  type ReadOutcome,
  type ScopeReport,
  type ToolListOutcome,
  type UpstreamResolver,
  type WriteAdapter,
} from '@mandate/connector-sdk';
import {
  EMPTY_STATS,
  ManifestBatchWriter,
  OpaqueCallWriter,
  UnsupportedWriter,
  type BatchContext,
  type BatchSubmission,
  type ChangeItemRecord,
  type ChangeSetRecord,
  type Clock,
  type RollbackStrategy,
} from '@mandate/core';
import { installFakeMagentoCatalog, startFakeUpstream, type FakeMagentoCatalog, type FakeUpstream } from '@mandate/testing';
import { createBulkWriter, createUpstreamReader, type ToolLister, type UpstreamCallLog } from '@mandate/upstream';
import { loadMagentoPreset, MAGENTO_BASE_PATH, MemoryVault, vaultWithToken } from '../test/support/magento.js';
import { createRollbackWriterFor, createWriterFor } from './writers.js';

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

/** Only the read and bulk/opaque methods of `adapter`: no per-record writes, no code operations. */
function bulkOnly(adapter: ReadAdapter & WriteAdapter & Required<Pick<WriteAdapter, 'callOnce'>>): ReadAdapter & WriteAdapter {
  return {
    read: (input) => adapter.read(input),
    detectScopes: (input) => adapter.detectScopes(input),
    submitBulk: (input) => adapter.submitBulk(input),
    bulkStatus: (input) => adapter.bulkStatus(input),
    callOnce: (input) => adapter.callOnce(input),
  };
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
    approvalRound: 0,
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

  it('OPS-6 writerFor returns UnsupportedWriter without a usable write binding: every item failed/write_mode_unsupported', async () => {
    // A non-bulk HTTP write binding is a per-record write (OPS-6); an adapter that cannot write per
    // record has no writer for it and fails closed (ruling F14).
    expect(writerFor()(configuration, 'catalog.update_content_plain')).toBeInstanceOf(ManifestBatchWriter);
    const writer = createWriterFor({ vault, adapter: bulkOnly(createOpenApiAdapter()) })(configuration, 'catalog.update_content_plain');
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

  it('POL-5 a destructive operation with a manifest and bulk binding gets a ManifestBatchWriter', () => {
    const operations = configuration.policy.operations.map((o) =>
      o.id === 'catalog.update_content' ? { ...o, risk: 'destructive' as const } : o,
    );
    const destructive = { ...configuration, policy: { ...configuration.policy, operations } };
    expect(writerFor()(destructive, 'catalog.update_content')).toBeInstanceOf(ManifestBatchWriter);
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

/** The configuration with `catalog.update_content`'s rollback strategy replaced. */
function withStrategy(configuration: LoadedConfiguration, rollback: RollbackStrategy): LoadedConfiguration {
  const operations = configuration.policy.operations.map((o) =>
    o.id === 'catalog.update_content' && o.manifest !== undefined ? { ...o, manifest: { ...o.manifest, rollback } } : o,
  );
  return { ...configuration, policy: { ...configuration.policy, operations } };
}

/** Adds `catalog.restore_content`, a copy of `catalog.update_content` with its own bulk binding, as the inverse. */
function withInverse(configuration: LoadedConfiguration): LoadedConfiguration {
  const source = configuration.policy.operations.find((o) => o.id === 'catalog.update_content');
  const binding = configuration.bindings.get('catalog.update_content');
  if (source === undefined || binding === undefined) throw new Error('preset operation missing');
  const inverse = withStrategy(configuration, { strategy: 'inverse_operation', operation: 'catalog.restore_content' });
  return {
    ...inverse,
    policy: { ...inverse.policy, operations: [...inverse.policy.operations, { ...source, id: 'catalog.restore_content' }] },
    bindings: new Map([...configuration.bindings, ['catalog.restore_content', binding]]),
  };
}

const EXECUTION_REQUEST = { actor: 'alice', groups: ['editors'], correlationId: 'corr-exec', startedAt: new Date(1_000) };

/** A finished change-set whose items were written; execution and rollback each have their own correlation ID. */
function executedChangeset(): ChangeSetRecord {
  return {
    ...changesetFor('catalog.update_content'),
    status: 'rolling_back',
    executionRequest: EXECUTION_REQUEST,
    rollbackRequest: { actor: 'alice', correlationId: 'corr-rollback', requestedAt: new Date(2_000) },
  };
}

const WRITTEN: readonly ChangeItemRecord[] = ITEMS.map((i) => ({ ...i, status: 'written' }));

describe('EXE-8 OPS-3 rollbackWriterFor', () => {
  let up: FakeUpstream;
  let catalog: FakeMagentoCatalog;
  let configuration: LoadedConfiguration;
  let vault: MemoryVault;
  let lines: UpstreamCallLog[];

  beforeEach(async () => {
    up = await startFakeUpstream();
    // As execution left them: A carries the new value, B was already put back by hand.
    catalog = installFakeMagentoCatalog(up, {
      basePath: MAGENTO_BASE_PATH,
      products: [
        { sku: 'A', name: 'Alpha', status: 2, brand: 'acme', description: 'new text' },
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

  const deps = () => ({ vault, adapter: createOpenApiAdapter(), clock: new FakeClock(), log: (l: UpstreamCallLog) => lines.push(l) });
  const statusPolls = (): number => up.requests.filter((r) => r.method === 'GET' && r.path.endsWith('/detailed-status')).length;

  it('OPS-3 strategy none gives no rollback writer', () => {
    const rollbackWriterFor = createRollbackWriterFor(deps());
    expect(rollbackWriterFor(withStrategy(configuration, { strategy: 'none' }), 'catalog.update_content')).toBeUndefined();
    // An unknown operation, one without a manifest and one without a usable write binding get none either.
    expect(rollbackWriterFor(configuration, 'catalog.unknown')).toBeUndefined();
    expect(rollbackWriterFor(configuration, 'catalog.get_products_by_sku')).toBeUndefined();
    expect(rollbackWriterFor(configuration, 'catalog.update_content_plain')).toBeInstanceOf(ManifestBatchWriter);
    expect(createRollbackWriterFor({ ...deps(), adapter: bulkOnly(createOpenApiAdapter()) })(configuration, 'catalog.update_content_plain')).toBeUndefined();
    // An inverse operation that is not in the configuration has no binding.
    const dangling = withStrategy(configuration, { strategy: 'inverse_operation', operation: 'catalog.gone' });
    expect(rollbackWriterFor(dangling, 'catalog.update_content')).toBeUndefined();
    expect(up.requests).toEqual([]);
  });

  it('OPS-3 replay_previous_state restores before values against the fake catalog', async () => {
    const writer = createRollbackWriterFor(deps())(configuration, 'catalog.update_content');
    expect(writer).toBeInstanceOf(ManifestBatchWriter);
    const batch = new FakeBatch(statusPolls);

    const outcomes = await writer?.writeBatch({ changeset: executedChangeset(), items: WRITTEN, batch });

    expect(outcomes).toEqual([
      { targetId: 'A', status: 'written' },
      { targetId: 'B', status: 'written', error: 'already_restored' },
    ]);
    expect(catalog.submissions).toHaveLength(1);
    expect(catalog.submissions[0]?.skus).toEqual(['A']);
    expect(catalog.product('A')).toMatchObject({ description: 'old A', status: 2 });
    expect(catalog.product('B')).toMatchObject({ description: 'old B' });
    expect(batch.recorded).toHaveLength(1);
    expect(lines.filter((l) => l.method === 'POST').map((l) => l.operation)).toEqual(['catalog.update_content']);
  });

  it('OPS-3 inverse_operation writes through the inverse operation binding', async () => {
    const writer = createRollbackWriterFor(deps())(withInverse(configuration), 'catalog.update_content');
    expect(writer).toBeInstanceOf(ManifestBatchWriter);

    const outcomes = await writer?.writeBatch({ changeset: executedChangeset(), items: WRITTEN, batch: new FakeBatch(statusPolls) });

    expect(outcomes).toEqual([
      { targetId: 'A', status: 'written' },
      { targetId: 'B', status: 'written', error: 'already_restored' },
    ]);
    expect(catalog.product('A')).toMatchObject({ description: 'old A', status: 2 });
    // Submit and status calls go through the inverse operation's binding; the reads stay the manifest's read_before.
    const bulk = lines.filter((l) => l.operation !== 'catalog.get_products_by_sku');
    expect(bulk.length).toBeGreaterThanOrEqual(2);
    expect(new Set(bulk.map((l) => l.operation))).toEqual(new Set(['catalog.restore_content']));
  });

  it('EXE-4 rollback upstream calls carry the rollback correlation id; execution calls the execution correlation id', async () => {
    const changeset = executedChangeset();
    await createRollbackWriterFor(deps())(configuration, 'catalog.update_content')?.writeBatch({
      changeset,
      items: WRITTEN,
      batch: new FakeBatch(statusPolls),
    });
    expect(lines.length).toBeGreaterThan(0);
    expect(new Set(lines.map((l) => l.correlationId))).toEqual(new Set(['corr-rollback']));

    lines.length = 0;
    // The same change-set while it executed: no rollback request yet.
    const executing: ChangeSetRecord = { ...changesetFor('catalog.update_content'), executionRequest: EXECUTION_REQUEST };
    await createWriterFor(deps())(configuration, 'catalog.update_content').writeBatch({
      changeset: executing,
      items: ITEMS,
      batch: new FakeBatch(statusPolls),
    });
    expect(lines.length).toBeGreaterThan(0);
    expect(new Set(lines.map((l) => l.correlationId))).toEqual(new Set(['corr-exec']));
  });
});

/** An opaque operation on the preset's connection: one `POST /V1/notes` (design phase 9 §2). */
const OPAQUE_OPERATIONS = `version: 1
operations:
  - id: catalog.notify_team
    connection: magento
    risk: write_opaque
    description: Send a note to the catalog team.
    upstream: { method: POST, path: /V1/notes, body: { arg: note } }
    input_schema: { type: object, properties: { note: { type: string } }, required: [note] }
`;

const NOTE = 'a-distinctive-note-value';
const CALL_ITEM: readonly ChangeItemRecord[] = [{ targetId: 'call', status: 'pending', before: null, after: { note: NOTE } }];

function opaqueChangeset(operation: string): ChangeSetRecord {
  return { ...changesetFor(operation), args: { note: NOTE }, executionRequest: EXECUTION_REQUEST };
}

describe('EXE-4 worker writerFor of opaque operations', () => {
  let up: FakeUpstream;
  let configuration: LoadedConfiguration;
  let vault: MemoryVault;
  let lines: UpstreamCallLog[];

  beforeEach(async () => {
    up = await startFakeUpstream();
    up.route('POST', `${MAGENTO_BASE_PATH}/V1/notes`, () => ({ status: 201, body: { id: 7 } }));
    configuration = await loadMagentoPreset(`${up.url}${MAGENTO_BASE_PATH}`, [{ file: 'operations.yaml', text: OPAQUE_OPERATIONS }]);
    vault = await vaultWithToken(FAKE_TOKEN);
    lines = [];
  });
  afterEach(async () => {
    await up.close();
  });

  const writerFor = () => createWriterFor({ vault, adapter: createOpenApiAdapter(), log: (l) => lines.push(l) });

  it('EXE-4 createWriterFor answers an OpaqueCallWriter for write_opaque and for destructive without a manifest', async () => {
    const operations = configuration.policy.operations.map((o) => (o.id === 'catalog.notify_team' ? { ...o, risk: 'destructive' as const } : o));
    const destructive = { ...configuration, policy: { ...configuration.policy, operations } };

    for (const config of [configuration, destructive]) {
      const writer = writerFor()(config, 'catalog.notify_team');
      expect(writer).toBeInstanceOf(OpaqueCallWriter);
      const batch = new FakeBatch(() => 0);
      const outcomes = await writer.writeBatch({ changeset: opaqueChangeset('catalog.notify_team'), items: CALL_ITEM, batch });
      expect(outcomes).toEqual([{ targetId: 'call', status: 'written' }]);
      // Recorded once, before the request left (EXE-4).
      expect(batch.recorded).toEqual([{ upstreamBatchId: 'opaque:cs-1:1', plan: [{ targetId: 'call', action: 'write' }] }]);
    }
    expect(up.requests.map((r) => [r.method, r.path])).toEqual([
      ['POST', `${MAGENTO_BASE_PATH}/V1/notes`],
      ['POST', `${MAGENTO_BASE_PATH}/V1/notes`],
    ]);
    expect(up.requests.every((r) => r.headers.authorization === `Bearer ${FAKE_TOKEN}`)).toBe(true);
    // Forward calls run under the execution request; no argument or token reaches the log (SEC-3).
    expect(new Set(lines.map((l) => l.correlationId))).toEqual(new Set(['corr-exec']));
    expect(JSON.stringify(lines)).not.toContain(NOTE);
    expect(JSON.stringify(lines)).not.toContain(FAKE_TOKEN);
    // An opaque operation has no rollback writer (EXE-8).
    expect(createRollbackWriterFor({ vault, adapter: createOpenApiAdapter() })(configuration, 'catalog.notify_team')).toBeUndefined();
  });

  it('EXE-4 an opaque operation whose binding is gone fails its call upstream_rejected and sends nothing', async () => {
    const bindings = new Map(configuration.bindings);
    bindings.delete('catalog.notify_team');
    const writer = writerFor()({ ...configuration, bindings }, 'catalog.notify_team');
    expect(writer).toBeInstanceOf(OpaqueCallWriter);
    const batch = new FakeBatch(() => 0);
    expect(await writer.writeBatch({ changeset: opaqueChangeset('catalog.notify_team'), items: CALL_ITEM, batch })).toEqual([
      { targetId: 'call', status: 'failed', error: 'upstream_rejected' },
    ]);
    expect(batch.recorded).toEqual([]);
    expect(up.requests).toEqual([]);
  });
});

const SEND_V1: McpToolDefinition = { name: 'send', inputSchema: { type: 'object', properties: { to: { type: 'string' } } } };
const SEND_V2: McpToolDefinition = { ...SEND_V1, description: 'Send, now also to everyone in copy.' };

/** An MCP connection with one opaque operation pinned to `tool`, loaded while the server lists `tool`. */
async function mcpConfiguration(tool: McpToolDefinition): Promise<LoadedConfiguration> {
  const resolver: UpstreamResolver = {
    resolveSpec: () => Promise.resolve({ ok: true, catalog: [] }),
    resolveTools: () => Promise.resolve(toolList(tool)),
  };
  const loaded = await loadConfigurationSources(
    [
      {
        file: 'connections.yaml',
        text: 'version: 1\nconnections:\n  - { id: tools, adapter: mcp, mcp_url: http://tools.example.test/mcp }\n',
      },
      {
        file: 'operations.yaml',
        text: `version: 1\noperations:\n  - id: tools.send\n    connection: tools\n    risk: write_opaque\n    description: Send.\n    upstream: { tool: send, pin: ${mcpToolHash(tool)} }\n`,
      },
    ],
    { resolver },
  );
  if (!loaded.ok) throw new Error(JSON.stringify(loaded.issues));
  return loaded.configuration;
}

function toolList(...definitions: McpToolDefinition[]): ToolListOutcome {
  return { ok: true, tools: definitions.map((definition) => ({ definition, hash: mcpToolHash(definition) })), dropped: 0, durationMs: 1 };
}

/** Counts `callOnce` and honours its contract: the hook, then one send. */
class CountingAdapter implements ReadAdapter, WriteAdapter {
  sent = 0;
  read(): Promise<ReadOutcome> {
    throw new Error('not used');
  }
  detectScopes(): Promise<ScopeReport> {
    throw new Error('not used');
  }
  submitBulk(): Promise<BulkSubmitOutcome> {
    throw new Error('not used');
  }
  bulkStatus(): Promise<BulkStatusOutcome> {
    throw new Error('not used');
  }
  async callOnce(input: Parameters<NonNullable<WriteAdapter['callOnce']>>[0]): Promise<CallOutcome> {
    await input.beforeSend();
    this.sent += 1;
    return { result: 'accepted', durationMs: 1 };
  }
}

describe('CONN-4 worker writerFor of opaque MCP operations', () => {
  it('CONN-4 the pin of an opaque MCP call is checked against the configuration passed to writerFor', async () => {
    // The worker started under v1; the server now lists v2, and a reload pinned v2.
    const atStartup = await mcpConfiguration(SEND_V1);
    const reloaded = await mcpConfiguration(SEND_V2);
    const lister: ToolLister = () => Promise.resolve(toolList(SEND_V2));
    const adapter = new CountingAdapter();
    const writerFor = createWriterFor({ vault: new MemoryVault(), adapter, toolLister: lister });
    const changeset = { ...opaqueChangeset('tools.send'), connection: 'tools' };

    const stale = await writerFor(atStartup, 'tools.send').writeBatch({ changeset, items: CALL_ITEM, batch: new FakeBatch(() => 0) });
    expect(stale).toEqual([{ targetId: 'call', status: 'failed', error: 'upstream_changed' }]);
    expect(adapter.sent).toBe(0);

    const current = await writerFor(reloaded, 'tools.send').writeBatch({ changeset, items: CALL_ITEM, batch: new FakeBatch(() => 0) });
    expect(current).toEqual([{ targetId: 'call', status: 'written' }]);
    expect(adapter.sent).toBe(1);
  });

  it('CONN-4 without a tool lister an opaque MCP call fails closed upstream_unavailable and sends nothing', async () => {
    const adapter = new CountingAdapter();
    const writer = createWriterFor({ vault: new MemoryVault(), adapter })(await mcpConfiguration(SEND_V1), 'tools.send');
    const batch = new FakeBatch(() => 0);
    expect(await writer.writeBatch({ changeset: opaqueChangeset('tools.send'), items: CALL_ITEM, batch })).toEqual([
      { targetId: 'call', status: 'failed', error: 'upstream_unavailable' },
    ]);
    expect(batch.recorded).toEqual([]);
    expect(adapter.sent).toBe(0);
  });
});

/**
 * A create and the delete that undoes it, both per-record bindings on the preset's connection (OPS-2, EXE-8).
 * Their read_before finds a product by SKU in any brand: existence is read without the scope filter (ADR 0071).
 */
const CREATE_AND_DELETE = `version: 1
operations:
  - id: catalog.find_products_by_sku
    connection: magento
    risk: read
    description: Products by SKU in any brand.
    input_schema:
      type: object
      properties:
        skus: { type: array, items: { type: string }, maxItems: 100 }
        fields: { type: array, items: { type: string } }
      required: [skus, fields]
      additionalProperties: false
    fields_arg: fields
    upstream:
      method: GET
      path: /V1/products
      query:
        searchCriteria[filter_groups][0][filters][0][field]: sku
        searchCriteria[filter_groups][0][filters][0][value]: { arg: skus, join: ',' }
        searchCriteria[filter_groups][0][filters][0][condition_type]: in
        searchCriteria[pageSize]: 100
      response: { items: items, total: total_count, flatten: { path: custom_attributes, key: attribute_code, value: value }, fields_from_arg: fields, max_items: 100 }
  - id: catalog.create_product
    connection: magento
    risk: write
    description: Create products.
    input_schema:
      type: object
      properties:
        brand: { type: string }
        records:
          type: array
          items:
            type: object
            properties: { sku: { type: string }, description: { type: string }, brand: { type: string } }
            required: [sku]
            additionalProperties: false
      required: [brand, records]
      additionalProperties: false
    upstream: { method: POST, path: /V1/products }
    manifest:
      action: create
      id_field: sku
      records_arg: records
      fields: [description, brand]
      scope_args: { brand: brand }
      read_before:
        operation: catalog.find_products_by_sku
        ids_arg: skus
      rollback: { strategy: inverse_operation, operation: catalog.delete_product }
  - id: catalog.delete_product
    connection: magento
    risk: destructive
    description: Delete products.
    input_schema:
      type: object
      properties:
        brand: { type: string }
        skus: { type: array, items: { type: string } }
      required: [brand, skus]
      additionalProperties: false
    upstream: { method: DELETE, path: '/V1/products/{sku}', path_params: { sku: { record: sku } } }
    manifest:
      action: delete
      id_field: sku
      ids_arg: skus
      fields: [description, brand]
      scope_args: { brand: brand }
      read_before:
        operation: catalog.find_products_by_sku
        ids_arg: skus
      rollback: { strategy: none }
`;

describe('OPS-2 EXE-8 create and its rollback through the worker writers', () => {
  let up: FakeUpstream;
  let configuration: LoadedConfiguration;
  let vault: MemoryVault;
  let lines: UpstreamCallLog[];
  let catalog: FakeMagentoCatalog;
  const sent: { method: string; path: string; body: string }[] = [];

  beforeEach(async () => {
    up = await startFakeUpstream();
    sent.length = 0;
    catalog = installFakeMagentoCatalog(up, { basePath: MAGENTO_BASE_PATH, products: [] });
    // The per-record routes apply to the fake catalog, so the verify after the write sees the new state.
    up.route('POST', `${MAGENTO_BASE_PATH}/V1/products`, (req) => {
      sent.push({ method: req.method, path: req.path, body: req.body });
      const { sku, ...fields } = JSON.parse(req.body) as { sku: string };
      catalog.set(sku, { name: 'New', status: 1, ...fields });
      return { status: 200, body: {} };
    });
    up.routeMatch('DELETE', /\/V1\/products\/.+$/, (req) => {
      sent.push({ method: req.method, path: req.path, body: req.body });
      catalog.remove(decodeURIComponent(req.path.split('/').pop() ?? ''));
      return { status: 200, body: true };
    });
    configuration = await loadMagentoPreset(`${up.url}${MAGENTO_BASE_PATH}`, [{ file: 'operations.yaml', text: CREATE_AND_DELETE }]);
    vault = await vaultWithToken(FAKE_TOKEN);
    lines = [];
  });
  afterEach(async () => {
    await up.close();
  });

  const deps = () => ({ vault, adapter: createOpenApiAdapter(), clock: new FakeClock(), log: (l: UpstreamCallLog) => lines.push(l) });
  const statusPolls = (): number => up.requests.filter((r) => r.method === 'GET' && r.path.endsWith('/detailed-status')).length;
  const NEW = { description: 'fresh', brand: 'acme' };
  const created: ChangeItemRecord = { targetId: 'N1', status: 'pending', before: null, after: NEW };
  const createdChangeset = (): ChangeSetRecord => ({
    ...changesetFor('catalog.create_product'),
    args: { brand: 'acme', records: [{ sku: 'N1', ...NEW }] },
    status: 'rolling_back',
    executionRequest: EXECUTION_REQUEST,
    rollbackRequest: { actor: 'alice', correlationId: 'corr-rollback', requestedAt: new Date(2_000) },
  });

  it('OPS-2 createWriterFor sends the created record, id_field and the after fields, through the per-record POST binding', async () => {
    const writer = createWriterFor(deps())(configuration, 'catalog.create_product');
    expect(writer).toBeInstanceOf(ManifestBatchWriter);

    const outcomes = await writer.writeBatch({ changeset: createdChangeset(), items: [created], batch: new FakeBatch(statusPolls) });

    expect(outcomes).toEqual([{ targetId: 'N1', status: 'written' }]);
    expect(sent.map((r) => [r.method, r.path])).toEqual([['POST', `${MAGENTO_BASE_PATH}/V1/products`]]);
    expect(JSON.parse(sent[0]?.body ?? 'null')).toEqual({ sku: 'N1', ...NEW });
    expect(catalog.product('N1')).toMatchObject(NEW);
    expect(lines.filter((l) => l.method === 'POST').map((l) => l.operation)).toEqual(['catalog.create_product']);
  });

  it('OPS-2 EXE-8 createRollbackWriterFor deletes the created record through the inverse delete operation', async () => {
    catalog.set('N1', { name: 'New', status: 1, ...NEW });
    const writer = createRollbackWriterFor(deps())(configuration, 'catalog.create_product');
    expect(writer).toBeInstanceOf(ManifestBatchWriter);

    const outcomes = await writer?.writeBatch({ changeset: createdChangeset(), items: [{ ...created, status: 'written' }], batch: new FakeBatch(statusPolls) });

    expect(outcomes).toEqual([{ targetId: 'N1', status: 'written' }]);
    expect(sent.map((r) => [r.method, r.path])).toEqual([['DELETE', `${MAGENTO_BASE_PATH}/V1/products/N1`]]);
    expect(lines.filter((l) => l.method === 'DELETE').map((l) => l.operation)).toEqual(['catalog.delete_product']);
    expect(lines.filter((l) => l.method === 'POST')).toEqual([]);
    expect(catalog.product('N1')).toBeUndefined();
  });
});
