// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Mandate Authors
/**
 * Contract test of the preset template (NFR-17, CONN-8). The preset is loaded the way the api loads
 * it, with the OpenAPI adapter's resolver over the vendored spec; recordings pin the request the
 * preset must send and the response it must map. Copy this file with the preset and adapt the cases.
 */
import { readFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createOpenApiAdapter } from '@mandate/adapters';
import { loadConfigurationSources, type HttpOperationBinding, type LoadedConfiguration } from '@mandate/config';
import type { ConnectionSettings } from '@mandate/connector-sdk';
import { contractRead, contractWrite, presetConnectionYaml, recordingsFreeOf, replayRecordings, startFakeUpstream, type FakeUpstream } from '@mandate/testing';

const PRESET_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const RECORDINGS = join(PRESET_DIR, 'test', 'recordings');

interface ReadCase {
  readonly name: string;
  readonly args: Readonly<Record<string, unknown>>;
  readonly ids: readonly string[];
}
const READ_CASES: readonly ReadCase[] = [
  { name: 'search-by-ids', args: { ids: ['n1', 'n2'], fields: ['id', 'title'] }, ids: ['n1', 'n2'] },
  { name: 'search-by-title', args: { q: 'Kick', fields: ['id', 'title'] }, ids: ['n1'] },
];

/** The preset bound to connection `notes`, loaded with the real resolver (CONN-8). */
async function loadPreset(baseUrl: string): Promise<LoadedConfiguration> {
  const config = presetConnectionYaml({
    presetId: 'notes',
    package: '@mandate-examples/preset-template',
    version: '1.4.0',
    connectionId: 'notes',
    baseUrl,
    credentialRef: 'notes-token',
  });
  const result = await loadConfigurationSources([{ file: 'config.yaml', text: config }], {
    resolver: createOpenApiAdapter().resolver,
    presetDirs: [resolve(PRESET_DIR, '..')],
  });
  if (!result.ok) throw new Error(`preset did not load: ${JSON.stringify(result.issues)}`);
  return result.configuration;
}

function bindingOf(config: LoadedConfiguration, operation: string): HttpOperationBinding {
  const binding = config.bindings.get(operation);
  if (binding?.kind !== 'http') throw new Error(`no HTTP binding for ${operation}`);
  return binding;
}

function settingsOf(config: LoadedConfiguration): ConnectionSettings {
  const settings = config.connectionSettings.get('notes');
  if (settings === undefined) throw new Error('no settings for connection notes');
  return settings;
}

describe('NFR-17 preset template contract', () => {
  let upstream: FakeUpstream;
  let config: LoadedConfiguration;

  beforeAll(async () => {
    upstream = await startFakeUpstream();
    config = await loadPreset(upstream.url);
  });
  afterAll(async () => {
    await upstream.close();
  });

  it('NFR-17 CONN-8 the preset loads against its vendored spec: a read, an update, a create, a delete and an attachment upload, bearer auth', () => {
    expect(config.policy.operations.map((o) => o.id).sort()).toEqual(['notes.attach', 'notes.create', 'notes.delete', 'notes.search', 'notes.update_title']);
    const write = config.policy.operations.find((o) => o.id === 'notes.update_title');
    expect(write?.risk).toBe('write');
    expect(write?.manifest).toMatchObject({
      idField: 'id',
      idsArg: 'ids',
      valuesArg: 'changes',
      readBefore: { operation: 'notes.search', idsArg: 'ids' },
      rollback: { strategy: 'replay_previous_state' },
    });
    expect(settingsOf(config).auth).toEqual({ scheme: 'bearer' });
    expect(config.connectionTests.get('notes')?.operation).toBe('notes.search');
  });

  it('NFR-17 OPS-2 notes.create and notes.delete declare their action, records or ids, and each other as inverse', () => {
    const create = config.policy.operations.find((o) => o.id === 'notes.create');
    expect(create?.risk).toBe('write');
    expect(create?.manifest).toMatchObject({
      action: 'create',
      idField: 'id',
      recordsArg: 'notes',
      fields: ['title', 'body'],
      requiredFields: ['title'],
      readBefore: { operation: 'notes.search', idsArg: 'ids' },
      batchSize: 100,
      maxTargets: 1000,
      rollback: { strategy: 'inverse_operation', operation: 'notes.delete' },
    });
    const del = config.policy.operations.find((o) => o.id === 'notes.delete');
    expect(del?.risk).toBe('destructive');
    expect(del?.manifest).toMatchObject({
      action: 'delete',
      idField: 'id',
      idsArg: 'ids',
      fields: ['title', 'body'],
      readBefore: { operation: 'notes.search', idsArg: 'ids' },
      batchSize: 100,
      maxTargets: 1000,
      rollback: { strategy: 'inverse_operation', operation: 'notes.create' },
    });
  });

  it('NFR-17 OPS-8 CS-10 notes.attach is an opaque write whose content is a staged file, sent as base64', () => {
    const attach = config.policy.operations.find((o) => o.id === 'notes.attach');
    expect(attach?.risk).toBe('write_opaque');
    expect(attach?.files).toEqual([
      { pointer: '/content', path: ['content'], send: 'base64', mediaTypes: ['text/csv', 'image/png'], maxBytes: 10_485_760 },
    ]);
    const validate = config.validators.get('notes.attach');
    expect(validate?.({ note_id: 'n1', content: '3f2b1c9e-8a4d-4e6f-9b1a-2c3d4e5f6a7b' }).ok).toBe(true);
    expect(validate?.({ note_id: 'n1', content: 'not-an-id' }).ok).toBe(false);
    expect(validate?.({ note_id: 'n1' }).ok).toBe(false);
  });

  it('NFR-17 CS-3 notes.update_title carries the empty_title check: a note without a title is excluded with that code', () => {
    const update = config.policy.operations.find((o) => o.id === 'notes.update_title');
    expect(update?.manifest?.checks).toEqual([
      { code: 'empty_title', title: 'The note has no title yet', require: [{ present: { before: 'title' } }] },
    ]);
  });

  it('NFR-17 OPS-2 the create input takes closed records with an id and a title; the delete input takes ids', () => {
    const create = config.validators.get('notes.create');
    expect(create?.({ notes: [{ id: 'n1', title: 'A' }, { id: 'n2', title: 'B', body: 'text' }] }).ok).toBe(true);
    expect(create?.({ notes: [] }).ok).toBe(false);
    expect(create?.({ notes: [{ id: 'n1' }] }).ok).toBe(false);
    expect(create?.({ notes: [{ id: 'n1', title: 'A', extra: 1 }] }).ok).toBe(false);
    expect(create?.({}).ok).toBe(false);
    const del = config.validators.get('notes.delete');
    expect(del?.({ ids: ['n1'] }).ok).toBe(true);
    expect(del?.({ ids: [] }).ok).toBe(false);
    expect(del?.({ ids: ['a,b'] }).ok).toBe(false);
    expect(del?.({ ids: ['n1'], extra: 1 }).ok).toBe(false);
  });

  it('NFR-17 OPS-2 input schemas refuse unknown fields and fields outside the enum', () => {
    const search = config.validators.get('notes.search');
    expect(search?.({ fields: ['id'] }).ok).toBe(true);
    expect(search?.({ fields: ['secret'] }).ok).toBe(false);
    expect(search?.({ fields: ['id'], extra: 1 }).ok).toBe(false);
    const update = config.validators.get('notes.update_title');
    expect(update?.({ ids: ['n1'], changes: { title: 'x' } }).ok).toBe(true);
    expect(update?.({ ids: ['n1'], changes: {} }).ok).toBe(false);
    expect(update?.({ ids: ['n1'], changes: { body: 'x' } }).ok).toBe(false);
    expect(update?.({ ids: ['a,b'], changes: { title: 'x' } }).ok).toBe(false);
  });

  it('NFR-17 every read case is recorded and its arguments are valid input', () => {
    for (const c of READ_CASES) expect(config.validators.get('notes.search')?.(c.args).ok, c.name).toBe(true);
  });

  describe('replay through the adapter', () => {
    let replayed: Awaited<ReturnType<typeof replayRecordings>>;
    let replayedWrite: Awaited<ReturnType<typeof replayRecordings>>;

    beforeAll(async () => {
      replayed = await replayRecordings(upstream, RECORDINGS);
      replayedWrite = await replayRecordings(upstream, join(RECORDINGS, 'write'));
    });
    afterAll(() => {
      replayed.assertAllUsed();
      replayedWrite.assertAllUsed();
    });

    it.each(READ_CASES)('NFR-17 $name: the adapter sends the recorded request and maps the recorded response', async (c) => {
      const outcome = await contractRead({
        adapter: createOpenApiAdapter(),
        connection: settingsOf(config),
        binding: bindingOf(config, 'notes.search'),
        args: c.args,
      });
      expect(replayed.unexpected).toEqual([]);
      expect(outcome.ok).toBe(true);
      if (!outcome.ok) return;
      const items = outcome.items ?? [];
      expect(items.map((i) => i.id)).toEqual(c.ids);
      // Projection keeps exactly the requested fields (POL-3): body and updated_at are not returned.
      for (const item of items) expect(Object.keys(item).sort()).toEqual(['id', 'title']);
    });

    it('NFR-17 OPS-6 notes.update_title sends one PATCH per record with the record minus its id', async () => {
      const outcomes = await contractWrite({
        adapter: createOpenApiAdapter(),
        connection: settingsOf(config),
        binding: bindingOf(config, 'notes.update_title'),
        records: [{ id: 'n1', title: 'Kickoff v2' }],
        args: {},
      });
      expect(replayedWrite.unexpected).toEqual([]);
      expect(outcomes).toEqual(['ok']);
    });

    it('NFR-17 OPS-6 notes.create sends one POST /notes per record with the record as body', async () => {
      const outcomes = await contractWrite({
        adapter: createOpenApiAdapter(),
        connection: settingsOf(config),
        binding: bindingOf(config, 'notes.create'),
        records: [{ id: 'n3', title: 'Retro', body: 'Notes of the retro' }],
        args: {},
      });
      expect(replayedWrite.unexpected).toEqual([]);
      expect(outcomes).toEqual(['ok']);
    });

    it('NFR-17 OPS-6 notes.delete sends one DELETE /notes/{id} per record', async () => {
      const outcomes = await contractWrite({
        adapter: createOpenApiAdapter(),
        connection: settingsOf(config),
        binding: bindingOf(config, 'notes.delete'),
        records: [{ id: 'n1' }],
        args: {},
      });
      expect(replayedWrite.unexpected).toEqual([]);
      expect(outcomes).toEqual(['ok']);
    });
  });

  it('NFR-17 SEC-3 no recording or the vendored spec contains a token', async () => {
    await recordingsFreeOf(RECORDINGS, ['eyJ', '"authorization"']);
    const spec = await readFile(join(PRESET_DIR, 'spec', 'notes.openapi.json'), 'utf8');
    expect(spec).not.toContain('eyJ');
  });
});
