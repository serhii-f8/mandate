// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The AI Operations Layer Authors
import { SpanKind, SpanStatusCode } from '@opentelemetry/api';
import {
  AggregationTemporality,
  InMemoryMetricExporter,
  MeterProvider,
  PeriodicExportingMetricReader,
  type MetricData,
} from '@opentelemetry/sdk-metrics';
import { BasicTracerProvider, InMemorySpanExporter, SimpleSpanProcessor } from '@opentelemetry/sdk-trace-base';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createPipelineTelemetry, NO_TELEMETRY, UNKNOWN_TOOL } from './pipeline-telemetry.js';

describe('NFR-11 NFR-12 pipeline telemetry', () => {
  let spans: InMemorySpanExporter;
  let tracerProvider: BasicTracerProvider;
  let reader: PeriodicExportingMetricReader;
  let meterProvider: MeterProvider;

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

  function telemetry() {
    return createPipelineTelemetry({ tracer: tracerProvider.getTracer('test'), meter: meterProvider.getMeter('test') });
  }

  async function metric(name: string): Promise<MetricData | undefined> {
    const { resourceMetrics } = await reader.collect();
    return resourceMetrics.scopeMetrics.flatMap((s) => s.metrics).find((m) => m.descriptor.name === name);
  }

  it('NFR-11 toolCall runs inside an mcp.tool_call span with the bounded tool and the correlation ID', async () => {
    const t = telemetry();
    await expect(t.toolCall('ping', 'corr-1', () => Promise.resolve('pong'))).resolves.toBe('pong');
    await expect(t.toolCall(UNKNOWN_TOOL, 'corr-2', () => Promise.reject(new Error('boom')))).rejects.toThrow('boom');

    const finished = spans.getFinishedSpans();
    expect(finished).toHaveLength(2);
    const [ok, failed] = finished;
    expect(ok?.name).toBe('mcp.tool_call');
    expect(ok?.kind).toBe(SpanKind.INTERNAL);
    expect(ok?.attributes).toEqual({ 'aiops.tool': 'ping', 'aiops.correlation_id': 'corr-1' });
    expect(ok?.status.code).toBe(SpanStatusCode.UNSET);
    // The error message never becomes span content (SEC-3).
    expect(failed?.attributes).toEqual({ 'aiops.tool': '_unknown', 'aiops.correlation_id': 'corr-2' });
    expect(failed?.status).toEqual({ code: SpanStatusCode.ERROR });
    expect(failed?.events).toEqual([]);
  });

  it('NFR-12 counts land on aiops_tool_calls_total and aiops_policy_denials_total', async () => {
    const t = telemetry();
    t.countToolCall('ping', 'ok');
    t.countToolCall('ping', 'ok');
    t.countToolCall(UNKNOWN_TOOL, 'denied');
    t.countToolCall('catalog.search_products', 'error');
    t.countDenial('unknown_tool');
    t.countDenial('limit_exceeded');
    t.countDenial('limit_exceeded');

    const calls = await metric('aiops_tool_calls_total');
    expect(calls?.dataPoints.map((p) => ({ attributes: p.attributes, value: p.value }))).toEqual(
      expect.arrayContaining([
        { attributes: { tool: 'ping', outcome: 'ok' }, value: 2 },
        { attributes: { tool: '_unknown', outcome: 'denied' }, value: 1 },
        { attributes: { tool: 'catalog.search_products', outcome: 'error' }, value: 1 },
      ]),
    );
    expect(calls?.dataPoints).toHaveLength(3);
    const denials = await metric('aiops_policy_denials_total');
    expect(denials?.dataPoints.map((p) => ({ attributes: p.attributes, value: p.value }))).toEqual(
      expect.arrayContaining([
        { attributes: { reason: 'unknown_tool' }, value: 1 },
        { attributes: { reason: 'limit_exceeded' }, value: 2 },
      ]),
    );
    expect(denials?.dataPoints).toHaveLength(2);
  });

  it('NFR-11 NO_TELEMETRY runs the call and counts nothing', async () => {
    await expect(NO_TELEMETRY.toolCall('ping', 'corr-1', () => Promise.resolve(1))).resolves.toBe(1);
    NO_TELEMETRY.countToolCall('ping', 'ok');
    NO_TELEMETRY.countDenial('no_grant');
    expect(spans.getFinishedSpans()).toEqual([]);
  });
});
