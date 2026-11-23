// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Mandate Authors
/**
 * A create and a delete of the preset template through `changesetWorkflow` on a real Temporal test
 * server and PostgreSQL, with the production reader, writers and execution guard against a fake
 * notes upstream (EXE-4, CS-7, EXE-8, ADR 0071): what exists is excluded, what changed after the
 * approval is skipped as drift and never overwritten or deleted, and a rollback undoes exactly what
 * was written. The delete is approved with step-up, as a destructive operation always is.
 */
import { randomUUID } from 'node:crypto';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createOpenApiAdapter } from '@mandate/adapters';
import { loadConfigurationSources, type LoadedConfiguration } from '@mandate/config';
import { createChangeSet, ROLLBACK_REQUEST_MARGIN_MS, type ChangeItemRecord, type ChangeSetRecord } from '@mandate/core';
import { presetConnectionYaml, recordApproval, startFakeUpstream, submitChangeSet, type FakeUpstream, type RecordedRequest } from '@mandate/testing';
import { createUpstreamReader } from '@mandate/upstream';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { changesetWorkflow } from '../../src/workflows/changeset.js';
import { createRollbackWriterFor, createWriterFor } from '../../src/writers.js';
import { startInfrastructure, startTestWorker, type Infra, type TestWorker } from '../support/harness.js';
import { MemoryVault } from '../support/magento.js';

const EXAMPLES_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '../../../../examples');
const CREDENTIAL_REF = 'notes-token';
const EDITORS = 'editors';
const REVIEWERS = 'reviewers';
/** Seconds a step-up authentication stays valid for the destructive change-set. */
const STEP_UP_SECONDS = 300;

/** `editor` needs one `reviewer` approval for every change-set; a delete additionally needs step-up (POL-5). */
const ROLES = `version: 1
roles:
  - id: editor
    grants:
      - operation: notes.create
      - operation: notes.delete
    approval: { required: always, steps: [{ role: reviewer }] }
  - id: reviewer
    grants: []
role_mapping:
  - group: editors
    roles: [editor]
  - group: reviewers
    roles: [reviewer]
`;

interface Note {
  readonly id: string;
  readonly title: string;
  readonly body?: string;
}

let infra: Infra;

beforeAll(async () => {
  infra = await startInfrastructure();
});

afterAll(async () => {
  await infra.close();
});

async function loadTemplate(baseUrl: string): Promise<LoadedConfiguration> {
  const config = presetConnectionYaml({
    presetId: 'notes',
    package: '@mandate-examples/preset-template',
    version: '1.4.0',
    connectionId: 'notes',
    baseUrl,
    credentialRef: CREDENTIAL_REF,
  });
  const result = await loadConfigurationSources(
    [
      { file: 'config.yaml', text: config },
      { file: 'roles.yaml', text: ROLES },
    ],
    { resolver: createOpenApiAdapter().resolver, presetDirs: [EXAMPLES_DIR] },
  );
  if (!result.ok) throw new Error(`template did not load: ${JSON.stringify(result.issues)}`);
  return result.configuration;
}

describe('EXE-4 CS-7 EXE-8 create and delete through the workflow', () => {
  let up: FakeUpstream;
  /** The fake upstream's notes. */
  let notes: Map<string, Note>;
  let configuration: LoadedConfiguration;
  let worker: TestWorker;

  const bodyOf = (r: RecordedRequest): unknown => JSON.parse(r.body) as unknown;
  const requestsOf = (method: string): RecordedRequest[] => up.requests.filter((r) => r.method === method && r.path.startsWith('/notes'));

  beforeEach(async () => {
    notes = new Map();
    up = await startFakeUpstream();
    up.route('GET', '/notes', (req) => {
      const ids = req.query.get('ids');
      const wanted = ids === null ? [...notes.keys()] : ids.split(',');
      const items = wanted.flatMap((id) => {
        const note = notes.get(id);
        return note === undefined ? [] : [note];
      });
      return { status: 200, body: { items, total: items.length } };
    });
    up.route('POST', '/notes', (req) => {
      const note = JSON.parse(req.body) as Note;
      if (notes.has(note.id)) return { status: 409, body: { error: 'exists' } };
      notes.set(note.id, note);
      return { status: 201, body: note };
    });
    up.routeMatch('DELETE', /^\/notes\/[^/]+$/, (req) => {
      const id = decodeURIComponent(req.path.slice('/notes/'.length));
      return notes.delete(id) ? { status: 204 } : { status: 404, body: { error: 'not found' } };
    });
    configuration = await loadTemplate(up.url);
    const vault = new MemoryVault();
    await vault.put({ ref: CREDENTIAL_REF, scheme: 'bearer', secret: { token: 'create-delete-test-only-token' }, actor: 'test' });
    const adapter = createOpenApiAdapter();
    worker = await startTestWorker(infra, {
      configuration,
      writerFor: createWriterFor({ vault, adapter }),
      rollbackWriterFor: createRollbackWriterFor({ vault, adapter }),
      readerFor: (current, correlationId) => createUpstreamReader({ configuration: current, vault, adapter, correlationId }),
      // A window of one hour: the workflow waits for a rollback request; a case that needs none ends the workflow itself.
      settings: { batchSize: 100, rollbackWindowHours: 1 },
    });
  });

  afterEach(async () => {
    await worker.stop();
    await up.close();
  });

  async function load(id: string): Promise<ChangeSetRecord> {
    const cs = await infra.repository.get(id);
    if (cs === undefined) throw new Error('change-set not found');
    return cs;
  }

  const itemsOf = (id: string): Promise<readonly ChangeItemRecord[]> => infra.repository.itemsPage(id, { limit: 500 });
  const summary = async (id: string): Promise<unknown[]> =>
    (await itemsOf(id)).map((i) => [i.targetId, i.status, i.reason, i.error, i.rollbackStatus, i.rollbackError]);

  /** Creates the change-set as the api does and lets its workflow prepare it. */
  async function prepare(operationId: string, args: Record<string, unknown>): Promise<ChangeSetRecord> {
    const operation = configuration.policy.operations.find((o) => o.id === operationId);
    const manifest = operation?.manifest;
    if (operation === undefined || manifest === undefined) throw new Error(`operation ${operationId} missing`);
    const created = await createChangeSet(
      { repository: infra.repository, newId: randomUUID, now: () => new Date() },
      {
        operation: { ...operation, manifest },
        args,
        caller: { subject: 'alice', groups: [EDITORS] },
        correlationId: `corr-create-${randomUUID()}`,
        configHash: configuration.hash,
        expireAfterHours: 1,
      },
    );
    if (!created.ok) throw new Error(`change-set not created: ${created.code}`);
    await worker.starter.start(created.changeset.id);
    await expect.poll(async () => (await load(created.changeset.id)).status, { timeout: 30_000 }).toBe('prepared');
    return load(created.changeset.id);
  }

  /** Submits for the `reviewer` step (with step-up when asked) and records the reviewer's approval. */
  async function approve(prepared: ChangeSetRecord, opts: { stepUp?: boolean } = {}): Promise<ChangeSetRecord> {
    const submitted = await submitChangeSet(infra.repository, prepared, {
      steps: ['reviewer'],
      groups: [EDITORS],
      ...(opts.stepUp === true ? { stepUp: STEP_UP_SECONDS } : {}),
    });
    await worker.executor.wake(prepared.id);
    const approved = await recordApproval(infra.repository, submitted, { approver: 'rita' });
    expect(approved.status).toBe('approved');
    return approved;
  }

  /** Starts the execution of an approved change-set under the requester's identity (POL-6). */
  async function start(approved: ChangeSetRecord): Promise<void> {
    if (approved.hash === undefined) throw new Error('approved change-set has no hash');
    const started = await worker.executor.start({
      changesetId: approved.id,
      expectedHash: approved.hash,
      actor: 'rita',
      groups: [REVIEWERS],
      correlationId: `corr-exec-${randomUUID()}`,
      requester: { subject: 'alice', groups: [EDITORS] },
    });
    expect(started).toEqual({ ok: true });
  }

  /** Waits until execution has finished and the rollback window is open (observable state). */
  async function windowOpen(id: string): Promise<void> {
    await expect
      .poll(async () => {
        const cs = await load(id);
        return [cs.status, cs.rollbackUntil !== undefined];
      }, { timeout: 30_000 })
      .toEqual(['completed', true]);
  }

  async function rollBack(id: string): Promise<void> {
    const requested = await infra.repository.requestRollback({
      changesetId: id,
      request: { actor: 'alice', correlationId: `corr-rollback-${randomUUID()}`, requestedAt: new Date() },
      marginMs: ROLLBACK_REQUEST_MARGIN_MS,
      audit: [],
    });
    expect(requested.ok).toBe(true);
    await worker.executor.wake(id);
    await expect(infra.client.workflow.getHandle<typeof changesetWorkflow>(id).result()).resolves.toEqual({ status: 'rolled_back' });
  }

  it('EXE-4 CS-7 CS-3 a create excludes the note that exists, writes the other once and its rollback deletes it', async () => {
    notes.set('n2', { id: 'n2', title: 'Existing', body: 'kept' });
    const prepared = await prepare('notes.create', {
      notes: [
        { id: 'n1', title: 'Kickoff', body: 'Agenda' },
        { id: 'n2', title: 'Replacement' },
      ],
    });
    expect((await itemsOf(prepared.id)).map((i) => [i.targetId, i.status, i.reason])).toEqual([
      ['n1', 'pending', undefined],
      ['n2', 'excluded', 'already_exists'],
    ]);

    await start(await approve(prepared));
    await windowOpen(prepared.id);
    expect(await summary(prepared.id)).toEqual([
      ['n1', 'written', undefined, undefined, undefined, undefined],
      ['n2', 'excluded', 'already_exists', undefined, undefined, undefined],
    ]);
    expect(notes.get('n1')).toEqual({ id: 'n1', title: 'Kickoff', body: 'Agenda' });
    expect(notes.get('n2')).toEqual({ id: 'n2', title: 'Existing', body: 'kept' });
    // One POST for n1 and none for the note that exists.
    expect(requestsOf('POST').map(bodyOf)).toEqual([{ id: 'n1', title: 'Kickoff', body: 'Agenda' }]);

    await rollBack(prepared.id);
    expect(notes.has('n1')).toBe(false);
    expect(notes.get('n2')).toEqual({ id: 'n2', title: 'Existing', body: 'kept' });
    expect(requestsOf('DELETE').map((r) => r.path)).toEqual(['/notes/n1']);
    expect(await summary(prepared.id)).toEqual([
      ['n1', 'written', undefined, undefined, 'restored', undefined],
      ['n2', 'excluded', 'already_exists', undefined, undefined, undefined],
    ]);
    expect((await load(prepared.id)).stats.rollback).toEqual({ restored: 1, skipped: 0, failed: 0 });
  }, 90_000);

  /** Waits until the item's execution outcome is stored (observable state); with nothing written no rollback window opens, so the workflow ends. */
  async function settledItem(id: string, target: string): Promise<void> {
    await expect
      .poll(async () => (await itemsOf(id)).find((i) => i.targetId === target)?.status, { timeout: 30_000 })
      .not.toBe('pending');
    await expect.poll(async () => (await load(id)).status, { timeout: 30_000 }).not.toBe('executing');
    await expect(infra.client.workflow.getHandle<typeof changesetWorkflow>(id).result()).resolves.toEqual({ status: 'completed' });
  }

  it('EXE-4 CS-7 a note that appeared after the approval is skipped as drift and the upstream note is untouched', async () => {
    const prepared = await prepare('notes.create', { notes: [{ id: 'n1', title: 'Kickoff', body: 'Agenda' }] });
    expect((await itemsOf(prepared.id)).map((i) => [i.targetId, i.status])).toEqual([['n1', 'pending']]);
    const approved = await approve(prepared);
    notes.set('n1', { id: 'n1', title: 'Someone else', body: 'theirs' }); // created elsewhere after the approval
    await start(approved);
    await settledItem(prepared.id, 'n1');
    expect(await summary(prepared.id)).toEqual([['n1', 'skipped', undefined, 'drift', undefined, undefined]]);
    expect(notes.get('n1')).toEqual({ id: 'n1', title: 'Someone else', body: 'theirs' });
    expect(requestsOf('POST')).toEqual([]);
  }, 90_000);

  describe('a delete approved with step-up', () => {
    beforeEach(() => {
      notes.set('n1', { id: 'n1', title: 'Kickoff', body: 'Agenda' });
    });

    it('EXE-4 CS-7 a note changed after the approval is skipped as drift and not deleted', async () => {
      const prepared = await prepare('notes.delete', { ids: ['n1'] });
      expect((await itemsOf(prepared.id)).map((i) => [i.targetId, i.status])).toEqual([['n1', 'pending']]);
      const approved = await approve(prepared, { stepUp: true });
      notes.set('n1', { id: 'n1', title: 'Kickoff v2', body: 'Agenda' }); // edited elsewhere after the approval
      await start(approved);
      await settledItem(prepared.id, 'n1');
      expect(await summary(prepared.id)).toEqual([['n1', 'skipped', undefined, 'drift', undefined, undefined]]);
      expect(notes.get('n1')).toEqual({ id: 'n1', title: 'Kickoff v2', body: 'Agenda' });
      expect(requestsOf('DELETE')).toEqual([]);
    }, 90_000);

    it('EXE-4 EXE-8 CS-7 an unchanged note is deleted and its rollback creates it again with the stored title and body', async () => {
      const prepared = await prepare('notes.delete', { ids: ['n1'] });
      const [item] = await itemsOf(prepared.id);
      expect(item).toMatchObject({ targetId: 'n1', before: { title: 'Kickoff', body: 'Agenda' }, after: null });

      await start(await approve(prepared, { stepUp: true }));
      await windowOpen(prepared.id);
      expect(notes.has('n1')).toBe(false);
      expect(requestsOf('DELETE').map((r) => r.path)).toEqual(['/notes/n1']);

      await rollBack(prepared.id);
      expect(notes.get('n1')).toEqual({ id: 'n1', title: 'Kickoff', body: 'Agenda' });
      expect(requestsOf('POST').map(bodyOf)).toEqual([{ id: 'n1', title: 'Kickoff', body: 'Agenda' }]);
      expect(await summary(prepared.id)).toEqual([['n1', 'written', undefined, undefined, 'restored', undefined]]);
    }, 90_000);
  });
});
