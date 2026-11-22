// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Mandate Authors
import { SpanKind, SpanStatusCode, TraceFlags } from '@opentelemetry/api';
import { JsonTraceSerializer } from '@opentelemetry/otlp-transformer';
import { resourceFromAttributes } from '@opentelemetry/resources';
import type { ReadableSpan, SpanProcessor } from '@opentelemetry/sdk-trace-base';
import { describe, expect, it } from 'vitest';
import { workflowSpanProcessor, type WorkflowSinkSpan } from './tracing.js';

const resource = resourceFromAttributes({ 'service.name': 'mandate-worker' });

/** A span as the plugin's sink builds it from the workflow isolate (1.x SDK shape). */
function sinkSpan(parentSpanId: string | undefined): WorkflowSinkSpan {
  const spanContext = { traceId: '0af7651916cd43dd8448eb211c80319c', spanId: 'b7ad6b7169203331', traceFlags: TraceFlags.SAMPLED };
  return {
    name: 'RunWorkflow:changesetWorkflow',
    kind: SpanKind.INTERNAL,
    spanContext: () => spanContext,
    ...(parentSpanId === undefined ? {} : { parentSpanId }),
    startTime: [1, 0],
    endTime: [2, 0],
    status: { code: SpanStatusCode.OK },
    attributes: { workflowId: 'wf-1' },
    links: [],
    events: [{ name: 'e', time: [1, 5] }],
    duration: [1, 0],
    ended: true,
    // The plugin stores whatever resource it was given; the adapter replaces it.
    resource: { attributes: { 'service.name': 'stale' } } as unknown as WorkflowSinkSpan['resource'], // test stub; only `attributes` is read
    instrumentationLibrary: { name: '@temporalio/interceptor-workflow', version: '1.25.0' },
    droppedAttributesCount: 0,
    droppedEventsCount: 0,
    droppedLinksCount: 0,
  };
}

/** The span without `instrumentationLibrary`: the type requires it, but the sink's data may lack it. */
function withoutScope(span: WorkflowSinkSpan): WorkflowSinkSpan {
  const copy: Record<string, unknown> = { ...span };
  Reflect.deleteProperty(copy, 'instrumentationLibrary');
  return copy as unknown as WorkflowSinkSpan; // test stub: deliberately violates the declared type
}

function recorder(): SpanProcessor & { readonly ended: ReadableSpan[]; readonly flushed: () => number; readonly shutDown: () => number } {
  const ended: ReadableSpan[] = [];
  let flushes = 0;
  let shutdowns = 0;
  return {
    ended,
    flushed: () => flushes,
    shutDown: () => shutdowns,
    onStart: () => undefined,
    onEnd: (span) => ended.push(span),
    forceFlush: () => {
      flushes += 1;
      return Promise.resolve();
    },
    shutdown: () => {
      shutdowns += 1;
      return Promise.resolve();
    },
  };
}

describe('NFR-11 workflow span processor (OpenTelemetry 2.x span shape)', () => {
  it('NFR-11 maps the parent span ID to a parent span context of the same trace', () => {
    const target = recorder();
    workflowSpanProcessor(target, resource).onEnd(sinkSpan('00f067aa0ba902b7'));
    const [span] = target.ended;
    expect(span?.parentSpanContext).toEqual({ traceId: '0af7651916cd43dd8448eb211c80319c', spanId: '00f067aa0ba902b7', traceFlags: TraceFlags.SAMPLED });
    expect(span?.spanContext().spanId).toBe('b7ad6b7169203331');
    expect(span).not.toHaveProperty('parentSpanId');
  });

  it('NFR-11 a root workflow span has no parent span context', () => {
    const target = recorder();
    const processor = workflowSpanProcessor(target, resource);
    processor.onEnd(sinkSpan(undefined));
    processor.onEnd(sinkSpan(''));
    expect(target.ended.map((s) => s.parentSpanContext)).toEqual([undefined, undefined]);
  });

  it('NFR-11 carries the instrumentation scope, the worker resource and the span data', () => {
    const target = recorder();
    workflowSpanProcessor(target, resource).onEnd(sinkSpan('00f067aa0ba902b7'));
    const [span] = target.ended;
    expect(span?.instrumentationScope).toEqual({ name: '@temporalio/interceptor-workflow', version: '1.25.0' });
    expect(span).not.toHaveProperty('instrumentationLibrary');
    expect(span?.resource).toBe(resource);
    expect(span).toMatchObject({ name: 'RunWorkflow:changesetWorkflow', attributes: { workflowId: 'wf-1' }, startTime: [1, 0], endTime: [2, 0], ended: true });
  });

  it('NFR-11 a sink span without an instrumentation library gets the workflow interceptor scope', () => {
    const target = recorder();
    workflowSpanProcessor(target, resource).onEnd(withoutScope(sinkSpan('00f067aa0ba902b7')));
    expect(target.ended[0]?.instrumentationScope).toEqual({ name: '@temporalio/interceptor-workflow' });
  });

  it('NFR-11 the OTLP JSON serializer keeps the parent span ID, the scope and the resource of a workflow span', () => {
    const target = recorder();
    const processor = workflowSpanProcessor(target, resource);
    processor.onEnd(sinkSpan('00f067aa0ba902b7'));
    processor.onEnd(withoutScope(sinkSpan('00f067aa0ba902b7')));
    const body: unknown = JSON.parse(new TextDecoder().decode(JsonTraceSerializer.serializeRequest(target.ended)));
    const [resourceSpans] = (body as { resourceSpans: { resource: { attributes: { key: string; value: { stringValue?: string } }[] }; scopeSpans: { scope: { name: string }; spans: { parentSpanId?: string; spanId: string }[] }[] }[] }).resourceSpans;
    expect(resourceSpans?.resource.attributes).toContainEqual({ key: 'service.name', value: { stringValue: 'mandate-worker' } });
    expect(resourceSpans?.scopeSpans.map((s) => s.scope.name)).toEqual(['@temporalio/interceptor-workflow', '@temporalio/interceptor-workflow']);
    const spans = resourceSpans?.scopeSpans.flatMap((s) => s.spans) ?? [];
    expect(spans.map((s) => [s.parentSpanId, s.spanId])).toEqual([
      ['00f067aa0ba902b7', 'b7ad6b7169203331'],
      ['00f067aa0ba902b7', 'b7ad6b7169203331'],
    ]);
  });

  it('NFR-11 forwards flush and shutdown to the target processor', async () => {
    const target = recorder();
    const processor = workflowSpanProcessor(target, resource);
    await processor.forceFlush();
    await processor.shutdown();
    expect([target.flushed(), target.shutDown()]).toEqual([1, 1]);
  });
});
