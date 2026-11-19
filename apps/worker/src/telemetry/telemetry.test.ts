import { createServer, request, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { context, propagation, trace } from '@opentelemetry/api';
import { InMemorySpanExporter, NoopSpanProcessor, SimpleSpanProcessor, type SpanProcessor } from '@opentelemetry/sdk-trace-base';
import { NodeTracerProvider } from '@opentelemetry/sdk-trace-node';
import { describe, expect, it } from 'vitest';
import { fanOutSpanProcessor, otlpTracesUrl, startWorkerTelemetry } from './telemetry.js';

function get(port: number, path: string): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = request({ host: '127.0.0.1', port, method: 'GET', path }, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (c: string) => {
        body += c;
      });
      res.on('end', () => {
        resolve({ status: res.statusCode ?? 0, body });
      });
    });
    req.on('error', reject);
    req.end();
  });
}

async function listen(server: Server): Promise<number> {
  await new Promise<void>((ok) => server.listen(0, '127.0.0.1', ok));
  return (server.address() as AddressInfo).port; // a TCP listener, so the address is an AddressInfo
}

async function close(server: Server): Promise<void> {
  server.closeAllConnections();
  await new Promise((ok) => server.close(ok));
}

function unregister(): void {
  trace.disable();
  context.disable();
  propagation.disable();
}

describe('NFR-11 worker tracing', () => {
  it('NFR-11 otlpTracesUrl appends /v1/traces once and drops query and fragment', () => {
    expect(otlpTracesUrl(new URL('http://jaeger:4318'))).toBe('http://jaeger:4318/v1/traces');
    expect(otlpTracesUrl(new URL('http://jaeger:4318/'))).toBe('http://jaeger:4318/v1/traces');
    expect(otlpTracesUrl(new URL('http://c:4318/otel/?a=b#f'))).toBe('http://c:4318/otel/v1/traces');
  });

  it('NFR-11 without an endpoint the worker exports nothing', async () => {
    const telemetry = startWorkerTelemetry({ register: false });
    try {
      expect(telemetry.spanProcessor).toBeInstanceOf(NoopSpanProcessor);
    } finally {
      await telemetry.shutdown();
    }
  });

  it('NFR-11 registered, activity-side spans carry service.name aiops-worker, only W3C context propagates, and the OTLP endpoint receives them', async () => {
    const posts: string[] = [];
    const sink = createServer((req, res) => {
      posts.push(`${req.method ?? ''} ${req.url ?? ''}`);
      req.resume();
      req.on('end', () => res.writeHead(200).end('{}'));
    });
    const port = await listen(sink);
    const memory = new InMemorySpanExporter();
    const telemetry = startWorkerTelemetry({
      otlpEndpoint: new URL(`http://127.0.0.1:${String(port)}/`),
      spanProcessor: new SimpleSpanProcessor(memory),
      register: true,
    });
    try {
      trace.getTracer('probe').startActiveSpan('probe', (span) => {
        const carrier: Record<string, string> = {};
        propagation.inject(context.active(), carrier);
        expect(Object.keys(carrier)).toEqual(['traceparent']);
        span.end();
      });
      const [span] = memory.getFinishedSpans();
      expect(span?.resource.attributes['service.name']).toBe('aiops-worker');
    } finally {
      // Shutdown flushes the batch processor to the endpoint.
      await telemetry.shutdown();
      unregister();
      await close(sink);
    }
    expect(posts).toEqual(['POST /v1/traces']);
  });
});

describe('NFR-12 worker metrics', () => {
  it('NFR-12 metricsHandler serves the Prometheus text', async () => {
    const telemetry = startWorkerTelemetry({ register: false });
    const server = createServer(telemetry.metricsHandler);
    const port = await listen(server);
    try {
      telemetry.meter.createCounter('aiops_probe_total').add(2, { phase: 'execute' });
      const res = await get(port, '/metrics');
      expect(res.status).toBe(200);
      expect(res.body).toContain('aiops_probe_total{phase="execute"} 2');
    } finally {
      await close(server);
      await telemetry.shutdown();
    }
  });
});

describe('NFR-11 NFR-12 worker telemetry failures', () => {
  it('NFR-11 shutdown resolves with an unreachable collector and still shuts the meter provider down', async () => {
    // A port that was listening and is closed before use: the export is refused.
    const gone = createServer();
    const port = await listen(gone);
    await close(gone);
    const telemetry = startWorkerTelemetry({ otlpEndpoint: new URL(`http://127.0.0.1:${String(port)}`), register: true });
    const metrics = createServer(telemetry.metricsHandler);
    const metricsPort = await listen(metrics);
    try {
      trace.getTracer('probe').startSpan('pending').end();
      await expect(telemetry.shutdown()).resolves.toBeUndefined();
      await expect(telemetry.shutdown()).resolves.toBeUndefined();
      const res = await get(metricsPort, '/metrics');
      expect(res.body).toContain('MetricReader is shutdown');
    } finally {
      unregister();
      await close(metrics);
    }
  });

  it('NFR-11 a throwing processor does not keep the span from the other one, and flush and shutdown resolve', async () => {
    const memory = new InMemorySpanExporter();
    const throwing: SpanProcessor = {
      onStart: () => {
        throw new Error('onStart');
      },
      onEnd: () => {
        throw new Error('onEnd');
      },
      forceFlush: () => Promise.reject(new Error('flush')),
      shutdown: () => Promise.reject(new Error('shutdown')),
    };
    const fanOut = fanOutSpanProcessor([throwing, new SimpleSpanProcessor(memory)]);
    const provider = new NodeTracerProvider({ spanProcessors: [fanOut] });
    provider.getTracer('probe').startSpan('probe').end();
    expect(memory.getFinishedSpans().map((s) => s.name)).toEqual(['probe']);
    await expect(fanOut.forceFlush()).resolves.toBeUndefined();
    await expect(provider.shutdown()).resolves.toBeUndefined();
  });
});
