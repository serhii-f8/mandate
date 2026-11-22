// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Mandate Authors
/**
 * Opaque change-sets end to end on Temporal and PostgreSQL (design phase 9 §3, §5; EXE-4, CS-1):
 * a real `changesetWorkflow` prepares the one `call` item without reading anything and executes it
 * as one upstream call, sent at most once. Production-path cases run `createWriterFor` over
 * `createAdapters()` and the production `executionSettings` against a fake HTTP upstream or a fake
 * MCP server, with their own configuration (ruling F16); the kill case runs a scripted caller over
 * the shared test configuration.
 */
import { randomUUID } from 'node:crypto';
import { createAdapters } from '@mandate/adapters';
import { loadConfigurationSources, type LoadedConfiguration } from '@mandate/config';
import { mcpToolHash, type McpToolDefinition } from '@mandate/connector-sdk';
import { BatchFenced, createChangeSet, OpaqueCallWriter, type BatchContext, type ChangeItemRecord } from '@mandate/core';
import { CHANGESET_WORKFLOW, WAKE_SIGNAL } from '@mandate/temporal';
import { recordApproval, startFakeMcpServer, startFakeUpstream, submitChangeSet, type FakeMcpServer, type FakeUpstream } from '@mandate/testing';
import { vaultToolLister } from '@mandate/upstream';
import type { WorkflowHandle } from '@temporalio/client';
import { NativeConnection } from '@temporalio/worker';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { executionSettings } from '../../src/activities/settings.js';
import type { changesetWorkflow } from '../../src/workflows/changeset.js';
import { createWriterFor } from '../../src/writers.js';
import { startInfrastructure, startTestWorker, type Infra, type TestWorker } from '../support/harness.js';
import { MemoryVault } from '../support/magento.js';
import { createPreparedOpaque, ScriptedOpaqueCaller } from '../support/opaque.js';
import { auditEventsOf } from '../support/postgres.js';

const HTTP_OPERATION = 'catalog.notify_team';
const MCP_OPERATION = 'tools.create_note';
const EDITOR_GROUP = 'editors';
const APPROVING_GROUP = 'approving-editors';
const REVIEWER_GROUP = 'reviewers';
const CREDENTIAL_REF = 'shop-token';
const FAKE_TOKEN = 'opaque-int-test-only-token';
const NOTE = 'a-distinctive-opaque-note';

const CREATE_NOTE: McpToolDefinition = {
  name: 'create_note',
  description: 'Create a note.',
  inputSchema: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] },
};

/** Its own configuration (ruling F16): the fake upstream and the fake MCP server, a rollback window of 1 h (EXE-8). */
function sources(upstreamUrl: string, mcpUrl: string): { file: string; text: string }[] {
  return [
    {
      file: 'connections.yaml',
      text: `version: 1
connections:
  - { id: shop, adapter: openapi, base_url: ${upstreamUrl}/rest, credential_ref: ${CREDENTIAL_REF}, auth: { scheme: bearer }, allow_private_network: true }
  - { id: tools, adapter: mcp, mcp_url: ${mcpUrl}, allow_private_network: true }
`,
    },
    {
      file: 'operations.yaml',
      text: `version: 1
changesets: { expire_after_hours: 10, failure_threshold: 0.5, items_per_workflow_run: 100, rollback_window_hours: 1 }
operations:
  - id: ${HTTP_OPERATION}
    connection: shop
    risk: write_opaque
    description: Send a note to the catalog team.
    upstream: { method: POST, path: /V1/notes, body: { arg: note } }
    input_schema: { type: object, properties: { note: { type: string } }, required: [note] }
  - id: ${MCP_OPERATION}
    connection: tools
    risk: write_opaque
    description: Create a note through the tool server.
    upstream: { tool: create_note, pin: ${mcpToolHash(CREATE_NOTE)} }
`,
    },
    {
      file: 'roles.yaml',
      text: `version: 1
roles:
  - id: editor
    grants:
      - operation: ${HTTP_OPERATION}
      - operation: ${MCP_OPERATION}
    approval: { required: never }
  - id: approving_editor
    grants:
      - operation: ${HTTP_OPERATION}
    approval: { required: always, steps: [{ role: reviewer }] }
  - id: reviewer
    grants: []
role_mapping:
  - group: ${EDITOR_GROUP}
    roles: [editor]
  - group: ${APPROVING_GROUP}
    roles: [approving_editor]
  - group: ${REVIEWER_GROUP}
    roles: [reviewer]
`,
    },
  ];
}

let infra: Infra;
/** Connections of second workers, closed after the file. */
const connections: NativeConnection[] = [];

beforeAll(async () => {
  infra = await startInfrastructure();
});

afterAll(async () => {
  try {
    for (const c of connections) await c.close();
  } finally {
    await infra.close();
  }
});

const statusOf = async (id: string) => (await infra.repository.get(id))?.status;

async function itemsOf(changesetId: string): Promise<readonly ChangeItemRecord[]> {
  return infra.repository.itemsPage(changesetId, { limit: 10 });
}

async function batchActions(changesetId: string): Promise<string[]> {
  return (await auditEventsOf(infra.database, changesetId)).filter((e) => e.action === 'changeset.batch').map((e) => e.action);
}

/** The stored rollback window end (`rollback_until`); undefined when none was opened. */
async function rollbackUntil(changesetId: string): Promise<Date | undefined> {
  return (await infra.repository.get(changesetId))?.rollbackUntil;
}

describe('CS-1 EXE-4 opaque change-sets through the production writer', () => {
  let up: FakeUpstream;
  let mcp: FakeMcpServer;
  let configuration: LoadedConfiguration;
  let worker: TestWorker;
  /** Every POST /V1/notes the fake upstream answers this status. */
  let noteStatus: number;

  beforeEach(async () => {
    noteStatus = 201;
    up = await startFakeUpstream();
    up.route('POST', '/rest/V1/notes', () => ({ status: noteStatus, body: { id: 7, message: 'upstream detail' } }));
    mcp = await startFakeMcpServer({ tools: [CREATE_NOTE], mode: 'stateless' });
    const adapter = createAdapters();
    const loaded = await loadConfigurationSources(sources(up.url, mcp.url), { resolver: adapter.resolver });
    if (!loaded.ok) throw new Error(`configuration invalid: ${JSON.stringify(loaded.issues)}`);
    configuration = loaded.configuration;
    const vault = new MemoryVault();
    await vault.put({ ref: CREDENTIAL_REF, scheme: 'bearer', secret: { token: FAKE_TOKEN }, actor: 'test' });
    worker = await startTestWorker(infra, {
      configuration,
      writerFor: createWriterFor({ vault, adapter, toolLister: vaultToolLister(adapter, vault) }),
      // Ruling F2: the production settings, so an opaque operation without a manifest really runs.
      settingsFor: executionSettings,
    });
  });

  afterEach(async () => {
    await worker.stop();
    await up.close();
    await mcp.close();
  });

  const noteRequests = () => up.requests.filter((r) => r.method === 'POST' && r.path === '/rest/V1/notes');
  const toolCalls = () => mcp.requests.filter((r) => r.rpcMethod === 'tools/call');

  /** Creates the change-set as the api does and lets its workflow prepare it. */
  async function prepared(operationId: string, args: Readonly<Record<string, unknown>>): Promise<{ id: string; hash: string }> {
    const operation = configuration.policy.operations.find((o) => o.id === operationId);
    if (operation === undefined) throw new Error('operation missing');
    const created = await createChangeSet(
      { repository: infra.repository, newId: randomUUID, now: () => new Date() },
      {
        operation,
        args,
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

  it('CS-1 EXE-4 an opaque change-set prepared, approved and executed calls upstream exactly once', async () => {
    const cs = await prepared(HTTP_OPERATION, { note: NOTE });
    // Preparation read nothing upstream (CS-1).
    expect(up.requests).toEqual([]);
    const record = await infra.repository.get(cs.id);
    if (record === undefined) throw new Error('change-set missing');
    const pending = await submitChangeSet(infra.repository, record, { steps: ['reviewer'], groups: [APPROVING_GROUP] });
    await worker.executor.wake(cs.id);
    const approved = await recordApproval(infra.repository, pending, { approver: 'rita' });
    expect(approved.status).toBe('approved');
    expect(
      await worker.executor.start({
        changesetId: cs.id,
        expectedHash: cs.hash,
        actor: 'rita',
        groups: [REVIEWER_GROUP],
        correlationId: 'corr-exec-approved',
        requester: { subject: 'alice', groups: [APPROVING_GROUP] },
      }),
    ).toEqual({ ok: true });
    await worker.executor.settled(cs.id);

    expect(noteRequests()).toHaveLength(1);
    expect(up.requests).toHaveLength(1);
    expect(noteRequests()[0]?.headers.authorization).toBe(`Bearer ${FAKE_TOKEN}`);
    expect(JSON.parse(noteRequests()[0]?.body ?? 'null')).toBe(NOTE);
    expect((await itemsOf(cs.id)).map((i) => [i.targetId, i.status, i.error])).toEqual([['call', 'written', undefined]]);
    expect(await statusOf(cs.id)).toBe('completed');
    // EXE-8: no rollback window for an opaque change-set, although the configuration has 1 h.
    expect(configuration.changesets.rollbackWindowHours).toBe(1);
    expect(await rollbackUntil(cs.id)).toBeUndefined();
    // AUD-1: one batch row; no upstream text in items or audit (SEC-5).
    expect(await batchActions(cs.id)).toEqual(['changeset.batch']);
    const stored = JSON.stringify({ items: await itemsOf(cs.id), audit: await auditEventsOf(infra.database, cs.id) });
    expect(stored).not.toContain('upstream detail');
    expect(stored).not.toContain(FAKE_TOKEN);
  });

  it('EXE-4 an upstream 500 ends failed/no_outcome with one request; a 422 failed/upstream_rejected', async () => {
    for (const [status, error] of [
      [500, 'no_outcome'],
      [422, 'upstream_rejected'],
    ] as const) {
      noteStatus = status;
      const before = noteRequests().length;
      const cs = await prepared(HTTP_OPERATION, { note: `${NOTE}-${String(status)}` });
      await execute(cs);
      // Sent once and never retried, whatever the answer (EXE-5).
      expect(noteRequests().length - before).toBe(1);
      expect((await itemsOf(cs.id)).map((i) => [i.status, i.error])).toEqual([['failed', error]]);
      // 1 of 1 failed: every included item failed.
      expect(await statusOf(cs.id)).toBe('failed');
    }
    expect(up.requests).toHaveLength(2);
  });

  it('CONN-4 an MCP opaque call whose tool changed after approval ends failed/upstream_changed with no tools/call', async () => {
    const cs = await prepared(MCP_OPERATION, { text: NOTE });
    mcp.updateTool('create_note', { description: 'Create a note and mail it to every customer.' });
    await execute(cs);

    expect((await itemsOf(cs.id)).map((i) => [i.status, i.error])).toEqual([['failed', 'upstream_changed']]);
    expect(await statusOf(cs.id)).toBe('failed');
    // The fresh tools/list saw the change; nothing was called (CONN-4, EXE-4).
    expect(mcp.requests.some((r) => r.rpcMethod === 'tools/list')).toBe(true);
    expect(toolCalls()).toEqual([]);
    // Pre-flight failed: no submission was recorded.
    const batch = await infra.database.pool.query<{ upstream_batch_id: string | null }>(
      'SELECT upstream_batch_id FROM change_batch WHERE changeset_id = $1',
      [cs.id],
    );
    expect(batch.rows.map((r) => r.upstream_batch_id)).toEqual([null]);
  });

  it('CONN-4 EXE-4 an MCP opaque call with an unchanged tool is called exactly once', async () => {
    const cs = await prepared(MCP_OPERATION, { text: NOTE });
    await execute(cs);
    expect((await itemsOf(cs.id)).map((i) => [i.status, i.error])).toEqual([['written', undefined]]);
    expect(await statusOf(cs.id)).toBe('completed');
    expect(toolCalls()).toHaveLength(1);
  });

  /** Claims the batch for attempt 1, then lets attempt 2 take it over: attempt 1's record is fenced (NFR-2). */
  async function fencedBatch(changesetId: string): Promise<{ batch: BatchContext; items: readonly ChangeItemRecord[] }> {
    const first = await infra.repository.claimBatch(changesetId, 0, 1, 1);
    if (first.kind !== 'claimed') throw new Error(`batch not claimed: ${first.kind}`);
    expect((await infra.repository.claimBatch(changesetId, 0, 2, 1)).kind).toBe('claimed');
    const batch: BatchContext = {
      key: `${changesetId}:0`,
      recordSubmission: async (submission) => {
        if (!(await infra.repository.recordSubmission(changesetId, 0, 1, submission))) throw new BatchFenced();
      },
      heartbeat: () => undefined,
    };
    return { batch, items: first.items };
  }

  it('EXE-4 NFR-2 a fenced attempt throws BatchFenced in beforeSend and the real adapters send nothing', async () => {
    const vault = new MemoryVault();
    await vault.put({ ref: CREDENTIAL_REF, scheme: 'bearer', secret: { token: FAKE_TOKEN }, actor: 'test' });
    const adapter = createAdapters();
    const writerFor = createWriterFor({ vault, adapter, toolLister: vaultToolLister(adapter, vault) });

    for (const [operation, args] of [
      [HTTP_OPERATION, { note: NOTE }],
      [MCP_OPERATION, { text: NOTE }],
    ] as const) {
      const cs = await createPreparedOpaque(infra.repository, { note: NOTE, execute: { groups: [EDITOR_GROUP] } });
      // The stored operation and arguments of this case (createPreparedOpaque stores the shared opaque operation).
      const changeset = { ...cs, operation, args };
      const { batch, items } = await fencedBatch(cs.id);
      await expect(writerFor(configuration, operation).writeBatch({ changeset, items, batch })).rejects.toBeInstanceOf(BatchFenced);
    }
    expect(up.requests).toEqual([]);
    expect(toolCalls()).toEqual([]);
  });
});

describe('EXE-4 NFR-2 opaque execution across a worker kill', () => {
  async function ownConnection(): Promise<NativeConnection> {
    const connection = await NativeConnection.connect({ address: infra.env.address });
    connections.push(connection);
    return connection;
  }

  function signalWithStart(taskQueue: string, changesetId: string): Promise<WorkflowHandle<typeof changesetWorkflow>> {
    return infra.client.workflow.signalWithStart<typeof changesetWorkflow>(CHANGESET_WORKFLOW, {
      workflowId: changesetId,
      taskQueue,
      args: [{ changesetId }],
      signal: WAKE_SIGNAL,
      signalArgs: [],
    });
  }

  it('EXE-4 NFR-2 a worker killed after the submission is recorded ends failed/no_outcome with exactly one send', async () => {
    const counter = { sends: 0 };
    const callerA = new ScriptedOpaqueCaller(counter);
    const callerB = new ScriptedOpaqueCaller(counter);
    const paused = callerA.pauseSend();
    let lateCallSettled: Promise<unknown> = Promise.resolve();
    const writerA = new OpaqueCallWriter({ callerFor: () => callerA });
    const cs = await createPreparedOpaque(infra.repository, { execute: {} });
    const a = await startTestWorker(infra, {
      writer: {
        writeBatch: (input) => {
          const call = writerA.writeBatch(input);
          lateCallSettled = call.catch(() => undefined);
          return call;
        },
      },
      shutdownForceTime: '1s',
      connection: await ownConnection(),
    });
    let b: TestWorker | undefined;
    try {
      const handle = await signalWithStart(a.taskQueue, cs.id);
      // The submission is recorded and the request has left; the worker dies before the answer.
      await paused.reached;
      expect(counter.sends).toBe(1);
      await expect(a.stop()).rejects.toThrow(/Timed out while waiting for worker to shutdown gracefully/);

      b = await startTestWorker(infra, { writer: new OpaqueCallWriter({ callerFor: () => callerB }), taskQueue: a.taskQueue });
      await expect(handle.result()).resolves.toEqual({ status: 'failed' });

      // B claimed the batch with A's stored submission and sent nothing (EXE-4, EXE-5).
      expect(callerB.calls).toBe(0);
      expect(counter.sends).toBe(1);
      const items = await itemsOf(cs.id);
      expect(items.map((i) => [i.targetId, i.status, i.error])).toEqual([['call', 'failed', 'no_outcome']]);
      expect(await batchActions(cs.id)).toEqual(['changeset.batch']);

      // A's stale attempt finally returns: fenced by B's attempt, it changes nothing.
      paused.release();
      await lateCallSettled;
      await expect.poll(async () => (await itemsOf(cs.id)).map((i) => [i.status, i.error])).toEqual([['failed', 'no_outcome']]);
      expect(await batchActions(cs.id)).toEqual(['changeset.batch']);
      expect(await statusOf(cs.id)).toBe('failed');
      expect(counter.sends).toBe(1);
    } finally {
      paused.release();
      await b?.stop();
    }
  }, 60_000);
});
