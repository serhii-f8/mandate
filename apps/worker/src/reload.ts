import { formatIssue, type ConfigurationHolder } from '@aiops/config';

export interface ReloadLogger {
  info(fields: object, message: string): void;
  warn(fields: object, message: string): void;
  error(fields: object, message: string): void;
}

/**
 * SIGHUP reloads the configuration; an invalid set is logged and the previous one stays
 * active (CFG-2). A failed reload never ends the process (NFR-4). Activities read
 * `holder.current` per call, so a reload takes effect for the next activity.
 */
export function installReload(
  holder: Pick<ConfigurationHolder, 'reload' | 'current'>,
  logger: ReloadLogger,
  signals: Pick<NodeJS.EventEmitter, 'on'>,
): void {
  signals.on('SIGHUP', () => {
    // `then` also turns a synchronous throw of `reload` into a handled rejection.
    Promise.resolve()
      .then(() => holder.reload())
      .then(
        (result) => {
          if (result.ok) logger.info({ hash: holder.current.hash }, 'configuration reloaded');
          else
            for (const issue of result.issues)
              logger.warn({ issue: formatIssue(issue) }, 'configuration reload rejected; previous configuration stays active');
        },
        (error: unknown) => {
          // The message names a file or a code, never a value; anything else is reported as unknown.
          logger.error(
            { err: error instanceof Error ? error.message : 'unknown' },
            'configuration reload failed; previous configuration stays active',
          );
        },
      );
  });
}
