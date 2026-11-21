// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The AI Operations Layer Authors
/**
 * OpenTelemetry for the worker (NFR-11, NFR-12): a tracer provider for the activity and client
 * interceptors (they use the global tracer), the span processor the Temporal plugin's workflow
 * sink shares with it, and a meter provider whose Prometheus exporter is served by the worker's
 * HTTP server. Spans are exported over OTLP/HTTP only when an endpoint is configured; only W3C
 * trace context is propagated, never baggage (ruling R-prop).
 */
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Context, Exception, Meter } from '@opentelemetry/api';
import { globalErrorHandler, W3CTraceContextPropagator } from '@opentelemetry/core';
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-http';
import { PrometheusExporter } from '@opentelemetry/exporter-prometheus';
import { defaultResource, resourceFromAttributes } from '@opentelemetry/resources';
import { MeterProvider } from '@opentelemetry/sdk-metrics';
import { BatchSpanProcessor, NoopSpanProcessor, type ReadableSpan, type Span, type SpanProcessor } from '@opentelemetry/sdk-trace-base';
import { NodeTracerProvider } from '@opentelemetry/sdk-trace-node';

const SERVICE_NAME = 'aiops-worker';

export interface WorkerTelemetry {
  readonly meter: Meter;
  /** For the worker plugin's sink (Task 1); the same processors as the global provider. */
  readonly spanProcessor: SpanProcessor;
  /** `exporter.getMetricsRequestHandler` bound for the HTTP server (Task 11). */
  readonly metricsHandler: (req: IncomingMessage, res: ServerResponse) => void;
  shutdown(): Promise<void>;
}

export interface WorkerTelemetryOptions {
  /** Unset: spans are created but never exported (no default localhost:4318). */
  readonly otlpEndpoint?: URL;
  /** Tests pass an in-memory processor; it is added beside the OTLP one. */
  readonly spanProcessor?: SpanProcessor;
  /** Registers the tracer provider globally (main.ts: true; tests: false). */
  readonly register: boolean;
}

/** The OTLP/HTTP traces URL for an endpoint: the endpoint without a trailing `/` plus `/v1/traces` (as the api's, ruling R9). */
export function otlpTracesUrl(endpoint: URL): string {
  return `${endpoint.origin}${endpoint.pathname.replace(/\/+$/, '')}/v1/traces`;
}

/** Runs `fn`; a throw is reported to the OpenTelemetry error handler instead of propagating. */
function isolated(fn: () => void): void {
  try {
    fn();
  } catch (error) {
    globalErrorHandler(error as Exception); // an unknown throw; the handler logs it through `diag`
  }
}

/** Settles every promise; rejections are reported to the OpenTelemetry error handler, never thrown. */
async function settled(promises: readonly Promise<unknown>[]): Promise<void> {
  for (const result of await Promise.allSettled(promises)) {
    if (result.status === 'rejected') globalErrorHandler(result.reason as Exception); // an unknown rejection; logged through `diag`
  }
}

/**
 * One processor over several, so the plugin's sink and the global provider share them. A failing
 * processor does not keep a span from the others, and flush and shutdown never reject.
 */
export function fanOutSpanProcessor(processors: readonly SpanProcessor[]): SpanProcessor {
  return {
    onStart: (span: Span, parent: Context) => {
      for (const p of processors) isolated(() => {
          p.onStart(span, parent);
        });
    },
    onEnd: (span: ReadableSpan) => {
      for (const p of processors) isolated(() => {
          p.onEnd(span);
        });
    },
    // Each call runs in its own async function, so a synchronous throw becomes a rejection.
    forceFlush: () => settled(processors.map(async (p) => p.forceFlush())),
    shutdown: () => settled(processors.map(async (p) => p.shutdown())),
  };
}

function combined(processors: readonly SpanProcessor[]): SpanProcessor {
  const [only] = processors;
  if (processors.length === 0) return new NoopSpanProcessor();
  if (processors.length === 1 && only !== undefined) return only;
  return fanOutSpanProcessor(processors);
}

/** The 0.57 exposition: no `otel_scope_*` labels on each series, which 0.200+ add by default (ADR 0054). */
const PROMETHEUS_FORMAT = { withoutScopeInfo: true } as const;

/**
 * One export, retries included, ends within 2 s, so the final flush on shutdown stays well inside
 * a 10 s stop grace when the collector is down (the 2.x default is 10 s with retries; ADR 0054).
 */
const OTLP_EXPORT_TIMEOUT_MS = 2_000;

export function startWorkerTelemetry(options: WorkerTelemetryOptions): WorkerTelemetry {
  // The SDK default (telemetry.sdk.*) merged with service.name, as 1.x providers did themselves (ADR 0054).
  const resource = defaultResource().merge(resourceFromAttributes({ 'service.name': SERVICE_NAME }));
  const processors: SpanProcessor[] = [];
  if (options.otlpEndpoint !== undefined) {
    processors.push(new BatchSpanProcessor(new OTLPTraceExporter({ url: otlpTracesUrl(options.otlpEndpoint), timeoutMillis: OTLP_EXPORT_TIMEOUT_MS })));
  }
  if (options.spanProcessor !== undefined) processors.push(options.spanProcessor);
  const spanProcessor = combined(processors);
  const tracerProvider = new NodeTracerProvider({ resource, spanProcessors: [spanProcessor] });
  if (options.register) tracerProvider.register({ propagator: new W3CTraceContextPropagator() });

  const exporter = new PrometheusExporter({ preventServerStart: true, ...PROMETHEUS_FORMAT });
  const meterProvider = new MeterProvider({ resource, readers: [exporter] });

  let shutting: Promise<void> | undefined;
  return {
    meter: meterProvider.getMeter(SERVICE_NAME),
    spanProcessor,
    metricsHandler: (req, res) => {
      exporter.getMetricsRequestHandler(req, res);
    },
    shutdown: () => {
      // Both providers shut down even when one fails (an unreachable collector); failures are reported, never thrown.
      shutting ??= settled([tracerProvider.shutdown(), meterProvider.shutdown()]);
      return shutting;
    },
  };
}
