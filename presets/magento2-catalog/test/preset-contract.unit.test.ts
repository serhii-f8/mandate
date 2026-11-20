/**
 * Tests of the preset contract helpers of @aiops/testing (NFR-17). They live here, not in
 * packages/testing: the helpers need the real adapter and loader, and @aiops/adapters and
 * @aiops/config dev-depend on @aiops/testing (a cycle). The fixture is the code fixture preset.
 */
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createOpenApiAdapter } from '@aiops/adapters';
import { loadConfigurationSources, type LoadedConfiguration } from '@aiops/config';
import type { ConnectionSettings } from '@aiops/connector-sdk';
import {
  CODE_FIXTURE_PRESET_DIR,
  contractRead,
  contractWrite,
  presetConnectionYaml,
  recordingsFreeOf,
  replayRecordings,
  startFakeUpstream,
  type FakeUpstream,
} from '@aiops/testing';

const adapter = createOpenApiAdapter();

async function recordingsDir(files: Record<string, unknown>): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'aiops-recordings-'));
  for (const [name, content] of Object.entries(files)) {
    await mkdir(dirname(join(dir, name)), { recursive: true });
    await writeFile(join(dir, name), JSON.stringify(content));
  }
  return dir;
}

describe('NFR-17 preset contract helpers', () => {
  let up: FakeUpstream;
  let config: LoadedConfiguration;

  beforeAll(async () => {
    up = await startFakeUpstream();
    const yaml = presetConnectionYaml({
      presetId: 'fixture',
      package: '@aiops/code-fixture-preset',
      connectionId: 'items',
      baseUrl: up.url,
    });
    const result = await loadConfigurationSources([{ file: 'config.yaml', text: yaml }], {
      resolver: adapter.resolver,
      presetDirs: [dirname(CODE_FIXTURE_PRESET_DIR)],
    });
    if (!result.ok) throw new Error(JSON.stringify(result.issues));
    config = result.configuration;
  });
  afterAll(async () => {
    await up.close();
  });

  const settings = (): ConnectionSettings => {
    const s = config.connectionSettings.get('items');
    if (s === undefined) throw new Error('no settings');
    return s;
  };

  it('NFR-17 presetConnectionYaml names the connection, preset, prefix and MCP URL key', () => {
    const yaml = presetConnectionYaml({ presetId: 'p', package: 'pkg', version: '^1', connectionId: 'c', adapter: 'mcp', baseUrl: 'http://x/mcp', operationPrefix: 'alt' });
    expect(yaml).toContain("version: '^1'");
    expect(yaml).toContain('mcp_url: http://x/mcp');
    expect(yaml).toContain('operation_prefix: alt');
    expect(yaml).toContain('credential_ref: c-token');
  });

  it('NFR-17 replayRecordings serves recorded exchanges and reports unexpected and unused ones', async () => {
    const dir = await recordingsDir({
      'one.json': { request: { method: 'GET', path: '/a', query: { q: '1' } }, response: { status: 200, body: { v: 1 } } },
      'two.json': {
        exchanges: [
          { request: { method: 'POST', path: '/b', body: { x: 1 } }, response: { status: 201 } },
          { request: { method: 'GET', path: '/never' }, response: { status: 200 } },
        ],
      },
    });
    const fake = await startFakeUpstream();
    try {
      const replayed = await replayRecordings(fake, dir, { basePath: '/api' });
      const get = (path: string): Promise<Response> => fetch(`${fake.url}${path}`);
      expect(await (await get('/api/a?q=1')).json()).toEqual({ v: 1 });
      expect((await fetch(`${fake.url}/api/b`, { method: 'POST', body: JSON.stringify({ x: 1 }) })).status).toBe(201);
      expect(replayed.unexpected).toEqual([]);
      // Wrong query, wrong body and an unrouted path are all unexpected.
      expect((await get('/api/a?q=2')).status).toBe(404);
      expect((await fetch(`${fake.url}/api/b`, { method: 'POST', body: JSON.stringify({ x: 2 }) })).status).toBe(404);
      expect((await get('/api/other')).status).toBe(404);
      expect(replayed.unexpected).toHaveLength(3);
      expect(() => {
        replayed.assertAllUsed();
      }).toThrow(/two\.json: GET \/never/);
    } finally {
      await fake.close();
    }
  });

  it('NFR-17 OPS-5 contractRead runs a code read against replayed exchanges', async () => {
    const dir = await recordingsDir({
      'item-1.json': { request: { method: 'GET', path: '/items/1' }, response: { status: 200, body: { id: '1', title: 'one', state: 'open', tags: [] } } },
    });
    const replayed = await replayRecordings(up, dir);
    const binding = config.bindings.get('fixture.get_many');
    if (binding?.kind !== 'code') throw new Error('fixture.get_many is not a code binding');
    const outcome = await contractRead({
      adapter,
      connection: settings(),
      binding,
      codeOperation: config.codeOperations.get('fixture.get_many'),
      args: { ids: ['1'], fields: ['id', 'title'] },
    });
    expect(outcome.ok).toBe(true);
    if (outcome.ok) expect(outcome.items).toEqual([{ id: '1', title: 'one' }]);
    expect(replayed.unexpected).toEqual([]);
    replayed.assertAllUsed();
  });

  it('NFR-17 OPS-6 contractWrite runs per-record and code writes and returns per-record outcomes', async () => {
    const dir = await recordingsDir({
      'patch-1.json': {
        request: { method: 'PATCH', path: '/items/1', body: { title: 'new' } },
        response: { status: 200, body: {} },
      },
      'patch-2.json': { request: { method: 'PATCH', path: '/items/2', body: { title: 'new' } }, response: { status: 503 } },
      'tags-1.json': { request: { method: 'PUT', path: '/items/1/tags', body: { tags: ['a'] } }, response: { status: 200, body: {} } },
      'tags-2.json': { request: { method: 'PUT', path: '/items/2/tags', body: { tags: ['a'] } }, response: { status: 400 } },
    });
    const replayed = await replayRecordings(up, dir);
    const perRecord = config.bindings.get('fixture.update');
    const code = config.bindings.get('fixture.set_tags');
    if (perRecord?.kind !== 'http' || code?.kind !== 'code') throw new Error('unexpected binding kinds');
    const http = await contractWrite({
      adapter,
      connection: settings(),
      binding: perRecord,
      records: [
        { id: '1', title: 'new' },
        { id: '2', title: 'new' },
      ],
      args: {},
    });
    expect(http).toEqual(['ok', 'retriable']);
    const viaCode = await contractWrite({
      adapter,
      connection: settings(),
      binding: code,
      codeOperation: config.codeOperations.get('fixture.set_tags'),
      records: [
        { id: '1', tags: ['a'] },
        { id: '2', tags: ['a'] },
      ],
      args: {},
    });
    expect(viaCode).toEqual(['ok', 'failed']);
    expect(replayed.unexpected).toEqual([]);
    replayed.assertAllUsed();
  });

  it('NFR-17 recordingsFreeOf fails on a planted token', async () => {
    const clean = await recordingsDir({ 'a.json': { v: 1 }, 'sub/b.json': { v: 2 } });
    await recordingsFreeOf(clean, ['planted-secret']);
    const dirty = await recordingsDir({ 'a.json': { v: 1 }, 'sub/b.json': { header: 'planted-secret' } });
    await expect(recordingsFreeOf(dirty, ['planted-secret'])).rejects.toThrow(/sub.b\.json contains a secret/);
  });
});
