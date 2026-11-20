import { SpanKind, SpanStatusCode, TraceFlags } from '@opentelemetry/api';
import { resourceFromAttributes } from '@opentelemetry/resources';
import type { ReadableSpan, SpanProcessor } from '@opentelemetry/sdk-trace-base';
import { describe, expect, it } from 'vitest';
import { workflowSpanProcessor, type WorkflowSinkSpan } from './tracing.js';

const resource = resourceFromAttributes({ 'service.name': 'aiops-worker' });

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

  it('NFR-11 forwards flush and shutdown to the target processor', async () => {
    const target = recorder();
    const processor = workflowSpanProcessor(target, resource);
    await processor.forceFlush();
    await processor.shutdown();
    expect([target.flushed(), target.shutDown()]).toEqual([1, 1]);
  });
});
