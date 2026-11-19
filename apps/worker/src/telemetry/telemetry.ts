/**
 * OpenTelemetry for the worker (NFR-11, NFR-12): a tracer provider for the activity and client
 * interceptors (they use the global tracer), the span processor the Temporal plugin's workflow
 * sink shares with it, and a meter provider whose Prometheus exporter is served by the worker's
 * HTTP server. Spans are exported over OTLP/HTTP only when an endpoint is configured; only W3C
 * trace context is propagated, never baggage (ruling R-prop).
 */
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Context, Meter } from '@opentelemetry/api';
import { W3CTraceContextPropagator } from '@opentelemetry/core';
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-http';
import { PrometheusExporter } from '@opentelemetry/exporter-prometheus';
import { Resource } from '@opentelemetry/resources';
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

/** One processor over several, so the plugin's sink and the global provider share them. */
function combined(processors: readonly SpanProcessor[]): SpanProcessor {
  const [only] = processors;
  if (processors.length === 0) return new NoopSpanProcessor();
  if (processors.length === 1 && only !== undefined) return only;
  return {
    onStart: (span: Span, parent: Context) => {
      for (const p of processors) p.onStart(span, parent);
    },
    onEnd: (span: ReadableSpan) => {
      for (const p of processors) p.onEnd(span);
    },
    forceFlush: async () => {
      await Promise.all(processors.map((p) => p.forceFlush()));
    },
    shutdown: async () => {
      await Promise.all(processors.map((p) => p.shutdown()));
    },
  };
}

export function startWorkerTelemetry(options: WorkerTelemetryOptions): WorkerTelemetry {
  const resource = new Resource({ 'service.name': SERVICE_NAME });
  const processors: SpanProcessor[] = [];
  if (options.otlpEndpoint !== undefined) {
    processors.push(new BatchSpanProcessor(new OTLPTraceExporter({ url: otlpTracesUrl(options.otlpEndpoint) })));
  }
  if (options.spanProcessor !== undefined) processors.push(options.spanProcessor);
  const spanProcessor = combined(processors);
  const tracerProvider = new NodeTracerProvider({ resource, spanProcessors: [spanProcessor] });
  if (options.register) tracerProvider.register({ propagator: new W3CTraceContextPropagator() });

  const exporter = new PrometheusExporter({ preventServerStart: true });
  const meterProvider = new MeterProvider({ resource, readers: [exporter] });

  let shutting: Promise<void> | undefined;
  return {
    meter: meterProvider.getMeter(SERVICE_NAME),
    spanProcessor,
    metricsHandler: (req, res) => {
      exporter.getMetricsRequestHandler(req, res);
    },
    shutdown: () => {
      shutting ??= (async () => {
        await tracerProvider.shutdown();
        await meterProvider.shutdown();
      })();
      return shutting;
    },
  };
}
