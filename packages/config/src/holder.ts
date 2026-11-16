import { formatIssue, type ConfigIssue } from './issues.js';
import { loadConfigurationDirectory, type LoadedConfiguration, type LoadOptions } from './load.js';

export class ConfigurationError extends Error {
  constructor(readonly issues: readonly ConfigIssue[]) {
    super(`Invalid configuration:\n${issues.map(formatIssue).join('\n')}`);
    this.name = 'ConfigurationError';
  }
}

/**
 * The active configuration of a process (CFG-2): replaced only by a complete,
 * valid configuration; an invalid reload leaves the previous one active.
 */
export class ConfigurationHolder {
  private constructor(
    private readonly dir: string,
    private readonly options: LoadOptions,
    private active: LoadedConfiguration,
  ) {}

  /** Loads the directory or throws `ConfigurationError` with every issue. */
  static async load(dir: string, options: LoadOptions = {}): Promise<ConfigurationHolder> {
    const result = await loadConfigurationDirectory(dir, options);
    if (!result.ok) throw new ConfigurationError(result.issues);
    return new ConfigurationHolder(dir, options, result.configuration);
  }

  get current(): LoadedConfiguration {
    return this.active;
  }

  private queue: Promise<unknown> = Promise.resolve();

  /** Reloads run one after another, so an older read can never replace a newer one. */
  reload(): Promise<{ ok: true } | { ok: false; issues: readonly ConfigIssue[] }> {
    const next = this.queue.then(async () => {
      const result = await loadConfigurationDirectory(this.dir, this.options);
      if (!result.ok) return { ok: false as const, issues: result.issues };
      this.active = result.configuration;
      return { ok: true as const };
    });
    this.queue = next.catch(() => undefined);
    return next;
  }
}
