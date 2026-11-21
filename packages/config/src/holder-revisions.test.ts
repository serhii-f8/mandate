// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The AI Operations Layer Authors
import { randomUUID } from 'node:crypto';
import { cp, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { UpstreamResolver } from '@aiops/connector-sdk';
import type { AuditEventInput, ConfigRevision } from '@aiops/core';
import { InMemoryAuditLog, InMemoryConfigRevisionStore } from '@aiops/testing';
import { ConfigurationHolder, ConfigurationUnavailableError, type ConfigurationLogger, type RevisionHolderOptions } from './holder.js';
import { loadConfigurationDirectory } from './load.js';
import { revisionFilesOf, revisionSummary } from './revision-files.js';

const VALID_DIR = fileURLToPath(new URL('../test/fixtures/valid', import.meta.url));
const FIXTURES = fileURLToPath(new URL('../test/fixtures', import.meta.url));
const EXTRA_ROLES = 'version: 1\nroles:\n  - id: content_manager\n    grants: []\n  - id: support_agent\n    grants: []\n  - id: extra\n    grants: []\n';
const BROKEN_ROLES = 'version: 1\nroles: nope\n';
const MISMATCH = 'f'.repeat(64);
const URL_SPEC_CONNECTIONS =
  'version: 1\nconnections:\n  - id: magento\n    adapter: openapi\n    base_url: https://shop.example.test/rest\n    credential_ref: magento-integration\n    auth: { scheme: bearer }\n    openapi: { spec: https://shop.example.test/openapi.json }\n';

/** A resolver whose next `failures` calls fail as a network fetch of the spec URL does; afterwards an empty catalog. */
class RecoveringResolver implements UpstreamResolver {
  failures = 0;
  calls = 0;
  resolveSpec(): ReturnType<UpstreamResolver['resolveSpec']> {
    this.calls += 1;
    if (this.failures > 0) {
      this.failures -= 1;
      return Promise.resolve({ ok: false, issues: [{ path: [], message: 'the spec URL could not be fetched (network)' }] });
    }
    return Promise.resolve({ ok: true, catalog: [] });
  }
}

interface LogCall {
  readonly level: 'debug' | 'info' | 'warn' | 'error';
  readonly fields: object;
  readonly message: string;
}

class RecordingLogger implements ConfigurationLogger {
  readonly calls: LogCall[] = [];
  debug(fields: object, message: string): void {
    this.calls.push({ level: 'debug', fields, message });
  }
  info(fields: object, message: string): void {
    this.calls.push({ level: 'info', fields, message });
  }
  warn(fields: object, message: string): void {
    this.calls.push({ level: 'warn', fields, message });
  }
  error(fields: object, message: string): void {
    this.calls.push({ level: 'error', fields, message });
  }
}

/** Store wrapper whose next `failReads` reads reject, and whose reads can be held on a gate. */
class FlakyStore extends InMemoryConfigRevisionStore {
  failReads = 0;
  seqReads = 0;
  activeReads = 0;
  gate: Promise<void> | undefined;

  override async activeSeq(): Promise<number | undefined> {
    this.seqReads += 1;
    if (this.gate !== undefined) {
      const gate = this.gate;
      this.gate = undefined;
      await gate;
    }
    if (this.failReads > 0) {
      this.failReads -= 1;
      throw new Error('connection refused');
    }
    return super.activeSeq();
  }

  override async active(): Promise<ConfigRevision | undefined> {
    this.activeReads += 1;
    if (this.failReads > 0) {
      this.failReads -= 1;
      throw new Error('connection refused');
    }
    return super.active();
  }
}

let dir: string;
let audit: InMemoryAuditLog;
let store: FlakyStore;
let logger: RecordingLogger;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'aiops-holder-rev-'));
  await cp(VALID_DIR, dir, { recursive: true });
  audit = new InMemoryAuditLog();
  store = new FlakyStore(new InMemoryAuditLog());
  logger = new RecordingLogger();
});

afterEach(async () => {
  await rm(dir, { recursive: true });
});

function options(overrides: Partial<RevisionHolderOptions> = {}): RevisionHolderOptions {
  return { store, fallbackDir: dir, load: {}, audit, service: 'api', newId: randomUUID, logger, ...overrides };
}

function loads(): AuditEventInput[] {
  return audit.events.filter((e) => e.action === 'config.load');
}

/** Files of the fixture directory with `file` (default `roles.yaml`) replaced, and their computed hash. */
async function filesWith(roles: string | undefined, file = 'roles.yaml'): Promise<{ files: Record<string, string>; hash: string | undefined }> {
  const copy = await mkdtemp(join(tmpdir(), 'aiops-holder-rev-src-'));
  try {
    await cp(VALID_DIR, copy, { recursive: true });
    if (roles !== undefined) await writeFile(join(copy, file), roles);
    const result = await loadConfigurationDirectory(copy);
    if (!result.ok) {
      const base = await loadConfigurationDirectory(VALID_DIR);
      if (!base.ok) throw new Error('fixture must load');
      const files = revisionFilesOf(base.configuration);
      if (!files.ok) throw new Error('fixture must be storable');
      return { files: { ...files.files, 'roles.yaml': roles ?? '' }, hash: undefined };
    }
    const files = revisionFilesOf(result.configuration);
    if (!files.ok) throw new Error('fixture must be storable');
    return { files: { ...files.files }, hash: result.configuration.hash };
  } finally {
    await rm(copy, { recursive: true });
  }
}

async function applyRevision(files: Record<string, string>, hash: string): Promise<ConfigRevision> {
  const previous = (await store.active())?.hash ?? null;
  const id = randomUUID();
  const result = await store.apply(
    { id, hash, files, actor: 'cli:test', summary: { connections: 0, operations: 0, roles: 0, notifications: 0 } },
    { id: randomUUID(), actor: 'cli:test', action: 'config.apply', outcome: 'ok', correlationId: randomUUID(), details: {} },
    previous,
  );
  if (!result.ok) throw new Error(`apply refused: ${result.reason}`);
  return result.revision;
}

async function dirHash(): Promise<string> {
  const result = await loadConfigurationDirectory(dir);
  if (!result.ok) throw new Error('fixture must load');
  return result.configuration.hash;
}

describe('CFG-4 AUD-1 configuration from revisions', () => {
  it('AUD-1 CONN-8 config.load details name the loaded presets and versions', async () => {
    const presetConfig = await mkdtemp(join(tmpdir(), 'aiops-holder-rev-preset-'));
    try {
      await cp(join(FIXTURES, 'with-preset'), presetConfig, { recursive: true });
      await ConfigurationHolder.fromRevisions(options({ fallbackDir: presetConfig, load: { presetDirs: [join(FIXTURES, 'preset-dir')] } }));
      expect(loads().map((e) => [e.outcome, e.details.presets])).toEqual([['ok', [{ id: 'fake', package: '@aiops/fake-preset', version: '0.1.0' }]]]);
    } finally {
      await rm(presetConfig, { recursive: true });
    }
  });

  it('CFG-4 an empty store is bootstrapped from the directory and loaded', async () => {
    const holder = await ConfigurationHolder.fromRevisions(options());
    const stored = await store.active();
    const hash = await dirHash();
    expect(stored).toMatchObject({ source: 'bootstrap', actor: 'system', hash, seq: 1 });
    expect(holder.state()).toEqual({ status: 'active', revision: stored?.id, hash });
    expect(holder.current.hash).toBe(hash);
    expect(loads()).toEqual([
      expect.objectContaining({ actor: 'system:api', outcome: 'ok', details: { revision: stored?.id, hash, service: 'api', trigger: 'start', presets: [] } }),
    ]);
    expect(loads()[0]?.subject).toBeUndefined();
    expect(logger.calls.filter((c) => c.message === 'configuration_files_differ')).toEqual([]);
  });

  it('CFG-4 the bootstrap stores the directory files and summary', async () => {
    await ConfigurationHolder.fromRevisions(options());
    const result = await loadConfigurationDirectory(dir);
    if (!result.ok) throw new Error('fixture must load');
    const files = revisionFilesOf(result.configuration);
    if (!files.ok) throw new Error('fixture must be storable');
    expect((await store.active())?.files).toEqual(files.files);
    expect((await store.active())?.summary).toEqual(revisionSummary(result.configuration));
  });

  it('CFG-4 an empty store and an invalid directory throw ConfigurationError and store nothing', async () => {
    await writeFile(join(dir, 'roles.yaml'), BROKEN_ROLES);
    const error = await ConfigurationHolder.fromRevisions(options()).catch((e: unknown) => e);
    expect(error).toMatchObject({ name: 'ConfigurationError', issues: [expect.objectContaining({ file: 'roles.yaml' })] });
    expect(await store.activeSeq()).toBeUndefined();
  });

  it('CFG-4 a store failure at start rejects', async () => {
    store.failReads = 1;
    await expect(ConfigurationHolder.fromRevisions(options())).rejects.toThrow('connection refused');
  });

  it('NFR-3 two holders starting together bootstrap one revision', async () => {
    const [a, b] = await Promise.all([ConfigurationHolder.fromRevisions(options()), ConfigurationHolder.fromRevisions(options({ service: 'worker' }))]);
    const stored = await store.active();
    expect(await store.activeSeq()).toBe(1);
    expect(a.state()).toEqual({ status: 'active', revision: stored?.id, hash: stored?.hash });
    expect(b.state()).toEqual(a.state());
    expect(loads().map((e) => e.actor).sort()).toEqual(['system:api', 'system:worker']);
  });

  it('CFG-3 a newer revision is loaded on notify; the same seq again is unchanged and not audited', async () => {
    const holder = await ConfigurationHolder.fromRevisions(options());
    const next = await filesWith(EXTRA_ROLES);
    if (next.hash === undefined) throw new Error('extra roles must load');
    const revision = await applyRevision(next.files, next.hash);

    expect(await holder.refresh('notify')).toEqual({ outcome: 'loaded', revision: revision.id, hash: next.hash });
    expect(holder.state()).toEqual({ status: 'active', revision: revision.id, hash: next.hash });
    expect(holder.current.policy.roles.map((r) => r.id)).toContain('extra');
    expect(loads().at(-1)).toMatchObject({ outcome: 'ok', details: { revision: revision.id, hash: next.hash, service: 'api', trigger: 'notify' } });

    expect(await holder.refresh('notify')).toEqual({ outcome: 'unchanged' });
    expect(await holder.refresh('poll')).toEqual({ outcome: 'unchanged' });
    expect(await holder.refresh('signal')).toEqual({ outcome: 'unchanged' });
    expect(loads()).toHaveLength(2);
  });

  it('CFG-3 an unchanged poll reads only the seq, not the files', async () => {
    const holder = await ConfigurationHolder.fromRevisions(options());
    let fileReads = 0;
    const active = store.active.bind(store);
    store.active = () => {
      fileReads += 1;
      return active();
    };
    expect(await holder.refresh('poll')).toEqual({ outcome: 'unchanged' });
    expect(fileReads).toBe(0);
  });

  it('CFG-2 an invalid newer revision keeps the previous configuration and audits error invalid', async () => {
    const holder = await ConfigurationHolder.fromRevisions(options());
    const before = holder.current;
    const state = holder.state();
    const broken = await filesWith(BROKEN_ROLES);
    const revision = await applyRevision(broken.files, 'a'.repeat(64));

    const result = await holder.refresh('notify');
    expect(result).toMatchObject({ outcome: 'refused', revision: revision.id, code: 'invalid', issues: [expect.objectContaining({ file: 'roles.yaml' })] });
    expect(holder.current).toBe(before);
    expect(holder.state()).toEqual(state);
    expect(loads().at(-1)).toMatchObject({
      outcome: 'error',
      details: { revision: revision.id, hash: 'a'.repeat(64), service: 'api', trigger: 'notify', code: 'invalid' },
    });
  });

  it('CFG-2 NFR-3 a revision whose stored hash differs from the computed one is refused with configuration_mismatch', async () => {
    const holder = await ConfigurationHolder.fromRevisions(options());
    const before = holder.current;
    const next = await filesWith(EXTRA_ROLES);
    const revision = await applyRevision(next.files, MISMATCH);

    const result = await holder.refresh('notify');
    expect(result).toMatchObject({ outcome: 'refused', revision: revision.id, code: 'configuration_mismatch' });
    expect(holder.current).toBe(before);
    expect(holder.state()).toMatchObject({ status: 'active', hash: before.hash });
    expect(loads().at(-1)).toMatchObject({
      outcome: 'error',
      details: { revision: revision.id, hash: MISMATCH, computedHash: next.hash, service: 'api', trigger: 'notify', code: 'configuration_mismatch' },
    });
  });

  it('CFG-2 CFG-3 AUD-1 a refused seq is retried on every poll, notify and signal, and audited once', async () => {
    const holder = await ConfigurationHolder.fromRevisions(options());
    const next = await filesWith(EXTRA_ROLES);
    await applyRevision(next.files, MISMATCH);
    expect(await holder.refresh('notify')).toMatchObject({ outcome: 'refused', code: 'configuration_mismatch' });
    const rows = loads().length;
    const fileReads = store.activeReads;

    for (let i = 0; i < 3; i += 1) expect(await holder.refresh('poll')).toMatchObject({ outcome: 'refused', code: 'configuration_mismatch', repeated: true });
    expect(await holder.refresh('notify')).toMatchObject({ outcome: 'refused', code: 'configuration_mismatch', repeated: true });
    expect(await holder.refresh('signal')).toMatchObject({ outcome: 'refused', code: 'configuration_mismatch', repeated: true });
    expect(store.activeReads).toBe(fileReads + 5);
    expect(loads()).toHaveLength(rows);
    const refusals = logger.calls.filter((c) => c.message === 'configuration revision refused');
    expect(refusals.map((c) => c.level)).toEqual(['error', 'debug', 'debug', 'debug', 'debug', 'debug']);
  });

  it('AUD-1 CFG-2 a permanently invalid revision polled many times yields exactly one audit row; a change of code or a load is audited', async () => {
    const holder = await ConfigurationHolder.fromRevisions(options());
    const broken = await filesWith(BROKEN_ROLES);
    const invalid = await applyRevision(broken.files, 'a'.repeat(64));
    const first = await holder.refresh('poll');
    expect(first).toMatchObject({ outcome: 'refused', revision: invalid.id, code: 'invalid' });
    expect(first).not.toHaveProperty('repeated');
    for (let i = 0; i < 5; i += 1) expect(await holder.refresh('poll')).toMatchObject({ outcome: 'refused', revision: invalid.id, code: 'invalid', repeated: true });
    expect(loads().filter((e) => e.details.revision === invalid.id)).toHaveLength(1);
    expect(logger.calls.filter((c) => c.level === 'warn' && c.message === 'configuration revision refused')).toHaveLength(1);

    const other = await filesWith(EXTRA_ROLES);
    const mismatching = await applyRevision(other.files, MISMATCH);
    expect(await holder.refresh('poll')).toMatchObject({ outcome: 'refused', revision: mismatching.id, code: 'configuration_mismatch' });
    expect(loads().at(-1)).toMatchObject({ outcome: 'error', details: { revision: mismatching.id, code: 'configuration_mismatch' } });

    if (other.hash === undefined) throw new Error('extra roles must load');
    const good = await applyRevision(other.files, other.hash);
    expect(await holder.refresh('poll')).toEqual({ outcome: 'loaded', revision: good.id, hash: other.hash });
    expect(loads().at(-1)).toMatchObject({ outcome: 'ok', details: { revision: good.id, trigger: 'poll' } });
    expect(loads()).toHaveLength(4);
  });

  it('CFG-2 CFG-3 a revision refused invalid because the spec fetch failed is loaded on the next poll once the resolver recovers', async () => {
    const resolver = new RecoveringResolver();
    const holder = await ConfigurationHolder.fromRevisions(options({ load: { resolver } }));
    const before = holder.current;
    const next = await filesWith(URL_SPEC_CONNECTIONS, 'connections.yaml');
    if (next.hash === undefined) throw new Error('url spec connections must load');
    const revision = await applyRevision(next.files, next.hash);

    resolver.failures = 1;
    expect(await holder.refresh('notify')).toMatchObject({ outcome: 'refused', revision: revision.id, code: 'invalid' });
    expect(holder.current).toBe(before);
    expect(await holder.refresh('poll')).toEqual({ outcome: 'loaded', revision: revision.id, hash: next.hash });
    expect(holder.state()).toEqual({ status: 'active', revision: revision.id, hash: next.hash });
    expect(resolver.calls).toBe(2);
    expect(loads().slice(1).map((e) => [e.outcome, e.details.trigger, e.details.code])).toEqual([
      ['error', 'notify', 'invalid'],
      ['ok', 'poll', undefined],
    ]);
  });

  it('CFG-2 CFG-3 at start a revision refused because the spec fetch failed becomes active on the next poll', async () => {
    const next = await filesWith(URL_SPEC_CONNECTIONS, 'connections.yaml');
    if (next.hash === undefined) throw new Error('url spec connections must load');
    const revision = await applyRevision(next.files, next.hash);
    const resolver = new RecoveringResolver();
    resolver.failures = 1;
    const holder = await ConfigurationHolder.fromRevisions(options({ load: { resolver } }));
    expect(holder.state()).toEqual({ status: 'none' });

    expect(await holder.refresh('poll')).toEqual({ outcome: 'loaded', revision: revision.id, hash: next.hash });
    await holder.whenActive();
    expect(holder.state()).toEqual({ status: 'active', revision: revision.id, hash: next.hash });
  });

  it('AUD-1 repeated store unavailability is audited once until a store read succeeds again', async () => {
    const holder = await ConfigurationHolder.fromRevisions(options());
    const rows = loads().length;
    store.failReads = 3;
    for (const trigger of ['poll', 'notify', 'poll'] as const) expect(await holder.refresh(trigger)).toMatchObject({ outcome: 'refused', revision: null, code: 'unavailable' });
    expect(loads()).toHaveLength(rows + 1);
    expect(logger.calls.filter((c) => c.message === 'configuration store unavailable').map((c) => c.level)).toEqual(['warn', 'debug', 'debug']);

    expect(await holder.refresh('poll')).toEqual({ outcome: 'unchanged' });
    store.failReads = 1;
    expect(await holder.refresh('poll')).toMatchObject({ outcome: 'refused', code: 'unavailable' });
    expect(loads()).toHaveLength(rows + 2);
    expect(loads().at(-1)).toMatchObject({ outcome: 'error', details: { revision: null, code: 'unavailable', trigger: 'poll' } });
  });

  it('CFG-2 at start a mismatching revision leaves state configuration_mismatch and current throws', async () => {
    const own = await filesWith(undefined);
    const bad = await applyRevision(own.files, MISMATCH);
    const holder = await ConfigurationHolder.fromRevisions(options());
    expect(holder.state()).toEqual({ status: 'configuration_mismatch', revision: bad.id });
    expect(() => holder.current).toThrow(ConfigurationUnavailableError);
    expect(() => holder.current).toThrow('no active configuration');
    expect(loads()).toHaveLength(1);
    expect(loads()[0]).toMatchObject({ outcome: 'error', details: { trigger: 'start', code: 'configuration_mismatch' } });

    let activated = false;
    const waiting = holder.whenActive().then(() => {
      activated = true;
    });
    await new Promise((r) => setImmediate(r));
    expect(activated).toBe(false);

    const good = await filesWith(EXTRA_ROLES);
    if (good.hash === undefined) throw new Error('extra roles must load');
    const revision = await applyRevision(good.files, good.hash);
    expect(await holder.refresh('notify')).toMatchObject({ outcome: 'loaded', revision: revision.id });
    await waiting;
    expect(holder.state()).toEqual({ status: 'active', revision: revision.id, hash: good.hash });
    await holder.whenActive();
  });

  it('CFG-2 at start an invalid revision leaves state none', async () => {
    const broken = await filesWith(BROKEN_ROLES);
    await applyRevision(broken.files, 'a'.repeat(64));
    const holder = await ConfigurationHolder.fromRevisions(options());
    expect(holder.state()).toEqual({ status: 'none' });
    expect(() => holder.current).toThrow(ConfigurationUnavailableError);
    expect(loads()).toHaveLength(1);
    expect(loads()[0]).toMatchObject({ outcome: 'error', details: { trigger: 'start', code: 'invalid' } });
  });

  it('AUD-1 a failing store read is refused unavailable and retried on the next poll', async () => {
    const holder = await ConfigurationHolder.fromRevisions(options());
    const before = holder.current;
    const next = await filesWith(EXTRA_ROLES);
    if (next.hash === undefined) throw new Error('extra roles must load');
    const revision = await applyRevision(next.files, next.hash);

    store.failReads = 1;
    const refused = await holder.refresh('poll');
    expect(refused).toMatchObject({ outcome: 'refused', revision: null, code: 'unavailable' });
    expect(holder.current).toBe(before);
    expect(loads().at(-1)).toMatchObject({ outcome: 'error', details: { revision: null, hash: null, service: 'api', trigger: 'poll', code: 'unavailable' } });

    expect(await holder.refresh('poll')).toEqual({ outcome: 'loaded', revision: revision.id, hash: next.hash });
    expect(loads()).toHaveLength(3);
  });

  it('AUD-1 a refusal whose audit append failed is audited on its next repeat', async () => {
    const holder = await ConfigurationHolder.fromRevisions(options());
    const broken = await filesWith(BROKEN_ROLES);
    const invalid = await applyRevision(broken.files, 'a'.repeat(64));
    audit.failNext = new Error('audit down');
    const first = await holder.refresh('poll');
    expect(first).toMatchObject({ outcome: 'refused', revision: invalid.id, code: 'invalid' });
    expect(loads().filter((e) => e.details.revision === invalid.id)).toHaveLength(0);
    const second = await holder.refresh('poll');
    expect(second).not.toHaveProperty('repeated');
    expect(loads().filter((e) => e.details.revision === invalid.id)).toHaveLength(1);
    expect(await holder.refresh('poll')).toMatchObject({ repeated: true });
    expect(loads().filter((e) => e.details.revision === invalid.id)).toHaveLength(1);
  });

  it('AUD-1 a failing audit append is logged and the load still happens', async () => {
    audit.failNext = new Error('audit down');
    const holder = await ConfigurationHolder.fromRevisions(options());
    expect(holder.state()).toMatchObject({ status: 'active' });
    expect(loads()).toEqual([]);
    const state = holder.state();
    if (state.status !== 'active') throw new Error('holder must be active');
    expect(logger.calls).toContainEqual({ level: 'error', fields: { revision: state.revision, trigger: 'start', error: 'Error' }, message: 'configuration load audit failed' });
    expect(JSON.stringify(logger.calls)).not.toContain('audit down');
  });

  it('AUD-1 a revision whose files cannot be written locally is refused unavailable with its id and stored hash, and retried', async () => {
    const holder = await ConfigurationHolder.fromRevisions(options());
    const before = holder.current;
    const next = await filesWith(EXTRA_ROLES);
    if (next.hash === undefined) throw new Error('extra roles must load');
    // A valid revision key whose single segment exceeds the 255-byte file name limit: writeFile throws ENAMETOOLONG.
    const revision = await applyRevision({ ...next.files, [`${'n'.repeat(300)}.yaml`]: 'version: 1\n' }, next.hash);

    const result = await holder.refresh('notify');
    expect(result).toMatchObject({ outcome: 'refused', revision: revision.id, code: 'unavailable' });
    expect(holder.current).toBe(before);
    expect(loads().at(-1)).toMatchObject({
      outcome: 'error',
      details: { revision: revision.id, hash: next.hash, service: 'api', trigger: 'notify', code: 'unavailable' },
    });
    expect(await holder.refresh('poll')).toMatchObject({ outcome: 'refused', revision: revision.id, code: 'unavailable', repeated: true });
    expect(loads()).toHaveLength(2);
  });

  it('AUD-1 at start a revision whose files cannot be written locally leaves state none', async () => {
    const own = await filesWith(undefined);
    const revision = await applyRevision({ ...own.files, [`${'n'.repeat(300)}.yaml`]: 'version: 1\n' }, 'a'.repeat(64));
    const holder = await ConfigurationHolder.fromRevisions(options());
    expect(holder.state()).toEqual({ status: 'none' });
    expect(() => holder.current).toThrow(ConfigurationUnavailableError);
    expect(loads()).toHaveLength(1);
    expect(loads()[0]).toMatchObject({ outcome: 'error', details: { revision: revision.id, hash: 'a'.repeat(64), trigger: 'start', code: 'unavailable' } });
  });

  it('CFG-4 changed files after bootstrap are ignored and logged as configuration_files_differ', async () => {
    const first = await ConfigurationHolder.fromRevisions(options());
    const revision = first.state();
    await writeFile(join(dir, 'roles.yaml'), EXTRA_ROLES);
    const filesHash = await dirHash();

    const restarted = await ConfigurationHolder.fromRevisions(options());
    expect(restarted.state()).toEqual(revision);
    expect(restarted.current.policy.roles.map((r) => r.id)).not.toContain('extra');
    expect(await store.activeSeq()).toBe(1);
    if (revision.status !== 'active') throw new Error('first holder must be active');
    expect(logger.calls).toContainEqual({ level: 'warn', fields: { revision: revision.revision, hash: revision.hash, filesHash }, message: 'configuration_files_differ' });
  });

  it('CFG-4 an invalid directory after bootstrap is logged as configuration_files_differ with filesValid false', async () => {
    const first = await ConfigurationHolder.fromRevisions(options());
    const revision = first.state();
    await writeFile(join(dir, 'roles.yaml'), BROKEN_ROLES);

    const restarted = await ConfigurationHolder.fromRevisions(options());
    expect(restarted.state()).toEqual(revision);
    if (revision.status !== 'active') throw new Error('first holder must be active');
    expect(logger.calls).toContainEqual({ level: 'warn', fields: { revision: revision.revision, filesValid: false }, message: 'configuration_files_differ' });
  });

  it('CFG-2 overlapping refreshes apply in request order', async () => {
    const holder = await ConfigurationHolder.fromRevisions(options());
    const next = await filesWith(EXTRA_ROLES);
    if (next.hash === undefined) throw new Error('extra roles must load');
    const revision = await applyRevision(next.files, next.hash);

    let release: () => void = () => undefined;
    store.gate = new Promise<void>((r) => {
      release = r;
    });
    const reads = store.seqReads;
    const order: string[] = [];
    const first = holder.refresh('notify').then((r) => {
      order.push('first');
      return r;
    });
    const second = holder.refresh('signal').then((r) => {
      order.push('second');
      return r;
    });
    await new Promise((r) => setImmediate(r));
    expect(store.seqReads).toBe(reads + 1);
    release();
    expect(await first).toEqual({ outcome: 'loaded', revision: revision.id, hash: next.hash });
    expect(await second).toEqual({ outcome: 'unchanged' });
    expect(order).toEqual(['first', 'second']);
  });

  it('CFG-2 AUD-1 reload on a revision holder is a signal refresh', async () => {
    const holder = await ConfigurationHolder.fromRevisions(options());
    expect(await holder.reload()).toEqual({ ok: true });
    const broken = await filesWith(BROKEN_ROLES);
    await applyRevision(broken.files, 'a'.repeat(64));
    const result = await holder.reload();
    expect(result).toMatchObject({ ok: false, issues: [expect.objectContaining({ file: 'roles.yaml' })] });
    expect(await holder.reload()).toMatchObject({ ok: false, issues: [expect.objectContaining({ file: 'roles.yaml' })] });
    // The second refusal of the same seq and code is not audited again (AUD-1).
    expect(loads().filter((e) => e.details.trigger === 'signal')).toHaveLength(1);
  });

  it('CFG-2 a directory holder is always active with revision null', async () => {
    const holder = await ConfigurationHolder.load(dir);
    expect(holder.state()).toEqual({ status: 'active', revision: null, hash: await dirHash() });
    await holder.whenActive();
  });
});
