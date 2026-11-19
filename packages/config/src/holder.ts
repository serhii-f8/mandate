import type { AuditEventInput, AuditLog, ConfigRevision, ConfigRevisionStore } from '@aiops/core';
import { formatIssue, type ConfigIssue } from './issues.js';
import { loadConfigurationDirectory, type LoadedConfiguration, type LoadOptions } from './load.js';
import { loadConfigurationFiles, revisionFilesOf, revisionSummary } from './revision-files.js';

export class ConfigurationError extends Error {
  constructor(readonly issues: readonly ConfigIssue[]) {
    super(`Invalid configuration:\n${issues.map(formatIssue).join('\n')}`);
    this.name = 'ConfigurationError';
  }
}

/** `current` was read while no configuration is active (state `none` or `configuration_mismatch`). */
export class ConfigurationUnavailableError extends Error {
  constructor() {
    super('no active configuration');
    this.name = 'ConfigurationUnavailableError';
  }
}

export type ConfigurationState =
  | { readonly status: 'active'; readonly revision: string | null; readonly hash: string }
  | { readonly status: 'none' }
  | { readonly status: 'configuration_mismatch'; readonly revision: string };

/** Readiness reads this (NFR-10): the api and worker `/readyz` report it. */
export interface ConfigurationStateSource {
  state(): ConfigurationState;
}

export type LoadTrigger = 'start' | 'notify' | 'poll' | 'signal';
export type LoadErrorCode = 'invalid' | 'configuration_mismatch' | 'unavailable';

export type RefreshResult =
  | { readonly outcome: 'unchanged' }
  | { readonly outcome: 'loaded'; readonly revision: string; readonly hash: string }
  | {
      readonly outcome: 'refused';
      readonly revision: string | null;
      readonly code: LoadErrorCode;
      readonly issues: readonly ConfigIssue[];
      /** Set when the previous refusal had the same seq (null: a failed store read) and code; it was not audited again. */
      readonly repeated?: true;
    };

export interface ConfigurationLogger {
  debug(fields: object, message: string): void;
  info(fields: object, message: string): void;
  warn(fields: object, message: string): void;
  error(fields: object, message: string): void;
}

export interface RevisionHolderOptions {
  readonly store: ConfigRevisionStore;
  /** AIOPS_CONFIG_DIR: bootstraps an empty table; afterwards only compared (files differ hint). */
  readonly fallbackDir: string;
  readonly load: LoadOptions;
  readonly audit: AuditLog;
  readonly service: 'api' | 'worker';
  readonly newId: () => string;
  readonly logger: ConfigurationLogger;
}

const MISMATCH_ISSUE: ConfigIssue = { file: '.', path: '', message: 'computed configuration hash differs from the revision hash (configuration_mismatch)' };
const LOCAL_UNAVAILABLE_ISSUE: ConfigIssue = { file: '.', path: '', message: 'revision files cannot be written to the temporary directory' };
const UNAVAILABLE_ISSUE: ConfigIssue = { file: '.', path: '', message: 'configuration store unavailable' };

type Source = { readonly kind: 'directory'; readonly dir: string } | { readonly kind: 'revisions'; readonly options: RevisionHolderOptions };

/**
 * The active configuration of a process (CFG-2): replaced only by a complete,
 * valid configuration; an invalid reload leaves the previous one active.
 *
 * A directory holder reads `dir` on every reload. A revision holder (CFG-4) loads the newest
 * stored revision, proves it by recomputing its hash, and audits every attempt as
 * `config.load` (AUD-1).
 */
export class ConfigurationHolder implements ConfigurationStateSource {
  private queue: Promise<unknown> = Promise.resolve();
  private status: ConfigurationState;
  private loadedSeq: number | undefined;
  /**
   * The last refusal (AUD-1): a repeat of the same seq and code is retried but not audited again.
   * `seq` null is a failed store read, cleared by the next successful seq read. A load clears the
   * marker, a refusal of another seq or code replaces it, and a refusal whose audit row could not
   * be written clears it, so its next repeat is audited.
   */
  private lastRefusal: { readonly seq: number | null; readonly code: LoadErrorCode } | undefined;
  private waiters: (() => void)[] = [];

  private constructor(
    private readonly source: Source,
    private readonly options: LoadOptions,
    private active: LoadedConfiguration | undefined,
  ) {
    this.status = active === undefined ? { status: 'none' } : { status: 'active', revision: null, hash: active.hash };
  }

  /** Loads the directory or throws `ConfigurationError` with every issue. */
  static async load(dir: string, options: LoadOptions = {}): Promise<ConfigurationHolder> {
    const result = await loadConfigurationDirectory(dir, options);
    if (!result.ok) throw new ConfigurationError(result.issues);
    return new ConfigurationHolder({ kind: 'directory', dir }, options, result.configuration);
  }

  /** Bootstraps when the table is empty (an invalid directory throws ConfigurationError), then refresh('start'). A store failure at start rejects. */
  static async fromRevisions(options: RevisionHolderOptions): Promise<ConfigurationHolder> {
    const existing = await options.store.active();
    const files = await loadConfigurationDirectory(options.fallbackDir, options.load);
    let revision: ConfigRevision;
    if (existing === undefined) {
      if (!files.ok) throw new ConfigurationError(files.issues);
      const stored = revisionFilesOf(files.configuration);
      if (!stored.ok) throw new ConfigurationError(stored.issues);
      revision = await options.store.bootstrap({
        id: options.newId(),
        hash: files.configuration.hash,
        files: stored.files,
        summary: revisionSummary(files.configuration),
      });
    } else {
      revision = existing;
    }
    if (!files.ok) {
      options.logger.warn({ revision: revision.id, filesValid: false }, 'configuration_files_differ');
    } else if (files.configuration.hash !== revision.hash) {
      options.logger.warn({ revision: revision.id, hash: revision.hash, filesHash: files.configuration.hash }, 'configuration_files_differ');
    }
    const holder = new ConfigurationHolder({ kind: 'revisions', options }, options.load, undefined);
    await holder.enqueue(() => holder.attempt('start', revision));
    return holder;
  }

  /** Throws `ConfigurationUnavailableError` while no configuration is active. */
  get current(): LoadedConfiguration {
    if (this.active === undefined) throw new ConfigurationUnavailableError();
    return this.active;
  }

  state(): ConfigurationState {
    return this.status;
  }

  /** Resolves when the state is (or becomes) active. */
  whenActive(): Promise<void> {
    if (this.status.status === 'active') return Promise.resolve();
    return new Promise((resolve) => this.waiters.push(resolve));
  }

  /**
   * Re-reads the active revision's seq and loads the revision unless that seq is the loaded one
   * (CFG-3). A refused seq is retried on every refresh, whatever the trigger, so a refusal caused
   * by a transient failure (a spec URL that could not be fetched, a full tmpdir, a store read)
   * heals within one poll interval (CFG-2). A refusal that repeats the previous one (same seq, or a
   * failed store read again, with the same code) writes no new `config.load` row and logs at
   * debug (AUD-1); the first refusal, a change of code and a load are audited. Refreshes run one
   * after another.
   */
  refresh(trigger: LoadTrigger): Promise<RefreshResult> {
    const { source } = this;
    if (source.kind !== 'revisions') return Promise.reject(new Error('refresh needs a revision-backed configuration holder'));
    return this.enqueue(async () => {
      let revision: ConfigRevision | undefined;
      try {
        const seq = await source.options.store.activeSeq();
        if (this.lastRefusal?.seq === null) this.lastRefusal = undefined;
        if (seq === undefined || seq === this.loadedSeq) return { outcome: 'unchanged' as const };
        revision = await source.options.store.active();
      } catch {
        return this.unavailable(source.options, trigger);
      }
      if (revision === undefined || revision.seq === this.loadedSeq) return { outcome: 'unchanged' as const };
      return this.attempt(trigger, revision);
    });
  }

  /** Directory holder: re-reads the directory. Revision holder: refresh('signal'). */
  reload(): Promise<{ ok: true } | { ok: false; issues: readonly ConfigIssue[] }> {
    const { source } = this;
    if (source.kind === 'revisions') {
      return this.refresh('signal').then((result) => (result.outcome === 'refused' ? { ok: false as const, issues: result.issues } : { ok: true as const }));
    }
    return this.enqueue(async () => {
      const result = await loadConfigurationDirectory(source.dir, this.options);
      if (!result.ok) return { ok: false as const, issues: result.issues };
      this.active = result.configuration;
      this.status = { status: 'active', revision: null, hash: result.configuration.hash };
      return { ok: true as const };
    });
  }

  /** One promise queue, so an older read can never replace a newer one. */
  private enqueue<T>(step: () => Promise<T>): Promise<T> {
    const next = this.queue.then(step);
    this.queue = next.catch(() => undefined);
    return next;
  }

  /** Records the refusal and tells whether it repeats the previous one (then it is not audited again). */
  private repeats(seq: number | null, code: LoadErrorCode): boolean {
    const repeated = this.lastRefusal?.seq === seq && this.lastRefusal.code === code;
    this.lastRefusal = { seq, code };
    return repeated;
  }

  private async attempt(trigger: LoadTrigger, revision: ConfigRevision): Promise<RefreshResult> {
    const { options } = this.revisionSource();
    const base = { revision: revision.id, hash: revision.hash, service: options.service, trigger };
    let result: Awaited<ReturnType<typeof loadConfigurationFiles>>;
    try {
      result = await loadConfigurationFiles(revision.files, this.options);
    } catch (error) {
      // The revision could not be written to the local temporary directory (full or read-only
      // tmpdir, a name over the file system limit); the next refresh retries it.
      const repeated = this.repeats(revision.seq, 'unavailable');
      const fields = { revision: revision.id, trigger, code: 'unavailable', error: error instanceof Error ? error.name : 'unknown' };
      if (repeated) options.logger.debug(fields, 'configuration revision could not be loaded');
      else {
        if (!(await this.audit(options, 'error', { ...base, code: 'unavailable' }))) this.lastRefusal = undefined;
        options.logger.warn(fields, 'configuration revision could not be loaded');
      }
      return refused(revision.id, 'unavailable', [LOCAL_UNAVAILABLE_ISSUE], repeated);
    }
    if (!result.ok) {
      const repeated = this.refuse(revision, 'invalid');
      const fields = { revision: revision.id, trigger, code: 'invalid', issues: result.issues.length };
      if (repeated) options.logger.debug(fields, 'configuration revision refused');
      else {
        if (!(await this.audit(options, 'error', { ...base, code: 'invalid' }))) this.lastRefusal = undefined;
        options.logger.warn(fields, 'configuration revision refused');
      }
      return refused(revision.id, 'invalid', result.issues, repeated);
    }
    const computedHash = result.configuration.hash;
    if (computedHash !== revision.hash) {
      const repeated = this.refuse(revision, 'configuration_mismatch');
      const fields = { revision: revision.id, trigger, code: 'configuration_mismatch', hash: revision.hash, computedHash };
      if (repeated) options.logger.debug(fields, 'configuration revision refused');
      else {
        if (!(await this.audit(options, 'error', { ...base, computedHash, code: 'configuration_mismatch' }))) this.lastRefusal = undefined;
        options.logger.error(fields, 'configuration revision refused');
      }
      return refused(revision.id, 'configuration_mismatch', [MISMATCH_ISSUE], repeated);
    }
    this.active = result.configuration;
    this.loadedSeq = revision.seq;
    this.lastRefusal = undefined;
    this.status = { status: 'active', revision: revision.id, hash: computedHash };
    const waiters = this.waiters;
    this.waiters = [];
    for (const resolve of waiters) resolve();
    await this.audit(options, 'ok', base);
    options.logger.info({ revision: revision.id, hash: computedHash, trigger }, 'configuration loaded');
    return { outcome: 'loaded', revision: revision.id, hash: computedHash };
  }

  /**
   * CFG-2: an active configuration stays; without one the state names why nothing is active.
   * Returns whether the refusal repeats the previous one.
   */
  private refuse(revision: ConfigRevision, code: 'invalid' | 'configuration_mismatch'): boolean {
    const repeated = this.repeats(revision.seq, code);
    if (this.active === undefined) this.status = code === 'invalid' ? { status: 'none' } : { status: 'configuration_mismatch', revision: revision.id };
    return repeated;
  }

  /** A failed store read: audited once until a store read succeeds again (AUD-1). */
  private async unavailable(options: RevisionHolderOptions, trigger: LoadTrigger): Promise<RefreshResult> {
    const repeated = this.repeats(null, 'unavailable');
    if (repeated) options.logger.debug({ trigger, code: 'unavailable' }, 'configuration store unavailable');
    else {
      if (!(await this.audit(options, 'error', { revision: null, hash: null, service: options.service, trigger, code: 'unavailable' }))) this.lastRefusal = undefined;
      options.logger.warn({ trigger, code: 'unavailable' }, 'configuration store unavailable');
    }
    return refused(null, 'unavailable', [UNAVAILABLE_ISSUE], repeated);
  }

  /**
   * AUD-1: a failing append is logged and never blocks or reverses the load. Returns whether the
   * row was written; a refusal whose row was not written is not treated as seen, so its next
   * repeat is audited.
   */
  private async audit(options: RevisionHolderOptions, outcome: 'ok' | 'error', details: Record<string, unknown>): Promise<boolean> {
    const event: AuditEventInput = {
      id: options.newId(),
      actor: `system:${options.service}`,
      action: 'config.load',
      outcome,
      correlationId: options.newId(),
      details,
    };
    try {
      await options.audit.append(event);
      return true;
    } catch (error) {
      options.logger.error({ revision: details.revision, trigger: details.trigger, error: error instanceof Error ? error.name : 'unknown' }, 'configuration load audit failed');
      return false;
    }
  }

  private revisionSource(): { readonly options: RevisionHolderOptions } {
    if (this.source.kind !== 'revisions') throw new Error('not a revision-backed configuration holder');
    return this.source;
  }
}

function refused(revision: string | null, code: LoadErrorCode, issues: readonly ConfigIssue[], repeated: boolean): RefreshResult {
  return { outcome: 'refused', revision, code, issues, ...(repeated ? { repeated: true as const } : {}) };
}
