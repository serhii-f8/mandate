import {
  context,
  defaultTextMapSetter,
  SpanKind,
  SpanStatusCode,
  trace,
  type Meter,
  type Tracer,
} from '@opentelemetry/api';
import { W3CTraceContextPropagator } from '@opentelemetry/core';
import type {
  RequestAttempt,
  RequestAttemptEnd,
  RequestInstrumentation,
  RequestSpan,
} from '@aiops/connector-sdk';

export interface UpstreamInstrumentationDeps {
  /** From the app's MeterProvider. */
  readonly meter: Meter;
  /** Default `trace.getTracer('aiops-upstream')`. */
  readonly tracer?: Tracer;
}

export type UpstreamOutcome = 'ok' | 'client_error' | 'server_error' | 'network';

/** Seconds; Global Constraints of the Phase 8 observability plan. */
const UPSTREAM_DURATION_BUCKETS = [0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10, 30];

/**
 * ok | client_error | server_error | network, from an attempt's end (ruling R5): a status below
 * 400 is `ok` (a redirect is never followed, CONN-5), 4xx `client_error`, 5xx `server_error`, and
 * no status at all `network`.
 */
export function upstreamOutcome(end: RequestAttemptEnd): UpstreamOutcome {
  const { status } = end;
  if (status === undefined) return 'network';
  if (status < 400) return 'ok';
  if (status < 500) return 'client_error';
  return 'server_error';
}

/**
 * The span's `error.type` (ruling F20): the status as a string for any status ≥ 400, the client's
 * fixed code when no response arrived, nothing for a status below 400.
 */
function attemptErrorType(end: RequestAttemptEnd): string | undefined {
  if (end.status === undefined) return end.errorCode ?? 'network';
  return end.status >= 400 ? String(end.status) : undefined;
}

/**
 * `http.request` client spans, W3C `traceparent`, and the two upstream metrics (NFR-11, NFR-12).
 * Span attributes and metric labels carry only the connection ID, method, host, status and a
 * fixed error code: never a path, query, header, credential or item value (SEC-3).
 */
export function createUpstreamInstrumentation(deps: UpstreamInstrumentationDeps): RequestInstrumentation {
  const tracer = deps.tracer ?? trace.getTracer('aiops-upstream');
  // Explicit, independent of the global propagator: only traceparent/tracestate, no baggage (ruling R-prop).
  const propagator = new W3CTraceContextPropagator();
  const requests = deps.meter.createCounter('aiops_upstream_requests_total', {
    description: 'Upstream request attempts per connection and outcome.',
  });
  const duration = deps.meter.createHistogram('aiops_upstream_request_duration_seconds', {
    description: 'Duration of upstream request attempts per connection.',
    unit: 's',
    advice: { explicitBucketBoundaries: UPSTREAM_DURATION_BUCKETS },
  });

  return {
    start(attempt: RequestAttempt): RequestSpan {
      const startedAt = performance.now();
      const span = tracer.startSpan('http.request', {
        kind: SpanKind.CLIENT,
        attributes: {
          'http.request.method': attempt.method,
          'server.address': attempt.host,
          'aiops.connection': attempt.connection,
        },
      });
      const headers: Record<string, string> = {};
      propagator.inject(trace.setSpan(context.active(), span), headers, defaultTextMapSetter);
      let ended = false;

      return {
        headers,
        end(result: RequestAttemptEnd): void {
          if (ended) return;
          ended = true;
          const errorType = attemptErrorType(result);
          if (result.status !== undefined) span.setAttribute('http.response.status_code', result.status);
          if (errorType !== undefined) {
            span.setAttribute('error.type', errorType);
            span.setStatus({ code: SpanStatusCode.ERROR });
          }
          // Measured before span.end(), so a synchronous span export is not counted.
          const seconds = (performance.now() - startedAt) / 1000;
          span.end();
          requests.add(1, { connection: attempt.connection, outcome: upstreamOutcome(result) });
          duration.record(seconds, { connection: attempt.connection });
        },
      };
    },
  };
}
