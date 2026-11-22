# ADR 0047: The Temporal trace header is plaintext W3C context

- Status: Accepted
- Date: 2026-11-19

Refs: NFR-11, SEC-4, SEC-3, EXE-2, EXE-10

## Context

[ADR 0042](0042-rollback-audit-configuration-observability.md) puts the Temporal OpenTelemetry plugin
(`@temporalio/interceptors-opentelemetry` 1.25.0) on the worker and its client interceptor on the
api client, so that one trace runs from the MCP call through the workflow and its activities
(NFR-11). The plugin carries the trace context in the Temporal header `_tracer-data`. ADR 0042's
"Verified" section read `payload-visitor.ts` ("headers are visited unless `skipHeaders` is set")
and concluded that the encrypting codec (SEC-4) also encodes that header.

That claim is wrong: the SDK sets `skipHeaders: true` on both sides. The source confirms it, and
an experiment confirmed it end to end (see "Verified").

## Options considered

1. **Accept a plaintext trace header that holds only W3C trace context.** `_tracer-data` holds
   `{ traceparent, tracestate? }` as `json/plain`. Every other payload stays `binary/encrypted`.
   A test checks the header's content by shape, as is done for the SDK patch payloads.
2. **Encrypt the header ourselves.** We would wrap the SDK's client, workflow and activity
   interceptors with our own, which encode `_tracer-data` with the codec before the SDK writes it
   and decode it before the SDK reads it. Our interceptors would sit inside the workflow sandbox,
   would run on every replay, and would carry key material into code that handles workflow
   determinism. All of this protects a trace ID and a span ID.
3. **Use no workflow interceptors (the fallback of ADR 0042).** This does not help: the client
   interceptor still writes `_tracer-data` in plaintext on start, signal and signal-with-start.
   It also loses the workflow and activity-schedule spans.

## Decision

Option 1. The `_tracer-data` header carries only W3C trace context (`traceparent`, optionally
`tracestate`) and is not encoded by the codec. Every other payload in Temporal history stays
`binary/encrypted` (SEC-4). Nothing is added to workflow inputs, signals or activity arguments
(EXE-2). The workflows get the plugin's workflow interceptors: the fallback was not taken
(`WORKFLOW_TRACING = true`).

SEC-4 is about payloads that carry business data. A `traceparent` is a random 128-bit trace ID, a
random 64-bit span ID and a flag byte. It carries no credential, argument, item value or user
identifier (SEC-3). A `tracestate` is the W3C vendor list of the incoming context, and nothing
in this system sets one. The SDK's default global propagator (`NodeTracerProvider.register()`)
also propagates W3C baggage, and nothing here sets baggage. A `baggage` key in the header would
fail the test below.

## Consequences

- [SPEC](../SPEC.md) SEC-4 gains the clause "(the `_tracer-data` header carries only W3C trace
  context and is not encoded; ADR 0047)".
- The traced-history test (`apps/worker/test/integration/tracing.int.test.ts`,
  `SEC-4 SEC-3 the trace header carries only W3C trace context and every other payload is
  encrypted`) checks two things. Each `_tracer-data` header (workflow start, every activity
  schedule) decodes to keys from `{traceparent, tracestate}`, with a valid `traceparent` of the
  caller's trace. Every other payload is `binary/encrypted`. The exemption
  (`isTraceHeader`, `apps/worker/test/support/history.ts`) accepts that shape only under that key.
  Any other content is reported as `json/plain`.
- The replay gate's walk over committed fixtures does not exempt trace headers. The fixtures were
  recorded without the plugin and stay strict.
- If a later SDK version runs headers through the codec, the header turns `binary/encrypted` and
  the traced-history test fails. We then remove the exemption.
- If the propagator is ever changed to inject more than W3C context (baggage, for example), the
  same test fails.

## Verified

Checked on 2026-11-19 in the installed packages under `node_modules/.pnpm`. The versions were
`@temporalio/interceptors-opentelemetry@1.25.0`, `@temporalio/client@1.25.0` and
`@temporalio/worker@1.25.0`.

- `@temporalio/interceptors-opentelemetry` `src/instrumentation.ts:32` sets
  `const payloadConverter = defaultPayloadConverter`. `headersWithContext` (`:62-66`) injects the
  active context with the global propagator into a plain carrier and stores
  `payloadConverter.toPayload(carrier)` under `TRACE_HEADER = '_tracer-data'` (`:14`). That is a
  `json/plain` payload. `src/client/index.ts:57` (start) and `:72` (signal) call it, and so does
  the workflow outbound interceptor, `src/workflow/index.ts:178` (`scheduleActivity`).
- `@temporalio/client` `lib/workflow-client.js` passes headers raw as `header: { fields: … }` in
  `_queryWorkflowHandler` (`:484`), `_createUpdateWorkflowRequest` (`:552`),
  `_signalWorkflowHandler` (`:788`), `_signalWithStartWorkflowHandler` (`:860`) and
  `createStartWorkflowRequest` (`:973`). Only inputs, memo and signal arguments pass the codec.
- `@temporalio/worker` `lib/workflow-codec-runner.js` passes `skipHeaders: true` in the visitor
  options for decoding activations (`:115`) and for encoding completions (`:179`). Headers of
  activity schedules written by the workflow therefore reach history unencoded.
- `@opentelemetry/sdk-trace-base@1.30.1` `build/src/BasicTracerProvider.js:192` and `:211`:
  `register()` without a propagator installs a `CompositePropagator` of W3C trace context and
  W3C baggage.
- Experiment:
  `cd apps/worker && pnpm exec vitest run --project integration test/integration/replay.int.test.ts test/integration/tracing.int.test.ts`
  gave `Test Files 2 passed (2)`, `Tests 70 passed (70)`. The traced-history case found
  `_tracer-data` as `json/plain` with only a `traceparent` of the root span's trace, on the
  started event and on every `activityTaskScheduled` event. Every other payload was
  `binary/encrypted`. All 29 committed histories replay with the plugin installed. The bundle
  grew from 1.81 MB to 3.47 MB with the interceptor modules, so the interceptors were really
  installed. With the sink temporarily marked `callDuringReplay: true` (a mutation in
  `lib/worker/index.js`, reverted), the "replay exports no workflow span" case failed with 184
  `StartActivity:*` spans. Without the mutation, replay exports none.
