// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Mandate Authors
/**
 * The title update of the preset template through `changesetWorkflow` on a real Temporal test server
 * and PostgreSQL, with the production reader and writers against a fake notes upstream: its
 * `verify_after` reads the notes again and confirms every item whose title shows the written value
 * (NFR-17, EXE-12, ADR 0073).
 */
import { randomUUID } from 'node:crypto';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createOpenApiAdapter } from '@mandate/adapters';
import { loadConfigurationSources, type LoadedConfiguration } from '@mandate/config';
import { createChangeSet, type ChangeSetRecord } from '@mandate/core';
import { presetConnectionYaml, recordApproval, startFakeUpstream, submitChangeSet, type FakeUpstream } from '@mandate/testing';
import { createUpstreamReader } from '@mandate/upstream';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createRollbackWriterFor, createWriterFor } from '../../src/writers.js';
import { startInfrastructure, startTestWorker, type Infra, type TestWorker } from '../support/harness.js';
import { MemoryVault } from '../support/magento.js';

const EXAMPLES_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '../../../../examples');
const CREDENTIAL_REF = 'notes-token';
const EDITORS = 'editors';
const REVIEWERS = 'reviewers';

/** `editor` needs one `reviewer` approval for every change-set. */
const ROLES = `version: 1
roles:
  - id: editor
    grants:
      - operation: notes.update_title
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

describe('NFR-17 EXE-12 the template preset verifies after its write', () => {
  let up: FakeUpstream;
  let notes: Map<string, Note>;
  let configuration: LoadedConfiguration;
  let worker: TestWorker;

  beforeEach(async () => {
    notes = new Map([
      ['n1', { id: 'n1', title: 'Kickoff', body: 'Agenda' }],
      ['n2', { id: 'n2', title: 'Retro' }],
    ]);
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
    up.routeMatch('PATCH', /^\/notes\/[^/]+$/, (req) => {
      const id = decodeURIComponent(req.path.slice('/notes/'.length));
      const note = notes.get(id);
      if (note === undefined) return { status: 404, body: { error: 'not found' } };
      const updated = { ...note, ...(JSON.parse(req.body) as Partial<Note>) };
      notes.set(id, updated);
      return { status: 200, body: updated };
    });
    configuration = await loadTemplate(up.url);
    const vault = new MemoryVault();
    await vault.put({ ref: CREDENTIAL_REF, scheme: 'bearer', secret: { token: 'verify-test-only-token' }, actor: 'test' });
    const adapter = createOpenApiAdapter();
    worker = await startTestWorker(infra, {
      configuration,
      writerFor: createWriterFor({ vault, adapter }),
      rollbackWriterFor: createRollbackWriterFor({ vault, adapter }),
      readerFor: (current, correlationId) => createUpstreamReader({ configuration: current, vault, adapter, correlationId }),
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

  it('NFR-17 EXE-12 the title update ends completed with every item confirmed once the upstream shows the new title', async () => {
    const operation = configuration.policy.operations.find((o) => o.id === 'notes.update_title');
    const manifest = operation?.manifest;
    if (operation === undefined || manifest === undefined) throw new Error('notes.update_title missing');
    expect(manifest.verifyAfter).toBeDefined();
    const created = await createChangeSet(
      { repository: infra.repository, newId: randomUUID, now: () => new Date() },
      {
        operation: { ...operation, manifest },
        args: { ids: ['n1', 'n2'], changes: { title: 'Renamed' } },
        caller: { subject: 'alice', groups: [EDITORS] },
        correlationId: `corr-verify-${randomUUID()}`,
        configHash: configuration.hash,
        expireAfterHours: 1,
      },
    );
    if (!created.ok) throw new Error(`change-set not created: ${created.code}`);
    const id = created.changeset.id;
    await worker.starter.start(id);
    await expect.poll(async () => (await load(id)).status, { timeout: 30_000 }).toBe('prepared');
    const prepared = await load(id);

    const submitted = await submitChangeSet(infra.repository, prepared, { steps: ['reviewer'], groups: [EDITORS] });
    await worker.executor.wake(id);
    const approved = await recordApproval(infra.repository, submitted, { approver: 'rita' });
    if (approved.hash === undefined) throw new Error('approved change-set has no hash');
    const started = await worker.executor.start({
      changesetId: id,
      expectedHash: approved.hash,
      actor: 'rita',
      groups: [REVIEWERS],
      correlationId: `corr-exec-${randomUUID()}`,
      requester: { subject: 'alice', groups: [EDITORS] },
    });
    expect(started).toEqual({ ok: true });

    await expect
      .poll(async () => {
        const cs = await load(id);
        return [cs.status, cs.rollbackUntil !== undefined];
      }, { timeout: 60_000 })
      .toEqual(['completed', true]);
    const items = await infra.repository.itemsPage(id, { limit: 500 });
    expect(items.map((i) => [i.targetId, i.status, i.verificationStatus])).toEqual([
      ['n1', 'written', 'confirmed'],
      ['n2', 'written', 'confirmed'],
    ]);
    expect([...notes.values()].map((n) => n.title)).toEqual(['Renamed', 'Renamed']);
  }, 120_000);
});
