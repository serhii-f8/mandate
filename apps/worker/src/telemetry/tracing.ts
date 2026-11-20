/**
 * Temporal tracing for the worker (NFR-11). The SDK's OpenTelemetry plugin adds the client,
 * activity and workflow interceptors; workflow spans leave the sandbox through a sink into
 * `spanProcessor` (sinks are not called during replay). Trace context travels only in the
 * `_tracer-data` header as W3C `traceparent`/`tracestate`; Temporal does not encode headers
 * with the codec, every other payload stays encrypted (SEC-4, ADR 0047).
 *
 * The activity and client interceptors use the global tracer and propagator, so the process
 * registers a tracer provider before it creates the worker.
 *
 * The plugin keeps its own OpenTelemetry 1.x SDK (a dependency of
 * `@temporalio/interceptors-opentelemetry`), so the sink hands over workflow spans in the 1.x
 * shape (`parentSpanId`, `instrumentationLibrary`). The worker runs the 2.x SDK, whose OTLP
 * exporter reads `parentSpanContext` and `instrumentationScope`; `workflowSpanProcessor` maps
 * one shape to the other (ADR 0054).
 */
import { resourceFromAttributes, type Resource } from '@opentelemetry/resources';
import type { ReadableSpan, SpanProcessor } from '@opentelemetry/sdk-trace-base';
import { OpenTelemetryPlugin } from '@temporalio/interceptors-opentelemetry';

/** `true`: workflows run with the plugin's workflow interceptors (Task 1 experiment, ADR 0042). */
// Typed `boolean`, not the literal: callers branch on it, and the fallback would set it to false.
// eslint-disable-next-line @typescript-eslint/no-inferrable-types
export const WORKFLOW_TRACING: boolean = true;

type PluginOptions = ConstructorParameters<typeof OpenTelemetryPlugin>[0];
/** The span processor type of the plugin's own (1.x) SDK. */
type PluginSpanProcessor = PluginOptions['spanProcessor'];
/** A workflow span as the plugin's sink passes it to `onEnd` (1.x `ReadableSpan`). */
export type WorkflowSinkSpan = Parameters<PluginSpanProcessor['onEnd']>[0];

/** The scope of the plugin's workflow tracer, for a sink span that carries none. */
const WORKFLOW_SCOPE = { name: '@temporalio/interceptor-workflow' } as const;

/** The 2.x form of a sink span: the parent becomes a span context of the same trace, the library a scope. */
function toReadableSpan(span: WorkflowSinkSpan, resource: Resource): ReadableSpan {
  const own = span.spanContext();
  // A workflow span's parent is in its own trace (the isolate continues the extracted context).
  const parent = span.parentSpanId;
  return {
    name: span.name,
    kind: span.kind,
    spanContext: () => own,
    ...(parent === undefined || parent === '' ? {} : { parentSpanContext: { traceId: own.traceId, spanId: parent, traceFlags: own.traceFlags } }),
    startTime: span.startTime,
    endTime: span.endTime,
    status: span.status,
    attributes: span.attributes,
    links: span.links,
    events: span.events,
    duration: span.duration,
    ended: span.ended,
    resource,
    // Typed as required, but the span crossed the isolate as plain data; a missing scope would make
    // the OTLP serializer throw and drop the whole batch, api and activity spans included.
    // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition
    instrumentationScope: span.instrumentationLibrary ?? WORKFLOW_SCOPE,
    droppedAttributesCount: span.droppedAttributesCount,
    droppedEventsCount: span.droppedEventsCount,
    droppedLinksCount: span.droppedLinksCount,
  };
}

/**
 * The processor the plugin's sink calls: each workflow span reaches `target` in the 2.x shape with
 * the worker's `resource`. The sink only calls `onEnd`; `onStart` is a no-op.
 */
export function workflowSpanProcessor(target: SpanProcessor, resource: Resource): PluginSpanProcessor {
  return {
    onStart: () => undefined,
    onEnd: (span: WorkflowSinkSpan) => {
      target.onEnd(toReadableSpan(span, resource));
    },
    forceFlush: () => target.forceFlush(),
    shutdown: () => target.shutdown(),
  };
}

/** The plugin for the production worker and the replay worker (NFR-11); `spanProcessor` gets the workflow spans from the sink. */
export function createTracingPlugin(options: { readonly spanProcessor: SpanProcessor; readonly serviceName: string }): OpenTelemetryPlugin {
  const resource = resourceFromAttributes({ 'service.name': options.serviceName });
  return new OpenTelemetryPlugin({
    // The plugin's type names its 1.x `Resource` class, but the plugin only copies the value onto
    // each sink span (lib/worker/index.js `extractReadableSpan`), and `workflowSpanProcessor` sets
    // it again on the 2.x span; no 1.x class method is ever called on it.
    // eslint-disable-next-line @typescript-eslint/no-unsafe-class-instance-assignment
    resource,
    spanProcessor: workflowSpanProcessor(options.spanProcessor, resource),
  });
}
