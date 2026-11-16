import type { LoggerService } from '@nestjs/common';
import { pino, type Logger } from 'pino';
import type { LogLevel } from '@aiops/config';

/** Structured JSON logs (SPEC section 3). Never log tokens, credentials or call arguments (SEC-3). */
export function createLogger(level: LogLevel): Logger {
  return pino({ level, base: { service: 'api' } });
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
