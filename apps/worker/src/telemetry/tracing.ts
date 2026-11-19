/**
 * Temporal tracing for the worker (NFR-11). The SDK's OpenTelemetry plugin adds the client,
 * activity and workflow interceptors; workflow spans leave the sandbox through a sink into
 * `spanProcessor` (sinks are not called during replay). Trace context travels only in the
 * `_tracer-data` header as W3C `traceparent`/`tracestate`; Temporal does not encode headers
 * with the codec, every other payload stays encrypted (SEC-4, ADR 0047).
 *
 * The activity and client interceptors use the global tracer and propagator, so the process
 * registers a tracer provider before it creates the worker.
 */
import { Resource } from '@opentelemetry/resources';
import type { SpanProcessor } from '@opentelemetry/sdk-trace-base';
import { OpenTelemetryPlugin } from '@temporalio/interceptors-opentelemetry';

/** `true`: workflows run with the plugin's workflow interceptors (Task 1 experiment, ADR 0042). */
// Typed `boolean`, not the literal: callers branch on it, and the fallback would set it to false.
// eslint-disable-next-line @typescript-eslint/no-inferrable-types
export const WORKFLOW_TRACING: boolean = true;

/** The plugin for the production worker and the replay worker (NFR-11); `spanProcessor` gets the workflow spans from the sink. */
export function createTracingPlugin(options: { readonly spanProcessor: SpanProcessor; readonly serviceName: string }): OpenTelemetryPlugin {
  return new OpenTelemetryPlugin({
    resource: new Resource({ 'service.name': options.serviceName }),
    spanProcessor: options.spanProcessor,
  });
}
