// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Mandate Authors
/**
 * A staged file reaches the upstream exactly as approved, or nothing is sent (EXE-4, CS-10, CS-4):
 * a real `changesetWorkflow` over PostgreSQL executes an opaque change-set with a `send: base64` file
 * through the production writer, caller and guard against a fake HTTP upstream. The window between the
 * guard and the send is covered by the `opaque-caller` unit cases.
 */
import { createHash, randomUUID } from 'node:crypto';
import { createAdapters } from '@mandate/adapters';
import { loadConfigurationSources, type LoadedConfiguration } from '@mandate/config';
import { createChangeSet, sha256Of, type ExecutionGuard } from '@mandate/core';
import { PostgresFileStore } from '@mandate/db';
import { createPayloadCodec, parseTemporalKeys } from '@mandate/temporal';
import { startFakeUpstream, type FakeUpstream } from '@mandate/testing';
import { historyToJSON } from '@temporalio/common/lib/proto-utils';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createExecutionGuard } from '../../src/activities/guard.js';
import { executionSettings } from '../../src/activities/settings.js';
import { createWriterFor } from '../../src/writers.js';
import { startInfrastructure, startTestWorker, type Infra, type TestWorker } from '../support/harness.js';
import { TEST_TEMPORAL_KEYS } from '../support/keys.js';
import { MemoryVault } from '../support/magento.js';

const OPERATION = 'catalog.attach_document';
const EDITOR_GROUP = 'editors';
const CREDENTIAL_REF = 'shop-token';
const FAKE_TOKEN = 'opaque-files-int-test-only-token';
const NAME = 'distinctive-quarterly-report-name.pdf';

/** 3 KiB of bytes with every value present, so a lossy path cannot pass by accident. */
const BYTES = Uint8Array.from({ length: 3 * 1024 }, (_, i) => (i * 31 + 7) % 256);
const BASE64 = Buffer.from(BYTES).toString('base64');

function sources(upstreamUrl: string): { file: string; text: string }[] {
  return [
    {
      file: 'connections.yaml',
      text: `version: 1
connections:
  - { id: shop, adapter: openapi, base_url: ${upstreamUrl}/rest, credential_ref: ${CREDENTIAL_REF}, auth: { scheme: bearer }, allow_private_network: true }
`,
    },
    {
      file: 'operations.yaml',
      text: `version: 1
changesets: { expire_after_hours: 10, failure_threshold: 0.5, items_per_workflow_run: 100, rollback_window_hours: 1 }
operations:
  - id: ${OPERATION}
    connection: shop
    risk: write_opaque
    description: Attach a document to a product.
    upstream: { method: POST, path: /V1/documents, body: { arg: entry } }
    input_schema:
      type: object
      properties:
        entry:
          type: object
          properties: { label: { type: string }, content: { type: string, format: uuid } }
          required: [label, content]
      required: [entry]
    files: [{ at: /entry/content, send: base64, media_types: [application/pdf] }]
`,
    },
    {
      file: 'roles.yaml',
      text: `version: 1
roles:
  - id: editor
    grants:
      - operation: ${OPERATION}
    approval: { required: never }
role_mapping:
  - group: ${EDITOR_GROUP}
    roles: [editor]
`,
    },
  ];
}

let infra: Infra;
beforeAll(async () => {
  infra = await startInfrastructure();
});
afterAll(async () => {
  await infra.close();
});

describe('EXE-4 CS-10 a file reaches the upstream as approved', () => {
  let up: FakeUpstream;
  let configuration: LoadedConfiguration;
  let worker: TestWorker;
  let store: PostgresFileStore;
  /** Every answer of the production guard the worker consulted. */
  let guardOutcomes: Awaited<ReturnType<ExecutionGuard['check']>>[];

  beforeEach(async () => {
    up = await startFakeUpstream();
    up.route('POST', '/rest/V1/documents', () => ({ status: 201, body: { id: 7 } }));
    store = new PostgresFileStore(infra.database.db);
    guardOutcomes = [];
    const adapter = createAdapters();
    const loaded = await loadConfigurationSources(sources(up.url), { resolver: adapter.resolver });
    if (!loaded.ok) throw new Error(`configuration invalid: ${JSON.stringify(loaded.issues)}`);
    configuration = loaded.configuration;
    const vault = new MemoryVault();
    await vault.put({ ref: CREDENTIAL_REF, scheme: 'bearer', secret: { token: FAKE_TOKEN }, actor: 'test' });
    const guard = createExecutionGuard({ repository: infra.repository, audit: infra.audit, newId: randomUUID, files: store })(configuration);
    worker = await startTestWorker(infra, {
      configuration,
      writerFor: createWriterFor({ vault, adapter, files: store }),
      guard: {
        check: async (changeset) => {
          const answer = await guard.check(changeset);
          guardOutcomes.push(answer);
          return answer;
        },
      },
      settingsFor: executionSettings,
    });
  });
  afterEach(async () => {
    await worker.stop();
    await up.close();
  });

  const documentRequests = () => up.requests.filter((r) => r.method === 'POST' && r.path === '/rest/V1/documents');

  async function stageFile(): Promise<string> {
    const id = randomUUID();
    const staged = await store.stage(
      { id, owner: 'alice', name: NAME, mediaType: 'application/pdf', content: BYTES, sha256: sha256Of(BYTES), preview: 'none', createdAt: new Date(), quota: { count: 100, bytes: 100_000_000 } },
      { id: randomUUID(), actor: 'alice', action: 'file.staged', outcome: 'ok', correlationId: randomUUID(), details: {} },
    );
    if (!staged.ok) throw new Error('file not staged');
    return id;
  }

  /** Changes the stored bytes and leaves the hash column alone: the guard trigger is disabled inside one transaction (the test user owns the table). */
  async function corrupt(fileId: string): Promise<void> {
    const client = await infra.database.pool.connect();
    try {
      await client.query('BEGIN');
      await client.query('ALTER TABLE staged_file DISABLE TRIGGER staged_file_guard');
      await client.query('UPDATE staged_file SET content = $2 WHERE id = $1', [fileId, Buffer.from('bytes swapped after approval')]);
      await client.query('ALTER TABLE staged_file ENABLE TRIGGER staged_file_guard');
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  async function prepared(fileId: string): Promise<{ id: string; hash: string }> {
    const operation = configuration.policy.operations.find((o) => o.id === OPERATION);
    if (operation === undefined) throw new Error('operation missing');
    const created = await createChangeSet(
      { repository: infra.repository, newId: randomUUID, now: () => new Date(), files: store },
      {
        operation,
        args: { entry: { label: 'Q3', content: fileId } },
        caller: { subject: 'alice', groups: [EDITOR_GROUP] },
        correlationId: `corr-create-${randomUUID()}`,
        configHash: configuration.hash,
        expireAfterHours: 1,
      },
    );
    if (!created.ok) throw new Error(`change-set not created: ${created.code}`);
    const { id } = created.changeset;
    await worker.starter.start(id);
    await expect.poll(async () => (await infra.repository.get(id))?.status, { timeout: 30_000 }).toBe('prepared');
    const record = await infra.repository.get(id);
    if (record?.hash === undefined) throw new Error('prepared change-set has no hash');
    expect(record.hashVersion).toBe(3);
    return { id, hash: record.hash };
  }

  async function execute(cs: { id: string; hash: string }): Promise<void> {
    expect(
      await worker.executor.start({ changesetId: cs.id, expectedHash: cs.hash, actor: 'alice', groups: [EDITOR_GROUP], correlationId: `corr-exec-${randomUUID()}` }),
    ).toEqual({ ok: true });
    await worker.executor.settled(cs.id);
  }

  /** The decrypted payloads of every run of the workflow, as one string. */
  async function decodedHistory(changesetId: string): Promise<{ json: string; payloads: string }> {
    const handle = infra.client.workflow.getHandle(changesetId);
    const history = await handle.fetchHistory();
    const json = historyToJSON(history);
    const codec = createPayloadCodec(parseTemporalKeys(TEST_TEMPORAL_KEYS));
    const found: { metadata: Record<string, Uint8Array>; data: Uint8Array }[] = [];
    const walk = (node: unknown): void => {
      if (Array.isArray(node)) node.forEach(walk);
      else if (typeof node === 'object' && node !== null) {
        const o = node as Record<string, unknown>;
        if (typeof o.data === 'string' && typeof o.metadata === 'object' && o.metadata !== null) {
          const metadata = Object.fromEntries(Object.entries(o.metadata).map(([k, v]) => [k, Buffer.from(String(v), 'base64')]));
          // Only the platform's encrypted payloads are decoded; others (headers, search attributes) carry no change-set data.
          if (Buffer.from(metadata.encoding ?? new Uint8Array()).toString('utf8') === 'binary/encrypted') found.push({ metadata, data: Buffer.from(o.data, 'base64') });
        } else Object.values(o).forEach(walk);
      }
    };
    walk(JSON.parse(json));
    const decoded = await codec.decode(found);
    return { json, payloads: decoded.map((p) => Buffer.from(p.data ?? new Uint8Array()).toString('utf8')).join('\n') };
  }

  it('EXE-4 CS-10 a prepared change-set with a 3 KiB file completes and the upstream gets the exact bytes, none of them in the history', async () => {
    const cs = await prepared(await stageFile());
    expect(up.requests).toEqual([]);
    await execute(cs);

    expect((await infra.repository.get(cs.id))?.status).toBe('completed');
    expect(documentRequests()).toHaveLength(1);
    expect(up.requests).toHaveLength(1);
    const body = JSON.parse(documentRequests()[0]?.body ?? 'null') as { label: string; content: string };
    expect(body.label).toBe('Q3');
    expect(Buffer.from(body.content, 'base64').equals(Buffer.from(BYTES))).toBe(true);
    expect(createHash('sha256').update(Buffer.from(body.content, 'base64')).digest('hex')).toBe(sha256Of(BYTES).slice('sha256:'.length));

    // SEC-3: the workflow history, serialised and decrypted, holds neither the base64 nor the file name.
    const { json, payloads } = await decodedHistory(cs.id);
    expect(payloads).toContain(cs.id); // the decoder worked
    for (const text of [json, payloads]) {
      expect(text).not.toContain(BASE64);
      expect(text).not.toContain(BASE64.slice(0, 64));
      expect(text).not.toContain(NAME);
    }
  }, 60_000);

  it('CS-4 CS-10 content corrupted before the start ends failed/hash_mismatch and the upstream receives nothing', async () => {
    const fileId = await stageFile();
    const cs = await prepared(fileId);
    await corrupt(fileId);
    await execute(cs);
    // The production guard named the refusal itself, not the caller's file_unavailable, and the run never reached the caller: no item ended failed/file_unavailable.
    const items = await infra.repository.itemsPage(cs.id, { limit: 10 });
    expect(guardOutcomes).toContainEqual({ ok: false, outcome: 'hash_mismatch' });
    expect(items.map((i) => i.error)).not.toContain('file_unavailable');

    expect((await infra.repository.get(cs.id))?.status).toBe('failed');
    expect(up.requests).toEqual([]);
    const { payloads } = await decodedHistory(cs.id);
    expect(payloads).not.toContain(BASE64);
  }, 60_000);
});

const MP_OPERATION = 'catalog.upload_attachment';

function multipartSources(upstreamUrl: string): { file: string; text: string }[] {
  const [connections, , roles] = sources(upstreamUrl);
  return [
    connections as { file: string; text: string },
    {
      file: 'operations.yaml',
      text: `version: 1
changesets: { expire_after_hours: 10, failure_threshold: 0.5, items_per_workflow_run: 100, rollback_window_hours: 1 }
operations:
  - id: ${MP_OPERATION}
    connection: shop
    risk: write_opaque
    description: Upload an attachment with fields.
    upstream: { method: POST, path: /V1/attachments, body: { arg: fields } }
    input_schema:
      type: object
      properties:
        fields: { type: object, properties: { title: { type: string }, pages: { type: integer } } }
        attachment: { type: string, format: uuid }
      required: [fields, attachment]
    files: [{ at: /attachment, send: multipart, media_types: [application/pdf] }]
`,
    },
    { file: 'roles.yaml', text: (roles as { text: string }).text.replace(OPERATION, MP_OPERATION) },
  ];
}

describe('CONN-9 a multipart file reaches the upstream as approved', () => {
  let up: FakeUpstream;
  let configuration: LoadedConfiguration;
  let worker: TestWorker;
  let store: PostgresFileStore;

  beforeEach(async () => {
    up = await startFakeUpstream();
    up.route('POST', '/rest/V1/attachments', () => ({ status: 201, body: { id: 9 } }));
    store = new PostgresFileStore(infra.database.db);
    const adapter = createAdapters();
    const loaded = await loadConfigurationSources(multipartSources(up.url), { resolver: adapter.resolver });
    if (!loaded.ok) throw new Error(`configuration invalid: ${JSON.stringify(loaded.issues)}`);
    configuration = loaded.configuration;
    const vault = new MemoryVault();
    await vault.put({ ref: CREDENTIAL_REF, scheme: 'bearer', secret: { token: FAKE_TOKEN }, actor: 'test' });
    const guard = createExecutionGuard({ repository: infra.repository, audit: infra.audit, newId: randomUUID, files: store })(configuration);
    worker = await startTestWorker(infra, { configuration, writerFor: createWriterFor({ vault, adapter, files: store }), guard, settingsFor: executionSettings });
  });
  afterEach(async () => {
    await worker.stop();
    await up.close();
  });

  it('CONN-9 the upstream receives one multipart request with the text fields and the file part, byte for byte', async () => {
    const fileId = randomUUID();
    const staged = await store.stage(
      { id: fileId, owner: 'alice', name: NAME, mediaType: 'application/pdf', content: BYTES, sha256: sha256Of(BYTES), preview: 'none', createdAt: new Date(), quota: { count: 100, bytes: 100_000_000 } },
      { id: randomUUID(), actor: 'alice', action: 'file.staged', outcome: 'ok', correlationId: randomUUID(), details: {} },
    );
    if (!staged.ok) throw new Error('file not staged');
    const operation = configuration.policy.operations.find((o) => o.id === MP_OPERATION);
    if (operation === undefined) throw new Error('operation missing');
    const created = await createChangeSet(
      { repository: infra.repository, newId: randomUUID, now: () => new Date(), files: store },
      {
        operation,
        args: { fields: { title: 'Q3 report', pages: 12 }, attachment: fileId },
        caller: { subject: 'alice', groups: [EDITOR_GROUP] },
        correlationId: `corr-create-${randomUUID()}`,
        configHash: configuration.hash,
        expireAfterHours: 1,
      },
    );
    if (!created.ok) throw new Error(`change-set not created: ${created.code}`);
    const { id } = created.changeset;
    await worker.starter.start(id);
    await expect.poll(async () => (await infra.repository.get(id))?.status, { timeout: 30_000 }).toBe('prepared');
    const hash = (await infra.repository.get(id))?.hash;
    if (hash === undefined) throw new Error('no hash');
    expect(await worker.executor.start({ changesetId: id, expectedHash: hash, actor: 'alice', groups: [EDITOR_GROUP], correlationId: `corr-exec-${randomUUID()}` })).toEqual({ ok: true });
    await worker.executor.settled(id);

    expect((await infra.repository.get(id))?.status).toBe('completed');
    expect(up.requests).toHaveLength(1);
    const request = up.requests[0];
    if (request === undefined) throw new Error('no request');
    expect(request.headers['content-type']).toMatch(/^multipart\/form-data; boundary=/);
    // eslint-disable-next-line @typescript-eslint/no-deprecated -- test-side parsing: Node's parser is the independent reader
    const form = await new Response(request.rawBody, { headers: { 'content-type': request.headers['content-type'] ?? '' } }).formData();
    expect([...form.keys()].sort()).toEqual(['attachment', 'pages', 'title']);
    expect(form.get('title')).toBe('Q3 report');
    expect(form.get('pages')).toBe('12');
    const file = form.get('attachment');
    if (!(file instanceof File)) throw new Error('attachment is not a file part');
    expect(file.name).toBe(NAME);
    expect(file.type).toBe('application/pdf');
    expect(Buffer.from(await file.arrayBuffer()).equals(Buffer.from(BYTES))).toBe(true);
  }, 60_000);
});
