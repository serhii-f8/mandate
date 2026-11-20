/**
 * Contract tests of the Gitea issues preset (NFR-17, CONN-8; design phase-9-mcp-upstream-gitea).
 * The preset is loaded the way the api loads it: `@aiops/config` with the OpenAPI adapter's
 * resolver over the vendored spec and the built code module (`aiops.code`, dist/index.js). The
 * sandbox recordings are replayed on a fake upstream under `/api/v1` and the loaded bindings run
 * through the real adapter. With GITEA_SANDBOX_URL and GITEA_SANDBOX_TOKEN set, the read cases
 * also run against the sandbox.
 */
import { readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createOpenApiAdapter } from '@aiops/adapters';
import { loadConfigurationSources, type LoadedConfiguration, type OperationBinding } from '@aiops/config';
import type { ConnectionSettings, CredentialSource } from '@aiops/connector-sdk';
import { contractRead, contractWrite, presetConnectionYaml, replayRecordings, startFakeUpstream, type FakeUpstream, type RecordedExchange } from '@aiops/testing';
import { PRESET_DIR } from '../src/index.js';

interface ReadCase {
  readonly name: string;
  readonly operation: string;
  readonly args: Readonly<Record<string, unknown>>;
  readonly exchanges: readonly RecordedExchange['request'][];
  readonly expect: { readonly numbers?: readonly number[]; readonly labels?: Readonly<Record<string, readonly string[]>> };
}

const BASE_PATH = '/api/v1';
const RECORDINGS = join(PRESET_DIR, 'test', 'recordings');
const WRITE_RECORDINGS = join(RECORDINGS, 'write');
const FAKE_TOKEN = 'contract-test-only-token';
const OPERATIONS = ['issues.comment', 'issues.get_many', 'issues.search', 'issues.set_labels', 'issues.update_fields'];

const readCases = (JSON.parse(await readFile(join(PRESET_DIR, 'test', 'cases.json'), 'utf8')) as ReadCase[]).filter((c) => c.operation.startsWith('issues.'));

async function writeRecording(name: string): Promise<RecordedExchange[]> {
  return (JSON.parse(await readFile(join(WRITE_RECORDINGS, `${name}.json`), 'utf8')) as { exchanges: RecordedExchange[] }).exchanges;
}

/** The preset bound to connection `gitea` (CONN-8); `extra` is appended to the configuration. */
async function loadPreset(baseUrl: string, extra?: string): Promise<LoadedConfiguration> {
  const yaml = presetConnectionYaml({
    presetId: 'gitea-issues',
    package: '@aiops/gitea-issues',
    version: '^0.1.0',
    connectionId: 'gitea',
    baseUrl,
    credentialRef: 'gitea-token',
    ...(extra === undefined ? {} : { extra }),
  });
  const result = await loadConfigurationSources([{ file: 'config.yaml', text: yaml }], {
    resolver: createOpenApiAdapter().resolver,
    presetDirs: [resolve(PRESET_DIR, '..')],
  });
  if (!result.ok) throw new Error(`preset did not load: ${JSON.stringify(result.issues)}`);
  return result.configuration;
}

function bindingOf(config: LoadedConfiguration, operation: string): OperationBinding {
  const binding = config.bindings.get(operation);
  if (binding === undefined) throw new Error(`no binding for ${operation}`);
  return binding;
}

function httpBindingOf(config: LoadedConfiguration, operation: string): Extract<OperationBinding, { kind: 'http' }> {
  const binding = bindingOf(config, operation);
  if (binding.kind !== 'http') throw new Error(`${operation} is not an HTTP binding`);
  return binding;
}

function codeBindingOf(config: LoadedConfiguration, operation: string): Extract<OperationBinding, { kind: 'code' }> {
  const binding = bindingOf(config, operation);
  if (binding.kind !== 'code') throw new Error(`${operation} is not a code binding`);
  return binding;
}

function settingsOf(config: LoadedConfiguration): ConnectionSettings {
  const settings = config.connectionSettings.get('gitea');
  if (settings === undefined) throw new Error('no settings for connection gitea');
  return settings;
}

const bearer = (token: string): CredentialSource => ({ ref: 'gitea-token', scheme: 'bearer', open: () => Promise.resolve({ token }) });

/** Runs one read case through the loaded code read. */
async function runRead(config: LoadedConfiguration, c: ReadCase, token: string): Promise<readonly Record<string, unknown>[]> {
  const binding = codeBindingOf(config, c.operation);
  const outcome = await contractRead({
    adapter: createOpenApiAdapter(),
    connection: settingsOf(config),
    binding,
    codeOperation: config.codeOperations.get(c.operation),
    args: c.args,
    credential: bearer(token),
  });
  expect(outcome.ok, outcome.ok ? '' : `${outcome.code} ${outcome.message}`).toBe(true);
  return outcome.ok ? (outcome.items ?? []) : [];
}

function expectCase(c: ReadCase, items: readonly Record<string, unknown>[]): void {
  expect(items.map((i) => i.number)).toEqual(c.expect.numbers);
  const fields = c.args.fields as string[];
  // Projection keeps exactly the requested fields (POL-3).
  for (const item of items) expect(Object.keys(item).sort()).toEqual([...fields].sort());
  for (const [n, labels] of Object.entries(c.expect.labels ?? {})) {
    expect(items.find((i) => String(i.number) === n)?.labels).toEqual(labels);
  }
}

describe('NFR-17 CONN-8 Gitea preset contract', () => {
  let config: LoadedConfiguration;

  beforeAll(async () => {
    config = await loadPreset(`http://gitea-sandbox.invalid${BASE_PATH}`);
  });

  it('CONN-8 loads from package.json aiops with SDK ^0.6.0 and registers five operations', async () => {
    const pkg = JSON.parse(await readFile(join(PRESET_DIR, 'package.json'), 'utf8')) as { aiops: Record<string, string> };
    expect(pkg.aiops).toEqual({ preset: 'preset.yaml', sdk: '^0.6.0', code: 'dist/index.js' });
    expect(config.loadedPresets.get('gitea-issues')).toMatchObject({ package: '@aiops/gitea-issues', version: '0.1.0', adapter: 'openapi' });
    expect(config.loadedPresets.get('gitea-issues')?.codeDigest).toMatch(/^[0-9a-f]{64}$/);
    const risks = Object.fromEntries(config.policy.operations.map((o) => [o.id, o.risk]));
    expect(Object.keys(risks).sort()).toEqual(OPERATIONS);
    expect(risks).toEqual({
      'issues.search': 'read',
      'issues.get_many': 'read',
      'issues.update_fields': 'write',
      'issues.set_labels': 'write',
      'issues.comment': 'write_opaque',
    });
    for (const op of config.policy.operations) expect(op.source).toBe('preset:gitea-issues');
    expect(settingsOf(config).auth).toEqual({ scheme: 'bearer' });
    expect(config.connectionTests.has('gitea')).toBe(false);
    expect(bindingOf(config, 'issues.search')).toMatchObject({ kind: 'code', name: 'search_issues' });
    expect(bindingOf(config, 'issues.get_many')).toMatchObject({ kind: 'code', name: 'get_issues' });
    expect(bindingOf(config, 'issues.set_labels')).toMatchObject({ kind: 'code', name: 'set_labels' });
    expect(config.codeOperations.get('issues.search')?.kind).toBe('read');
    expect(config.codeOperations.get('issues.set_labels')?.kind).toBe('write');
    expect(bindingOf(config, 'issues.update_fields')).toMatchObject({
      kind: 'http',
      mapping: { method: 'PATCH', path: '/repos/{owner}/{repo}/issues/{index}' },
    });
    expect(bindingOf(config, 'issues.comment')).toMatchObject({
      kind: 'http',
      mapping: { method: 'POST', path: '/repos/{owner}/{repo}/issues/{index}/comments' },
    });
  });

  it('CONN-7 the README connection test loads: a code read with fields', async () => {
    const withTest = await loadPreset(
      `http://gitea-sandbox.invalid${BASE_PATH}`,
      '    test: { operation: issues.search, args: { owner: acme, repo: website, fields: [number], limit: 1 } }',
    );
    expect(withTest.connectionTests.get('gitea')).toEqual({
      operation: 'issues.search',
      args: { owner: 'acme', repo: 'website', fields: ['number'], limit: 1 },
    });
  });

  it('NFR-17 input schemas refuse label names with commas or control characters and enforce exactly one target selector', () => {
    const search = config.validators.get('issues.search');
    expect(search?.({ owner: 'acme', repo: 'website', fields: ['number'], labels: ['bug'] }).ok).toBe(true);
    expect(search?.({ owner: 'acme', repo: 'website', fields: ['number'], labels: ['bug,docs'] }).ok).toBe(false);
    expect(search?.({ owner: 'acme', repo: 'website', fields: ['number'], labels: ['bu\ng'] }).ok).toBe(false);
    expect(search?.({ owner: 'acme', repo: 'website', fields: ['body'] }).ok).toBe(false);
    expect(search?.({ owner: 'acme', repo: 'website', fields: ['number'], limit: 51 }).ok).toBe(false);
    expect(search?.({ owner: 'acme', repo: '../x', fields: ['number'] }).ok).toBe(false);
    const getMany = config.validators.get('issues.get_many');
    expect(getMany?.({ owner: 'acme', repo: 'website', numbers: ['1'], fields: ['number'] }).ok).toBe(true);
    expect(getMany?.({ owner: 'acme', repo: 'website', numbers: [1], fields: ['number'] }).ok).toBe(false);
    expect(getMany?.({ owner: 'acme', repo: 'website', numbers: ['01'], fields: ['number'] }).ok).toBe(false);

    const labels = config.validators.get('issues.set_labels');
    const base = { owner: 'acme', repo: 'website' };
    expect(labels?.({ ...base, numbers: ['30'], changes: { labels: ['bug'] } }).ok).toBe(true);
    expect(labels?.({ ...base, with_labels: ['triage'], changes: { labels: [] } }).ok).toBe(true);
    expect(labels?.({ ...base, numbers: ['30'], changes: { labels: ['a,b'] } }).ok).toBe(false);
    expect(labels?.({ ...base, numbers: ['30'], changes: { labels: ['a\u0007'] } }).ok).toBe(false);
    expect(labels?.({ ...base, with_labels: ['a,b'], changes: { labels: [] } }).ok).toBe(false);
    expect(labels?.({ ...base, changes: { labels: [] } }).ok).toBe(false);
    expect(labels?.({ ...base, numbers: ['30'], with_labels: ['bug'], changes: { labels: [] } }).ok).toBe(false);

    const update = config.validators.get('issues.update_fields');
    expect(update?.({ ...base, numbers: ['30'], changes: { title: 'x' } }).ok).toBe(true);
    expect(update?.({ ...base, with_labels: ['bug'], changes: { state: 'closed' } }).ok).toBe(true);
    expect(update?.({ ...base, numbers: ['30'], changes: {} }).ok).toBe(false);
    expect(update?.({ ...base, numbers: ['30'], changes: { body: 'x' } }).ok).toBe(false);
    expect(update?.({ ...base, with_labels: ['b,c'], changes: { title: 'x' } }).ok).toBe(false);
    expect(update?.({ ...base, numbers: ['30'], with_labels: ['bug'], changes: { title: 'x' } }).ok).toBe(false);

    const comment = config.validators.get('issues.comment');
    expect(comment?.({ ...base, number: 30, comment: { body: 'hi' } }).ok).toBe(true);
    expect(comment?.({ ...base, number: 0, comment: { body: 'hi' } }).ok).toBe(false);
    expect(comment?.({ ...base, number: 30, comment: { body: '' } }).ok).toBe(false);
    // No combinator at the root (ADR 0026).
    for (const op of config.policy.operations) {
      for (const k of ['anyOf', 'oneOf', 'allOf', 'not']) expect(op.inputSchema).not.toHaveProperty(k);
    }
  });

  it('OPS-2 OPS-3 both manifests load with replay_previous_state, read_before issues.get_many and the with_labels selector', () => {
    const common = {
      idField: 'number',
      idsArg: 'numbers',
      valuesArg: 'changes',
      batchSize: 50,
      maxTargets: 500,
      scopeArgs: { owner: 'owner', repo: 'repo' },
      readBefore: { operation: 'issues.get_many', idsArg: 'numbers' },
      selector: { operation: 'issues.search', pageArg: 'page', pageSizeArg: 'limit', pageSize: 50 },
      rollback: { strategy: 'replay_previous_state' },
    };
    const manifestOf = (id: string): unknown => config.policy.operations.find((o) => o.id === id)?.manifest;
    expect(manifestOf('issues.update_fields')).toMatchObject({ ...common, fields: ['title', 'state'] });
    expect(manifestOf('issues.update_fields')).not.toHaveProperty('write');
    expect(manifestOf('issues.set_labels')).toMatchObject({ ...common, fields: ['labels'], write: { carryFields: ['owner', 'repo'] } });
    for (const id of ['issues.update_fields', 'issues.set_labels']) {
      const m = manifestOf(id) as { readBefore: { args: unknown }; selector: { args: unknown } };
      expect(m.readBefore.args).toEqual({ owner: { arg: 'owner' }, repo: { arg: 'repo' } });
      expect(m.selector.args).toEqual({ owner: { arg: 'owner' }, repo: { arg: 'repo' }, labels: { arg: 'with_labels' }, state: 'open' });
    }
  });

  it('POL-2 a grant scope on owner and repo is accepted for all five operations', async () => {
    const grants = OPERATIONS.map((op) => `      - { operation: ${op}, scope: { owner: [acme], repo: [website] } }`).join('\n');
    const scoped = await loadPreset(`http://gitea-sandbox.invalid${BASE_PATH}`, `roles:\n  - id: triager\n    grants:\n${grants}\n    approval: { steps: [{ role: triager }] }`);
    expect(scoped.policy.operations.map((o) => o.id).sort()).toEqual(OPERATIONS);
  });

  describe('NFR-17 replay through the loaded preset (fake upstream)', () => {
    let reads: FakeUpstream;
    let writes: FakeUpstream;
    let readConfig: LoadedConfiguration;
    let writeConfig: LoadedConfiguration;
    let readReplay: Awaited<ReturnType<typeof replayRecordings>>;
    let writeReplay: Awaited<ReturnType<typeof replayRecordings>>;

    beforeAll(async () => {
      reads = await startFakeUpstream();
      writes = await startFakeUpstream();
      readConfig = await loadPreset(`${reads.url}${BASE_PATH}`);
      writeConfig = await loadPreset(`${writes.url}${BASE_PATH}`);
      readReplay = await replayRecordings(reads, RECORDINGS, { basePath: BASE_PATH });
      writeReplay = await replayRecordings(writes, WRITE_RECORDINGS, { basePath: BASE_PATH });
    });
    afterAll(async () => {
      expect(readReplay.unexpected).toEqual([]);
      expect(writeReplay.unexpected).toEqual([]);
      await reads.close();
      await writes.close();
    });

    it.each(readCases)('NFR-17 issues.search and issues.get_many replay their recordings through the code module: $name', async (c) => {
      const before = reads.requests.length;
      const items = await runRead(readConfig, c, FAKE_TOKEN);
      const sent = reads.requests.slice(before);
      expect(readReplay.unexpected).toEqual([]);
      expect(sent.map((r) => `${r.method} ${r.path}`)).toEqual(c.exchanges.map((e) => `${e.method} ${BASE_PATH}${e.path}`));
      for (const r of sent) expect(r.headers.authorization).toBe(`Bearer ${FAKE_TOKEN}`);
      expectCase(c, items);
    });

    it('OPS-6 update_fields builds the recorded per-record PATCH', async () => {
      const [recorded] = await writeRecording('update-fields-30');
      const before = writes.requests.length;
      const outcomes = await contractWrite({
        adapter: createOpenApiAdapter(),
        connection: settingsOf(writeConfig),
        binding: httpBindingOf(writeConfig, 'issues.update_fields'),
        records: [{ number: 30, title: 'Website issue 30 (recorded)' }],
        args: { owner: 'acme', repo: 'website', numbers: ['30'], changes: { title: 'Website issue 30 (recorded)' } },
        credential: bearer(FAKE_TOKEN),
      });
      expect(outcomes).toEqual(['ok']);
      const sent = writes.requests.slice(before);
      expect(sent).toHaveLength(1);
      expect(sent[0]?.method).toBe('PATCH');
      expect(sent[0]?.path).toBe(`${BASE_PATH}/repos/acme/website/issues/30`);
      expect(JSON.parse(sent[0]?.body ?? 'null')).toEqual(recorded?.request.body);
      expect(recorded?.request.body).not.toHaveProperty('number');
      expect(sent[0]?.headers.authorization).toBe(`Bearer ${FAKE_TOKEN}`);
    });

    it('OPS-5 set_labels replays set-labels-30 through the loaded code writer', async () => {
      const recorded = await writeRecording('set-labels-30');
      const run = (labels: string[]): ReturnType<typeof contractWrite> =>
        contractWrite({
          adapter: createOpenApiAdapter(),
          connection: settingsOf(writeConfig),
          binding: codeBindingOf(writeConfig, 'issues.set_labels'),
          codeOperation: writeConfig.codeOperations.get('issues.set_labels'),
          records: [{ number: 30, labels, owner: 'acme', repo: 'website' }],
          args: { owner: 'acme', repo: 'website', numbers: ['30'], changes: { labels } },
          credential: bearer(FAKE_TOKEN),
        });
      let before = writes.requests.length;
      expect(await run(['bug', 'docs'])).toEqual(['ok']);
      let sent = writes.requests.slice(before);
      expect(sent.map((r) => `${r.method} ${r.path}`)).toEqual(recorded.map((e) => `${e.request.method} ${BASE_PATH}${e.request.path}`));
      expect(JSON.parse(sent[1]?.body ?? 'null')).toEqual(recorded[1]?.request.body);
      // An unknown name is refused after the label listing, with no PUT.
      before = writes.requests.length;
      expect(await run(['bug', 'no-such-label'])).toEqual(['failed']);
      sent = writes.requests.slice(before);
      expect(sent.map((r) => r.method)).toEqual(['GET']);
      expect(writeReplay.unexpected).toEqual([]);
    });

    it('NFR-17 issues.comment builds the recorded POST', async () => {
      const [recorded] = await writeRecording('comment-30');
      const binding = httpBindingOf(writeConfig, 'issues.comment');
      const before = writes.requests.length;
      const outcome = await createOpenApiAdapter().callOnce({
        connection: settingsOf(writeConfig),
        target: { kind: 'http', mapping: binding.mapping },
        args: { owner: 'acme', repo: 'website', number: 30, comment: { body: 'Recorded comment' } },
        credential: bearer(FAKE_TOKEN),
        beforeSend: () => Promise.resolve(),
      });
      expect(outcome).toMatchObject({ result: 'accepted', status: 201 });
      const sent = writes.requests.slice(before);
      expect(sent).toHaveLength(1);
      expect(`${sent[0]?.method ?? ''} ${sent[0]?.path ?? ''}`).toBe(`POST ${BASE_PATH}/repos/acme/website/issues/30/comments`);
      expect(JSON.parse(sent[0]?.body ?? 'null')).toEqual({ body: 'Recorded comment' });
      expect(recorded?.request.body).toEqual({ body: 'Recorded comment' });
    });
  });

  const liveUrl = process.env.GITEA_SANDBOX_URL;
  const liveToken = process.env.GITEA_SANDBOX_TOKEN;
  describe.runIf(liveUrl !== undefined && liveUrl !== '' && liveToken !== undefined && liveToken !== '')(
    'NFR-17 live against the Gitea sandbox (GITEA_SANDBOX_URL, GITEA_SANDBOX_TOKEN)',
    () => {
      let live: LoadedConfiguration;
      beforeAll(async () => {
        live = await loadPreset(`${(liveUrl ?? '').replace(/\/+$/, '')}${BASE_PATH}`);
      });

      it.each(readCases)('NFR-17 live $name', async (c) => {
        expectCase(c, await runRead(live, c, liveToken ?? ''));
      });
    },
  );
});
