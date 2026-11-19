import { pino, type DestinationStream, type Logger } from 'pino';
import { REDACT_PATHS, type LogLevel } from '@aiops/config';
import { context, trace } from '@opentelemetry/api';

/** pino mixin: `{ trace_id, span_id }` inside a valid active span, `{}` otherwise (NFR-11). */
function traceMixin(): Record<string, string> {
  const ctx = trace.getSpan(context.active())?.spanContext();
  if (ctx === undefined || !trace.isSpanContextValid(ctx)) return {};
  return { trace_id: ctx.traceId, span_id: ctx.spanId };
}

/** The worker's structured JSON logs, with the api's redaction paths (SEC-3) and trace IDs (NFR-11). */
export function createWorkerLogger(level: LogLevel, destination?: DestinationStream): Logger {
  const options = { level, mixin: traceMixin, base: { service: 'worker' }, redact: { paths: [...REDACT_PATHS], censor: '[REDACTED]' } };
  return destination === undefined ? pino(options) : pino(options, destination);
}
