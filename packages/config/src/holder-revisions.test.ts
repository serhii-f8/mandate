import { randomUUID } from 'node:crypto';
import { cp, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { AuditEventInput, ConfigRevision } from '@aiops/core';
import { InMemoryAuditLog, InMemoryConfigRevisionStore } from '@aiops/testing';
import { ConfigurationHolder, ConfigurationUnavailableError, type ConfigurationLogger, type RevisionHolderOptions } from './holder.js';
import { loadConfigurationDirectory } from './load.js';
import { revisionFilesOf, revisionSummary } from './revision-files.js';

const VALID_DIR = fileURLToPath(new URL('../test/fixtures/valid', import.meta.url));
const EXTRA_ROLES = 'version: 1\nroles:\n  - id: content_manager\n    grants: []\n  - id: support_agent\n    grants: []\n  - id: extra\n    grants: []\n';
const BROKEN_ROLES = 'version: 1\nroles: nope\n';
const MISMATCH = 'f'.repeat(64);

interface LogCall {
  readonly level: 'info' | 'warn' | 'error';
  readonly fields: object;
  readonly message: string;
}

class RecordingLogger implements ConfigurationLogger {
  readonly calls: LogCall[] = [];
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

/** Files of the fixture directory with `roles.yaml` replaced, and their computed hash. */
async function filesWith(roles: string | undefined): Promise<{ files: Record<string, string>; hash: string | undefined }> {
  const copy = await mkdtemp(join(tmpdir(), 'aiops-holder-rev-src-'));
  try {
    await cp(VALID_DIR, copy, { recursive: true });
    if (roles !== undefined) await writeFile(join(copy, 'roles.yaml'), roles);
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
  it('CFG-4 an empty store is bootstrapped from the directory and loaded', async () => {
    const holder = await ConfigurationHolder.fromRevisions(options());
    const stored = await store.active();
    const hash = await dirHash();
    expect(stored).toMatchObject({ source: 'bootstrap', actor: 'system', hash, seq: 1 });
    expect(holder.state()).toEqual({ status: 'active', revision: stored?.id, hash });
    expect(holder.current.hash).toBe(hash);
    expect(loads()).toEqual([
      expect.objectContaining({ actor: 'system:api', outcome: 'ok', details: { revision: stored?.id, hash, service: 'api', trigger: 'start' } }),
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

  it('AUD-1 a refused seq is not retried on poll or notify, but is on signal', async () => {
    const holder = await ConfigurationHolder.fromRevisions(options());
    const next = await filesWith(EXTRA_ROLES);
    await applyRevision(next.files, MISMATCH);
    expect(await holder.refresh('notify')).toMatchObject({ outcome: 'refused', code: 'configuration_mismatch' });
    const rows = loads().length;

    for (let i = 0; i < 3; i += 1) expect(await holder.refresh('poll')).toEqual({ outcome: 'unchanged' });
    expect(await holder.refresh('notify')).toEqual({ outcome: 'unchanged' });
    expect(loads()).toHaveLength(rows);

    expect(await holder.refresh('signal')).toMatchObject({ outcome: 'refused', code: 'configuration_mismatch' });
    expect(loads()).toHaveLength(rows + 1);
    expect(loads().at(-1)?.details).toMatchObject({ trigger: 'signal' });
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
    expect(await holder.refresh('poll')).toMatchObject({ outcome: 'refused', revision: revision.id, code: 'unavailable' });
    expect(loads()).toHaveLength(3);
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

  it('CFG-2 reload on a revision holder is a signal refresh', async () => {
    const holder = await ConfigurationHolder.fromRevisions(options());
    expect(await holder.reload()).toEqual({ ok: true });
    const broken = await filesWith(BROKEN_ROLES);
    await applyRevision(broken.files, 'a'.repeat(64));
    const result = await holder.reload();
    expect(result).toMatchObject({ ok: false, issues: [expect.objectContaining({ file: 'roles.yaml' })] });
    expect(await holder.reload()).toMatchObject({ ok: false });
    expect(loads().filter((e) => e.details.trigger === 'signal')).toHaveLength(2);
  });

  it('CFG-2 a directory holder is always active with revision null', async () => {
    const holder = await ConfigurationHolder.load(dir);
    expect(holder.state()).toEqual({ status: 'active', revision: null, hash: await dirHash() });
    await holder.whenActive();
  });
});
