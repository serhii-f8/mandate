import { createServer, request } from 'node:http';
import type { AddressInfo } from 'node:net';
import { trace } from '@opentelemetry/api';
import { InMemorySpanExporter, SimpleSpanProcessor, type ReadableSpan } from '@opentelemetry/sdk-trace-base';
import { describe, expect, it } from 'vitest';
import { otlpTracesUrl, startApiTelemetry, traceMixin } from './telemetry.js';

function call(port: number, method: string, path: string): Promise<{ status: number; allow: string | undefined; body: string }> {
  return new Promise((resolve, reject) => {
    const req = request({ host: '127.0.0.1', port, method, path }, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (c: string) => {
        body += c;
      });
      res.on('end', () => {
        resolve({ status: res.statusCode ?? 0, allow: res.headers.allow, body });
      });
    });
    req.on('error', (e) => {
      reject(e);
    });
    req.end();
  });
}

describe('NFR-11 api tracing', () => {
  it('NFR-11 otlpTracesUrl appends /v1/traces once', () => {
    expect(otlpTracesUrl(new URL('http://jaeger:4318'))).toBe('http://jaeger:4318/v1/traces');
    expect(otlpTracesUrl(new URL('http://jaeger:4318/'))).toBe('http://jaeger:4318/v1/traces');
    expect(otlpTracesUrl(new URL('http://c:4318/otel/'))).toBe('http://c:4318/otel/v1/traces');
  });

  it('NFR-11 otlpTracesUrl drops query and fragment', () => {
    expect(otlpTracesUrl(new URL('http://x/?a=b#f'))).toBe('http://x/v1/traces');
    expect(otlpTracesUrl(new URL('http://x:4318/otel/?a=b'))).toBe('http://x:4318/otel/v1/traces');
  });

  it('NFR-11 with an endpoint set, spans carry the resource service.name', async () => {
    const memory = new InMemorySpanExporter();
    // A local sink, so the OTLP flush at shutdown has somewhere to go.
    const sink = createServer((_req, res) => {
      res.writeHead(200).end('{}');
    });
    await new Promise<void>((ok) => sink.listen(0, '127.0.0.1', ok));
    const telemetry = startApiTelemetry({
      serviceName: 'aiops-api',
      otlpEndpoint: new URL(`http://127.0.0.1:${(sink.address() as AddressInfo).port}`),
      spanProcessor: new SimpleSpanProcessor(memory),
      register: false,
    });
    try {
      telemetry.tracer.startSpan('probe').end();
      expect(memory.getFinishedSpans()[0]?.resource.attributes['service.name']).toBe('aiops-api');
    } finally {
      await telemetry.shutdown();
      sink.closeAllConnections();
      await new Promise((ok) => sink.close(ok));
    }
  });

  it('NFR-11 without an endpoint nothing is exported and spans still carry attributes', async () => {
    const telemetry = startApiTelemetry({ serviceName: 'aiops-api', register: false });
    try {
      const span = telemetry.tracer.startSpan('probe', { attributes: { 'aiops.correlation_id': 'c-1' } });
      expect(span.isRecording()).toBe(true);
      expect((span as unknown as ReadableSpan).attributes['aiops.correlation_id']).toBe('c-1');
      span.end();
    } finally {
      await telemetry.shutdown();
    }
  });

  it('NFR-11 traceMixin is empty outside a span', () => {
    expect(trace.getActiveSpan()).toBeUndefined();
    expect(traceMixin()).toEqual({});
  });
});

describe('NFR-12 api metrics endpoint', () => {
  it('NFR-12 closing the metrics server twice is harmless', async () => {
    const telemetry = startApiTelemetry({ serviceName: 'aiops-api', register: false });
    const server = await telemetry.startMetricsServer(0, '127.0.0.1');
    await server.close();
    await expect(server.close()).resolves.toBeUndefined();
    await telemetry.shutdown();
  });

  it('NFR-12 the metrics server answers /metrics and 404 elsewhere', async () => {
    const telemetry = startApiTelemetry({ serviceName: 'aiops-api', register: false });
    const server = await telemetry.startMetricsServer(0, '127.0.0.1');
    try {
      telemetry.meter.createCounter('aiops_tool_calls_total').add(1, { tool: 'probe' });
      const ok = await call(server.port, 'GET', '/metrics');
      expect(ok.status).toBe(200);
      expect(ok.body).toContain('aiops_tool_calls_total{');
      const other = await call(server.port, 'GET', '/other');
      expect(other.status).toBe(404);
      expect(other.body).toBe('');
      const post = await call(server.port, 'POST', '/metrics');
      expect(post.status).toBe(405);
      expect(post.allow).toBe('GET');
      expect(post.body).toBe('');
    } finally {
      await server.close();
      await telemetry.shutdown();
    }
  });
});
