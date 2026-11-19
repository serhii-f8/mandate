/**
 * OpenTelemetry for the api (NFR-11, NFR-12): a tracer provider that exports over OTLP/HTTP only
 * when an endpoint is configured, and a meter provider whose Prometheus exporter is served by a
 * `node:http` server on its own listener. Only W3C trace context is propagated, never baggage.
 */
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { context, trace, type Meter, type Tracer } from '@opentelemetry/api';
import { W3CTraceContextPropagator } from '@opentelemetry/core';
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-http';
import { PrometheusExporter } from '@opentelemetry/exporter-prometheus';
import { Resource } from '@opentelemetry/resources';
import { MeterProvider } from '@opentelemetry/sdk-metrics';
import { BatchSpanProcessor, type SpanProcessor } from '@opentelemetry/sdk-trace-base';
import { NodeTracerProvider } from '@opentelemetry/sdk-trace-node';

export interface TelemetryOptions {
  readonly serviceName: 'aiops-api';
  /** Unset: spans are created but never exported (no default localhost:4318). */
  readonly otlpEndpoint?: URL;
  /** Tests pass an in-memory processor; it is added beside the OTLP one. */
  readonly spanProcessor?: SpanProcessor;
  /** Registers the tracer provider globally (main.ts: true; tests: false). */
  readonly register: boolean;
}

export interface ApiTelemetry {
  readonly tracer: Tracer;
  readonly meter: Meter;
  /** Serves the Prometheus text on GET /metrics; other methods on it 405 (`allow: GET`), other paths 404. */
  startMetricsServer(port: number, host: string): Promise<{ readonly port: number; close(): Promise<void> }>;
  shutdown(): Promise<void>;
}

/** The OTLP/HTTP traces URL for an endpoint: the endpoint without a trailing `/` plus `/v1/traces` (ruling R9). */
export function otlpTracesUrl(endpoint: URL): string {
  return `${endpoint.href.replace(/\/+$/, '')}/v1/traces`;
}

/** pino mixin: `{ trace_id, span_id }` inside a valid active span, `{}` otherwise. */
export function traceMixin(): Record<string, string> {
  const span = trace.getSpan(context.active());
  const ctx = span?.spanContext();
  if (ctx === undefined || !trace.isSpanContextValid(ctx)) return {};
  return { trace_id: ctx.traceId, span_id: ctx.spanId };
}

export function startApiTelemetry(options: TelemetryOptions): ApiTelemetry {
  const resource = new Resource({ 'service.name': options.serviceName });
  const spanProcessors: SpanProcessor[] = [];
  if (options.otlpEndpoint !== undefined) {
    spanProcessors.push(new BatchSpanProcessor(new OTLPTraceExporter({ url: otlpTracesUrl(options.otlpEndpoint) })));
  }
  if (options.spanProcessor !== undefined) spanProcessors.push(options.spanProcessor);
  const tracerProvider = new NodeTracerProvider({ resource, spanProcessors });
  if (options.register) tracerProvider.register({ propagator: new W3CTraceContextPropagator() });

  const exporter = new PrometheusExporter({ preventServerStart: true });
  const meterProvider = new MeterProvider({ resource, readers: [exporter] });

  const handle = (req: IncomingMessage, res: ServerResponse): void => {
    const path = (req.url ?? '').split('?')[0];
    if (path !== '/metrics') {
      res.writeHead(404).end();
    } else if (req.method !== 'GET') {
      res.writeHead(405, { allow: 'GET' }).end();
    } else {
      exporter.getMetricsRequestHandler(req, res);
    }
  };

  return {
    tracer: tracerProvider.getTracer(options.serviceName),
    meter: meterProvider.getMeter(options.serviceName),
    startMetricsServer: (port, host) =>
      new Promise((resolve, reject) => {
        const server = createServer(handle);
        server.once('error', reject);
        server.listen(port, host, () => {
          server.off('error', reject);
          resolve({
            port: (server.address() as AddressInfo).port, // listening on a TCP port, so the address is an AddressInfo
            close: () =>
              new Promise<void>((done, fail) => {
                server.close((err) => {
                  if (err === undefined) done();
                  else fail(err);
                });
                server.closeAllConnections();
              }),
          });
        });
      }),
    shutdown: async () => {
      await tracerProvider.shutdown();
      await meterProvider.shutdown();
    },
  };
}
