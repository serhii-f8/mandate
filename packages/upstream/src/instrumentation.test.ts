import { context, SpanKind, SpanStatusCode, trace } from '@opentelemetry/api';
import { AsyncLocalStorageContextManager } from '@opentelemetry/context-async-hooks';
import {
  AggregationTemporality,
  DataPointType,
  InMemoryMetricExporter,
  MeterProvider,
  PeriodicExportingMetricReader,
  type HistogramMetricData,
  type MetricData,
} from '@opentelemetry/sdk-metrics';
import { BasicTracerProvider, InMemorySpanExporter, SimpleSpanProcessor } from '@opentelemetry/sdk-trace-base';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createUpstreamInstrumentation, upstreamOutcome } from './instrumentation.js';

const UPSTREAM_BUCKETS = [0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10, 30];

describe('upstream instrumentation', () => {
  let contextManager: AsyncLocalStorageContextManager;
  let spans: InMemorySpanExporter;
  let tracerProvider: BasicTracerProvider;
  let reader: PeriodicExportingMetricReader;
  let meterProvider: MeterProvider;

  beforeAll(() => {
    contextManager = new AsyncLocalStorageContextManager().enable();
    context.setGlobalContextManager(contextManager);
  });

  afterAll(() => {
    contextManager.disable();
    context.disable();
  });

  beforeEach(() => {
    spans = new InMemorySpanExporter();
    tracerProvider = new BasicTracerProvider({ spanProcessors: [new SimpleSpanProcessor(spans)] });
    reader = new PeriodicExportingMetricReader({
      exporter: new InMemoryMetricExporter(AggregationTemporality.CUMULATIVE),
      // Collection is driven by reader.collect(); the interval only has to outlast the test.
      exportIntervalMillis: 3_600_000,
    });
    meterProvider = new MeterProvider({ readers: [reader] });
  });

  afterEach(async () => {
    await meterProvider.shutdown();
    await tracerProvider.shutdown();
  });

  function instrumentation() {
    return createUpstreamInstrumentation({
      meter: meterProvider.getMeter('test'),
      tracer: tracerProvider.getTracer('test'),
    });
  }

  async function metric(name: string): Promise<MetricData | undefined> {
    const { resourceMetrics } = await reader.collect();
    return resourceMetrics.scopeMetrics.flatMap((s) => s.metrics).find((m) => m.descriptor.name === name);
  }

  it('NFR-11 each attempt is one http.request client span with only the allowed attributes', () => {
    const inst = instrumentation();
    inst.start({ connection: 'magento', method: 'GET', host: 'shop.example' }).end({ status: 200 });
    inst.start({ connection: 'magento', method: 'PUT', host: 'shop.example' }).end({ errorCode: 'timeout' });
    inst.start({ connection: 'magento', method: 'GET', host: 'shop.example' }).end({ status: 503 });
    inst.start({ connection: 'magento', method: 'GET', host: 'shop.example' }).end({ status: 404 });

    const finished = spans.getFinishedSpans();
    expect(finished).toHaveLength(4);
    const [ok, timeout, unavailable, notFound] = finished;

    expect(ok?.name).toBe('http.request');
    expect(ok?.kind).toBe(SpanKind.CLIENT);
    expect(ok?.attributes).toEqual({
      'http.request.method': 'GET',
      'server.address': 'shop.example',
      'aiops.connection': 'magento',
      'http.response.status_code': 200,
    });
    expect(ok?.status.code).toBe(SpanStatusCode.UNSET);

    expect(timeout?.name).toBe('http.request');
    expect(timeout?.attributes).toEqual({
      'http.request.method': 'PUT',
      'server.address': 'shop.example',
      'aiops.connection': 'magento',
      'error.type': 'timeout',
    });
    expect(timeout?.status.code).toBe(SpanStatusCode.ERROR);

    expect(unavailable?.attributes).toEqual({
      'http.request.method': 'GET',
      'server.address': 'shop.example',
      'aiops.connection': 'magento',
      'http.response.status_code': 503,
      'error.type': '503',
    });
    expect(unavailable?.status.code).toBe(SpanStatusCode.ERROR);

    expect(notFound?.attributes).toEqual({
      'http.request.method': 'GET',
      'server.address': 'shop.example',
      'aiops.connection': 'magento',
      'http.response.status_code': 404,
      'error.type': '404',
    });
    expect(notFound?.status.code).toBe(SpanStatusCode.ERROR);
  });

  it('NFR-11 the span is a child of the active span and its traceparent names it', () => {
    const inst = instrumentation();
    const parent = tracerProvider.getTracer('parent').startSpan('mcp.tool_call');
    const parentContext = parent.spanContext();

    const span = context.with(trace.setSpan(context.active(), parent), () =>
      inst.start({ connection: 'magento', method: 'GET', host: 'shop.example' }),
    );
    span.end({ status: 200 });
    parent.end();

    const child = spans.getFinishedSpans().find((s) => s.name === 'http.request');
    expect(child?.parentSpanId).toBe(parentContext.spanId);
    expect(child?.spanContext().traceId).toBe(parentContext.traceId);
    const childSpanId = child?.spanContext().spanId ?? '';
    expect(childSpanId).not.toBe(parentContext.spanId);
    expect(span.headers.traceparent).toMatch(new RegExp(`^00-${parentContext.traceId}-${childSpanId}-01$`));
    // Only W3C trace context; no baggage or other propagator headers (ruling R-prop).
    expect(Object.keys(span.headers)).toEqual(['traceparent']);
  });

  it('NFR-11 NFR-12 a second end of the same attempt is ignored', async () => {
    const span = instrumentation().start({ connection: 'magento', method: 'GET', host: 'shop.example' });
    span.end({ status: 200 });
    span.end({ status: 503 });

    expect(spans.getFinishedSpans()).toHaveLength(1);
    const counter = await metric('aiops_upstream_requests_total');
    expect((counter?.dataPoints ?? []).map((p) => ({ attributes: p.attributes, value: p.value }))).toEqual([
      { attributes: { connection: 'magento', outcome: 'ok' }, value: 1 },
    ]);
    const histogram = (await metric('aiops_upstream_request_duration_seconds')) as HistogramMetricData | undefined;
    expect(histogram?.dataPoints.map((p) => p.value.count)).toEqual([1]);
  });

  it('NFR-12 upstream outcome classification', () => {
    expect(upstreamOutcome({ status: 200 })).toBe('ok');
    expect(upstreamOutcome({ status: 304 })).toBe('ok');
    expect(upstreamOutcome({ status: 404 })).toBe('client_error');
    expect(upstreamOutcome({ status: 500 })).toBe('server_error');
    expect(upstreamOutcome({ status: 503 })).toBe('server_error');
    expect(upstreamOutcome({ errorCode: 'network' })).toBe('network');
    expect(upstreamOutcome({ errorCode: 'egress_denied' })).toBe('network');
    expect(upstreamOutcome({})).toBe('network');
  });

  it('NFR-12 requests are counted per connection and outcome and timed per connection', async () => {
    const inst = instrumentation();
    inst.start({ connection: 'magento', method: 'GET', host: 'shop.example' }).end({ status: 200 });
    inst.start({ connection: 'magento', method: 'GET', host: 'shop.example' }).end({ status: 503 });

    const counter = await metric('aiops_upstream_requests_total');
    expect(counter?.dataPointType).toBe(DataPointType.SUM);
    const points = (counter?.dataPoints ?? []).map((p) => ({ attributes: p.attributes, value: p.value }));
    expect(points).toHaveLength(2);
    expect(points).toEqual(
      expect.arrayContaining([
        { attributes: { connection: 'magento', outcome: 'ok' }, value: 1 },
        { attributes: { connection: 'magento', outcome: 'server_error' }, value: 1 },
      ]),
    );

    const histogram = (await metric('aiops_upstream_request_duration_seconds')) as HistogramMetricData | undefined;
    expect(histogram?.dataPointType).toBe(DataPointType.HISTOGRAM);
    expect(histogram?.descriptor.unit).toBe('s');
    expect(histogram?.dataPoints).toHaveLength(1);
    const point = histogram?.dataPoints[0];
    expect(point?.attributes).toEqual({ connection: 'magento' });
    expect(point?.value.count).toBe(2);
    expect(point?.value.buckets.boundaries).toEqual(UPSTREAM_BUCKETS);
  });
});
