import type { LoggerService } from '@nestjs/common';
import { pino, type DestinationStream, type Logger } from 'pino';
import { REDACT_PATHS, type LogLevel } from '@aiops/config';
import { traceMixin } from './telemetry.js';

export { REDACT_PATHS };

/** Structured JSON logs (SPEC section 3). Never log tokens, credentials or call arguments (SEC-3). */
export function createLogger(level: LogLevel, destination?: DestinationStream): Logger {
  const options = { level, mixin: traceMixin, base: { service: 'api' }, redact: { paths: [...REDACT_PATHS], censor: '[REDACTED]' } };
  return destination === undefined ? pino(options) : pino(options, destination);
}

/** NestJS logger backed by pino, so framework messages are JSON too. */
export class PinoNestLogger implements LoggerService {
  constructor(private readonly logger: Logger) {}

  log(message: unknown, context?: string): void {
    this.logger.info({ context }, String(message));
  }
  error(message: unknown, trace?: string, context?: string): void {
    this.logger.error({ context, trace }, String(message));
  }
  warn(message: unknown, context?: string): void {
    this.logger.warn({ context }, String(message));
  }
  debug(message: unknown, context?: string): void {
    this.logger.debug({ context }, String(message));
  }
  verbose(message: unknown, context?: string): void {
    this.logger.trace({ context }, String(message));
  }
}
