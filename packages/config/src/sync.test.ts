import { randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { fileURLToPath } from 'node:url';
import type { ConfigListener, ConfigListenerHandlers } from '@aiops/core';
import { InMemoryAuditLog, InMemoryConfigRevisionStore } from '@aiops/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ConfigurationHolder, type ConfigurationLogger, type LoadTrigger, type RefreshResult } from './holder.js';
import type { ConfigIssue } from './issues.js';
import { loadConfigurationDirectory } from './load.js';
import { loadConfigurationFiles, revisionFilesOf, revisionSummary } from './revision-files.js';
import { CONFIG_POLL_INTERVAL_MS, startConfigurationSync, type ConfigurationSyncOptions } from './sync.js';

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

type Refresh = (trigger: LoadTrigger) => Promise<RefreshResult>;

/** Holder fake: records every trigger and answers with `answer`. */
class FakeHolder {
  readonly triggers: LoadTrigger[] = [];
  answer: Refresh = () => Promise.resolve({ outcome: 'unchanged' });
  refresh(trigger: LoadTrigger): Promise<RefreshResult> {
    this.triggers.push(trigger);
    return this.answer(trigger);
  }
}

/** Store fake: captures the handlers; `listen` resolves, rejects, or never settles. */
class FakeStore {
  handlers: ConfigListenerHandlers | undefined;
  closed = 0;
  mode: 'ok' | 'reject' | 'pending' = 'ok';
  listen(handlers: ConfigListenerHandlers): Promise<ConfigListener> {
    this.handlers = handlers;
    if (this.mode === 'reject') return Promise.reject(new Error('configuration listener failed'));
    if (this.mode === 'pending') return new Promise<ConfigListener>(() => undefined);
    return Promise.resolve({
      close: () => {
        this.closed += 1;
        return Promise.resolve();
      },
    });
  }
}

let holder: FakeHolder;
let store: FakeStore;
let signals: EventEmitter;
let logger: RecordingLogger;

beforeEach(() => {
  vi.useFakeTimers();
  holder = new FakeHolder();
  store = new FakeStore();
  signals = new EventEmitter();
  logger = new RecordingLogger();
});

afterEach(() => {
  vi.useRealTimers();
});

function options(overrides: Partial<ConfigurationSyncOptions> = {}): ConfigurationSyncOptions {
  return { holder, store, signals, logger, ...overrides };
}

/** Lets queued promise callbacks run under fake timers. */
async function settle(): Promise<void> {
  for (let i = 0; i < 5; i += 1) await Promise.resolve();
}

const ISSUE: ConfigIssue = { file: 'policy.yaml', path: 'roles[0].name', message: 'is required' };

describe('configuration sync', () => {
  it('CFG-3 SIGHUP refreshes with trigger signal and is installed before listen resolves', async () => {
    store.mode = 'pending';
    void startConfigurationSync(options());
    expect(signals.listenerCount('SIGHUP')).toBe(1);

    signals.emit('SIGHUP');
    await settle();
    expect(holder.triggers).toEqual(['signal']);
  });

  it('CFG-3 NOTIFY refreshes with notify; a reconnect refreshes with poll', async () => {
    const sync = await startConfigurationSync(options());
    store.handlers?.onChange();
    store.handlers?.onReconnect();
    await settle();
    expect(holder.triggers).toEqual(['notify', 'poll']);
    await sync.close();
  });

  it('CFG-3 the poll refreshes every 30 s', async () => {
    expect(CONFIG_POLL_INTERVAL_MS).toBe(30_000);
    const sync = await startConfigurationSync(options());
    vi.advanceTimersByTime(29_999);
    expect(holder.triggers).toEqual([]);
    vi.advanceTimersByTime(1);
    vi.advanceTimersByTime(30_000);
    await settle();
    expect(holder.triggers).toEqual(['poll', 'poll']);
    await sync.close();
  });

  it('CFG-3 a revision applied while the listener is down is picked up on reconnect', async () => {
    let activeSeq = 1;
    let loadedSeq = 1;
    holder.answer = () => {
      if (activeSeq === loadedSeq) return Promise.resolve({ outcome: 'unchanged' });
      loadedSeq = activeSeq;
      return Promise.resolve({ outcome: 'loaded', revision: `rev-${String(activeSeq)}`, hash: 'a'.repeat(64) });
    };
    const sync = await startConfigurationSync(options());
    store.handlers?.onError('configuration listener failed');
    activeSeq = 2; // applied while down: no onChange arrives
    store.handlers?.onReconnect();
    await settle();

    expect(holder.triggers).toEqual(['poll']);
    expect(loadedSeq).toBe(2);
    expect(logger.calls).toContainEqual({ level: 'warn', fields: { error: 'configuration listener failed' }, message: 'configuration listener failed' });
    expect(logger.calls).toContainEqual({ level: 'info', fields: { revision: 'rev-2', hash: 'a'.repeat(64), trigger: 'poll' }, message: 'configuration loaded' });
    await sync.close();
  });

  it('CFG-3 a loaded refresh is logged with revision, hash and trigger', async () => {
    holder.answer = () => Promise.resolve({ outcome: 'loaded', revision: 'rev-1', hash: 'b'.repeat(64) });
    const sync = await startConfigurationSync(options());
    store.handlers?.onChange();
    await settle();
    expect(logger.calls).toEqual([{ level: 'info', fields: { revision: 'rev-1', hash: 'b'.repeat(64), trigger: 'notify' }, message: 'configuration loaded' }]);
    await sync.close();
  });

  it('NFR-4 CFG-2 a refused refresh is logged with each issue and keeps the previous configuration', async () => {
    holder.answer = () => Promise.resolve({ outcome: 'refused', revision: 'rev-2', code: 'invalid', issues: [ISSUE, { ...ISSUE, path: 'roles[1].name' }] });
    const sync = await startConfigurationSync(options());
    expect(() => signals.emit('SIGHUP')).not.toThrow();
    await settle();

    const warns = logger.calls.filter((c) => c.level === 'warn');
    expect(warns[0]).toEqual({
      level: 'warn',
      fields: { revision: 'rev-2', code: 'invalid', trigger: 'signal' },
      message: 'configuration refused; previous configuration stays active',
    });
    expect(warns).toHaveLength(3);
    expect(warns[1]?.fields).toEqual({ issue: 'policy.yaml roles[0].name: is required' });
    expect(warns[2]?.fields).toEqual({ issue: 'policy.yaml roles[1].name: is required' });
    expect(logger.calls.filter((c) => c.level === 'info')).toEqual([]);
    await sync.close();
  });

  it('AUD-1 CFG-3 a repeated refusal is logged once at debug, not warn', async () => {
    holder.answer = () => Promise.resolve({ outcome: 'refused', revision: 'rev-2', code: 'invalid', issues: [ISSUE], repeated: true });
    const sync = await startConfigurationSync(options());
    vi.advanceTimersByTime(30_000);
    await settle();
    expect(logger.calls).toEqual([
      { level: 'debug', fields: { revision: 'rev-2', code: 'invalid', trigger: 'poll', issues: 1 }, message: 'configuration refused again; previous configuration stays active' },
    ]);
    await sync.close();
  });

  it('NFR-4 CFG-2 a rejected refresh never ends the process and is logged without its message', async () => {
    holder.answer = () => Promise.reject(new Error('EACCES: permission denied, open /secret/path'));
    const unhandled = vi.fn();
    process.on('unhandledRejection', unhandled);
    try {
      const sync = await startConfigurationSync(options());
      expect(() => signals.emit('SIGHUP')).not.toThrow();
      store.handlers?.onChange();
      store.handlers?.onReconnect();
      vi.advanceTimersByTime(30_000);
      await settle();
      await sync.close();
    } finally {
      process.off('unhandledRejection', unhandled);
    }
    vi.useRealTimers();
    await new Promise((resolve) => setImmediate(resolve));

    expect(unhandled).not.toHaveBeenCalled();
    const errors = logger.calls.filter((c) => c.level === 'error');
    expect(errors.map((c) => c.fields)).toEqual([{ trigger: 'signal', error: 'Error' }, { trigger: 'notify', error: 'Error' }, { trigger: 'poll', error: 'Error' }, { trigger: 'poll', error: 'Error' }]);
    for (const call of errors) expect(call.message).toBe('configuration refresh failed; previous configuration stays active');
    expect(JSON.stringify(logger.calls)).not.toContain('/secret/path');
  });

  it('NFR-4 CFG-2 a refresh that throws synchronously never ends the process', async () => {
    holder.answer = () => {
      throw new Error('boom');
    };
    const sync = await startConfigurationSync(options());
    expect(() => signals.emit('SIGHUP')).not.toThrow();
    expect(() => store.handlers?.onChange()).not.toThrow();
    await settle();
    expect(logger.calls.filter((c) => c.level === 'error')).toHaveLength(2);
    await sync.close();
  });

  it('CFG-3 a throwing logger inside a listener handler never escapes to the listener', async () => {
    const throwing: ConfigurationLogger = {
      debug: () => undefined,
      info: () => undefined,
      warn: () => {
        throw new Error('logger down');
      },
      error: () => undefined,
    };
    const sync = await startConfigurationSync(options({ logger: throwing }));
    expect(() => store.handlers?.onError('configuration listener failed')).not.toThrow();
    await sync.close();
  });

  it('CFG-3 a listener that cannot start is logged; poll and SIGHUP still work', async () => {
    store.mode = 'reject';
    const sync = await startConfigurationSync(options());
    expect(logger.calls).toContainEqual({ level: 'error', fields: { error: 'configuration listener failed' }, message: 'configuration listener did not start; poll and SIGHUP continue' });

    signals.emit('SIGHUP');
    vi.advanceTimersByTime(30_000);
    await settle();
    expect(holder.triggers).toEqual(['signal', 'poll']);
    await sync.close();
  });

  it('CFG-3 close removes SIGHUP, stops the poll and closes the listener', async () => {
    const sync = await startConfigurationSync(options());
    await sync.close();
    expect(signals.listenerCount('SIGHUP')).toBe(0);
    expect(store.closed).toBe(1);

    vi.advanceTimersByTime(90_000);
    await settle();
    expect(holder.triggers).toEqual([]);
    await sync.close();
    expect(store.closed).toBe(1);
  });

  it('CFG-3 the poll timer does not keep the process alive', async () => {
    const unref = vi.fn();
    const spy = vi.spyOn(globalThis, 'setInterval');
    spy.mockImplementationOnce(() => ({ unref }) as unknown as NodeJS.Timeout);
    const clear = vi.spyOn(globalThis, 'clearInterval').mockImplementation(() => undefined);
    try {
      const sync = await startConfigurationSync(options());
      expect(spy).toHaveBeenCalledWith(expect.any(Function), CONFIG_POLL_INTERVAL_MS);
      expect(unref).toHaveBeenCalledTimes(1);
      await sync.close();
    } finally {
      spy.mockRestore();
      clear.mockRestore();
    }
  });
});

/** In-memory store whose listener can be taken down: while down, applies notify nobody. */
class DroppingStore extends InMemoryConfigRevisionStore {
  down = false;
  override listen(handlers: ConfigListenerHandlers): Promise<ConfigListener> {
    return super.listen({
      onChange: () => {
        if (!this.down) handlers.onChange();
      },
      onReconnect: () => {
        handlers.onReconnect();
      },
      onError: (message) => {
        handlers.onError(message);
      },
    });
  }
}

const VALID_DIR = fileURLToPath(new URL('../test/fixtures/valid', import.meta.url));
const EXTRA_ROLES = 'version: 1\nroles:\n  - id: content_manager\n    grants: []\n  - id: support_agent\n    grants: []\n  - id: extra\n    grants: []\n';

describe('configuration sync with a revision-backed holder', () => {
  it('CFG-3 NFR-3 a revision applied while the listener is down is loaded after the reconnect', async () => {
    vi.useRealTimers();
    const revisions = new DroppingStore(new InMemoryAuditLog());
    const real = await ConfigurationHolder.fromRevisions({
      store: revisions,
      fallbackDir: VALID_DIR,
      load: {},
      audit: new InMemoryAuditLog(),
      service: 'worker',
      newId: randomUUID,
      logger,
    });
    const sync = await startConfigurationSync({ holder: real, store: revisions, signals, logger, pollIntervalMs: 3_600_000 });

    const base = await loadConfigurationDirectory(VALID_DIR);
    if (!base.ok) throw new Error('fixture must load');
    const files = revisionFilesOf(base.configuration);
    if (!files.ok) throw new Error('fixture must be storable');
    const changed = { ...files.files, 'roles.yaml': EXTRA_ROLES };
    const loaded = await loadConfigurationFiles(changed);
    if (!loaded.ok) throw new Error('changed files must load');
    const bootstrapped = real.state();

    revisions.down = true;
    const next = await revisions.apply(
      { id: randomUUID(), hash: loaded.configuration.hash, files: changed, actor: 'cli:test', summary: revisionSummary(loaded.configuration) },
      { id: randomUUID(), actor: 'cli:test', action: 'config.apply', outcome: 'ok', correlationId: randomUUID(), details: {} },
      base.configuration.hash,
    );
    if (!next.ok) throw new Error(`apply refused: ${next.reason}`);
    await new Promise((resolve) => setImmediate(resolve));
    expect(real.state()).toEqual(bootstrapped);

    revisions.down = false;
    revisions.emitReconnect();
    await vi.waitFor(() => {
      expect(real.state()).toEqual({ status: 'active', revision: next.revision.id, hash: next.revision.hash });
    });
    expect(logger.calls).toContainEqual({ level: 'info', fields: { revision: next.revision.id, hash: next.revision.hash, trigger: 'poll' }, message: 'configuration loaded' });
    await sync.close();
  });
});
