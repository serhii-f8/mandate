import type { ConfigListener, ConfigRevisionStore } from '@aiops/core';
import type { ConfigurationHolder, ConfigurationLogger, LoadTrigger, RefreshResult } from './holder.js';
import { formatIssue } from './issues.js';

export const CONFIG_POLL_INTERVAL_MS = 30_000;

export interface ConfigurationSyncOptions {
  readonly holder: Pick<ConfigurationHolder, 'refresh'>;
  readonly store: Pick<ConfigRevisionStore, 'listen'>;
  readonly signals: Pick<NodeJS.EventEmitter, 'on' | 'off'>;
  readonly logger: ConfigurationLogger;
  readonly pollIntervalMs?: number;
}

export interface ConfigurationSync {
  close(): Promise<void>;
}

/**
 * CFG-3: keeps a revision-backed holder current through SIGHUP (`signal`), the change listener
 * (`notify`, and `poll` after each reconnect, catching revisions applied while it was down) and a
 * poll every 30 s. Every outcome is logged; nothing here throws into a signal, timer or listener
 * callback, so a failed refresh never ends the process and the previous configuration stays
 * active (CFG-2, NFR-4).
 *
 * Installs SIGHUP synchronously, then starts the poll and the listener. A listener that cannot
 * start is logged; poll and SIGHUP still run.
 */
export function startConfigurationSync(options: ConfigurationSyncOptions): Promise<ConfigurationSync> {
  const { holder, store, signals, logger } = options;

  /** Never throws and never rejects: a sync throw, a rejection and a throwing logger are all contained. */
  const refresh = (trigger: LoadTrigger): void => {
    Promise.resolve()
      .then(() => holder.refresh(trigger))
      .then(
        (result) => {
          report(logger, trigger, result);
        },
        (error: unknown) => {
          // Only the error class: a message can name a path or a driver detail (SEC-3).
          logger.error(
            { trigger, error: error instanceof Error ? error.name : 'unknown' },
            'configuration refresh failed; previous configuration stays active',
          );
        },
      )
      .catch(() => undefined);
  };

  const onSignal = (): void => {
    refresh('signal');
  };
  signals.on('SIGHUP', onSignal);

  return (async () => {
    const poll = setInterval(() => {
      refresh('poll');
    }, options.pollIntervalMs ?? CONFIG_POLL_INTERVAL_MS);
    poll.unref();

    let listener: ConfigListener | undefined;
    try {
      listener = await store.listen({
        onChange: () => {
          refresh('notify');
        },
        onReconnect: () => {
          refresh('poll');
        },
        onError: (message) => {
          contain(() => {
            logger.warn({ error: message }, 'configuration listener failed');
          });
        },
      });
    } catch (error: unknown) {
      contain(() => {
        // The store's rejection text is fixed and names no host or user (SEC-3).
        logger.error(
          { error: error instanceof Error ? error.message : 'unknown' },
          'configuration listener did not start; poll and SIGHUP continue',
        );
      });
    }

    let closing: Promise<void> | undefined;
    return {
      close: () => {
        closing ??= (async () => {
          signals.off('SIGHUP', onSignal);
          clearInterval(poll);
          await listener?.close();
        })();
        return closing;
      },
    };
  })();
}

function report(logger: ConfigurationLogger, trigger: LoadTrigger, result: RefreshResult): void {
  switch (result.outcome) {
    case 'unchanged':
      return;
    case 'loaded':
      logger.info({ revision: result.revision, hash: result.hash, trigger }, 'configuration loaded');
      return;
    case 'refused':
      logger.warn({ revision: result.revision, code: result.code, trigger }, 'configuration refused; previous configuration stays active');
      for (const issue of result.issues) logger.warn({ issue: formatIssue(issue) }, 'configuration refused; previous configuration stays active');
      return;
  }
}

/** Runs `step` and swallows what it throws: a listener callback must never throw into the driver. */
function contain(step: () => void): void {
  try {
    step();
  } catch {
    // Logging failed; nothing else can be reported from here.
  }
}
