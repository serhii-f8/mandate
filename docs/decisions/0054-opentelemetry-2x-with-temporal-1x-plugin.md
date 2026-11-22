# ADR 0054: OpenTelemetry 2.x beside the Temporal plugin's own 1.x SDK

- Status: Accepted
- Date: 2026-11-20

Refs: SEC-11, NFR-11, NFR-12, EXE-10

## Context

The dependency gate (SEC-11, [ADR 0053](0053-release-readiness.md)) blocks two high advisories in the OpenTelemetry
set that the api, the worker and `packages/upstream` pinned at SDK 1.30.1 / experimental 0.57.2:
GHSA-q7rr-3cgh-j5r3 (`@opentelemetry/exporter-prometheus` < 0.217.0, crash on a malformed
request) and GHSA-45rx-2jwx-cxfr (`@opentelemetry/propagator-jaeger` < 2.9.0, a dependency of
`sdk-trace-node` 1.x). Both fixes exist only on the 2.x / 0.2xx line, so the upgrade is a major
migration (`new Resource()` is gone; `ReadableSpan` has `parentSpanContext` and
`instrumentationScope` instead of `parentSpanId` and `instrumentationLibrary`).

`@temporalio/interceptors-opentelemetry` (1.25.0 installed, 1.26.0 newest) declares no
OpenTelemetry peer ranges. It has **dependencies** `@opentelemetry/core`, `resources` and
`sdk-trace-base` `^1.25.1`, so it keeps its own 1.x copies. Its workflow tracer runs in the
isolate on that 1.x SDK, and the sink (`makeWorkflowExporter`, `lib/worker/index.js`) rebuilds
each workflow span from the 1.x serialised shape and calls `spanProcessor.onEnd(span)` on the
processor we pass. The upgrade is acceptable only if workflow spans keep their parent linkage
through a 2.x processor; a fallback was named in case they do not.

## Options considered

1. **2.x as is.** Pass a 2.x processor to the plugin. Workflow spans arrive with `parentSpanId`
   and `instrumentationLibrary`, which the 2.x OTLP transformer does not read: the parent is
   dropped, and `instrumentationScope.name` is read on `undefined` when the spans are grouped
   for export. Rejected (RED below).
2. **The fallback: the tracer stays on `sdk-trace-base` 1.x plus `context-async-hooks`,
   only metrics move to 2.x.** It clears both highs (no `sdk-trace-node`, so no
   `propagator-jaeger`). But the tracer needs a 1.x `Resource` and the meter provider a 2.x one,
   so `@opentelemetry/resources` would have to be installed twice under an npm alias. The api
   and worker would keep `@opentelemetry/core` 1.x (the moderate GHSA-8988-4f7v-96qf) as direct
   dependencies, and `exporter-trace-otlp-http` would stay on 0.57.2, a line that gets no more
   fixes.
3. **2.x everywhere, plus a small adapter at the plugin boundary.** `createTracingPlugin` wraps
   our 2.x processor in `workflowSpanProcessor`, which maps each sink span to the 2.x shape
   (`parentSpanId` -> `parentSpanContext` of the same trace and trace flags,
   `instrumentationLibrary` -> `instrumentationScope`, defaulting to
   `@temporalio/interceptor-workflow` when the sink data lacks it, so one bad span cannot make the
   serializer throw and drop the whole batch; the worker's 2.x resource). Activity and client spans
   already come from our 2.x tracer through the shared `@opentelemetry/api` 1.9.1.

## Decision

Option 3. The condition is that workflow spans keep their parent linkage through a 2.x
processor; with the adapter they do, and the tracing integration test proves it on the 2.x
fields. Option 2 meets the gate too, but keeps two `resources` majors and the 1.x core in our own
tree for no gain.

Versions (all exact pins, all at least 14 days old under pnpm `minimumReleaseAge`, no new
exclusions): SDK `core`, `resources`, `sdk-metrics`, `sdk-trace-base`, `sdk-trace-node`,
`context-async-hooks` **2.12.0** (2026-10-06); `exporter-prometheus`, `exporter-trace-otlp-http`
**0.223.0** (2026-10-06); `@opentelemetry/api` stays 1.9.1. 2.12.1 / 0.223.1 (2026-11-09) were
11 days old and so not eligible. `sdk-trace-node` 2.12.0 no longer depends on
`propagator-jaeger` at all; GitHub lists 2.9.0 as its first patched version.

Three 2.x behaviour changes are handled explicitly:

- **Prometheus exposition.** 0.2xx adds `otel_scope_name`/`otel_scope_version` labels to every
  series by default; 0.57 did not. Both exporters pass `withoutScopeInfo: true`, so the scrape
  text keeps the 0.57 series (the Phase 8 acceptance matches series lines).
- **Default resource.** 1.x providers merged `Resource.default()` (`telemetry.sdk.*`) into the
  resource they were given; 2.x providers use the given resource as is, and
  `resourceFromAttributes` does not merge the default. The api and worker build
  `defaultResource().merge(resourceFromAttributes({ 'service.name': ... }))`, so `target_info` and
  the OTLP resource carry `service_name` and `telemetry_sdk_language/name/version` as before (only
  the SDK version changes). The workflow resource in `createTracingPlugin` stays
  `service.name` only: 1.x passed `new Resource({...})` to the plugin unmerged, too.
- **OTLP retries.** The 0.2xx HTTP exporter retries a refused or timed-out export with backoff
  (1 s initial, x1.5, 5 attempts) until its export timeout, 10 s by default; 0.57 failed at once.
  With the collector down, the final flush on shutdown would then take up to about 10 s, which a
  10 s stop grace (the Compose default) can cut off with SIGKILL. The api and worker set the
  OTLP exporter's `timeoutMillis` to 2 s (`OTLP_EXPORT_TIMEOUT_MS`), which bounds each export,
  retries included. We chose this over racing `shutdown()` against a timer: a race returns early
  but leaves the retry timers and sockets keeping the process alive. A collector that needs more
  than 2 s per export loses that batch; the deployment's collector is on the same network.

The remaining moderates get allowlist entries with reasons: `@opentelemetry/core`
1.30.1 through the Temporal plugin, and the dev- or test-only `esbuild`, `glob` and `minimatch`,
whose parents' ranges admit no patched version.

## Consequences

- Workflow spans reach the exporter in the 2.x shape. The adapter's type comes from the plugin's
  own option types (`ConstructorParameters<typeof OpenTelemetryPlugin>`), so a Temporal release
  that moves the plugin to 2.x changes `WorkflowSinkSpan` and fails the type-check of
  `tracing.ts`; then the adapter goes.
- The parent of a workflow span is marked neither local nor remote (`isRemote` unset): the sink
  data does not say which. OTLP then sets `HAS_IS_REMOTE` without `IS_REMOTE`.
- The plugin's option type names its 1.x `Resource` class; we pass the 2.x resource with one
  lint suppression, because the plugin only copies it onto sink spans and the adapter replaces it.
- With the collector down, the last telemetry flush on shutdown ends within about 1-2 s (measured
  about 1 s in the "unreachable collector" unit tests, which run under the default 5 s test
  timeout); it runs after the worker has drained and the api has closed its listeners.
- The `@opentelemetry/core` 1.x moderate stays until Temporal ships a 2.x plugin. Its flaw is in
  W3C baggage extraction, which only the plugin's isolate tracer runs (its 1.x
  `BasicTracerProvider.register()` builds `tracecontext,baggage` from the default
  `OTEL_PROPAGATORS`), on `_tracer-data` headers that only our api and worker write, with a global
  propagator that injects W3C trace context only ([ADR 0047](0047-trace-header-plaintext-w3c-context.md)). The allowlist entry expires
  2027-02-18.
- Replay fixtures are unchanged and replay unchanged: the workflow bundle still contains only the
  plugin's own 1.x workflow code, and sinks do not run during replay.

## Verified

2026-11-20.

- `npm view @temporalio/interceptors-opentelemetry@latest dependencies peerDependencies` ->
  version 1.26.0 (2026-11-17), dependencies `@opentelemetry/core`, `resources`, `sdk-trace-base`
  `^1.25.1`, `@opentelemetry/api` `^1.9.0`; peers only `@temporalio/common` and `workflow`.
  The installed 1.25.0 `package.json` has the same dependencies.
- Plugin source, `node_modules/.pnpm/@temporalio+interceptors-opentelemetry@1.25.0_.../.../lib/`:
  `plugin.js` `injectSinks` -> `makeWorkflowExporter(spanProcessor, resource)`;
  `worker/index.js` `extractReadableSpan` spreads the serialised span and sets `resource`, then
  `processorOrExporter.onEnd(span)`; `workflow/span-exporter.js` `makeSerializable` writes
  `parentSpanId` and `instrumentationLibrary`; `workflow/index.js` creates a 1.x
  `BasicTracerProvider` and calls `register({ contextManager })`.
- `@opentelemetry/otlp-transformer@0.223.0` `build/src/trace/internal.js`: `parentSpanId` comes
  from `span.parentSpanContext?.spanId`, the scope key from `record.instrumentationScope.name`.
- `npm view @opentelemetry/sdk-trace-node@2.12.0 dependencies` -> `core`, `sdk-trace-base`,
  `context-async-hooks` 2.12.0 (no `propagator-jaeger`).
  `gh api /advisories/GHSA-45rx-2jwx-cxfr` -> first patched 2.9.0;
  `/advisories/GHSA-q7rr-3cgh-j5r3` -> first patched 0.217.0;
  `/advisories/GHSA-8988-4f7v-96qf` -> `@opentelemetry/core` first patched 2.8.0.
- RED with option 1 (2.x processor passed straight to the plugin):
  `cd apps/worker && pnpm exec vitest run --project integration test/integration/tracing.int.test.ts`
  -> 2 failed: "the workflow span is exported when the workflow closes"
  (`expected undefined to be '646206ad88f6378f'` on `parentSpanContext?.spanId`) and
  "workflow spans reach the 2.x span processor in its span shape" (`expected undefined to deeply
  equal ObjectContaining{...}`).
- GREEN with option 3: the same command plus `test/integration/replay.int.test.ts` -> 2 files,
  86 tests passed, including all 13 `-traced` replays.
- `exporter-prometheus@0.223.0` `build/src/export/types.d.ts`: `withoutScopeInfo` ("scope labels
  are included" by default), `withoutTargetInfo`; the 0.57.2 `PrometheusSerializer.js` emits
  `target_info` and no scope labels.
- Experiment (scratch scripts, a `MeterProvider` with one counter scraped over HTTP): 0.57.2 with
  1.30.1 and `new Resource({ 'service.name': 'mandate-worker' })` ->
  `target_info{service_name="mandate-worker",telemetry_sdk_language="nodejs",telemetry_sdk_name="opentelemetry",telemetry_sdk_version="1.30.1"} 1`
  and `mandate_probe_total 1`; 0.223.0 with 2.12.0, `withoutScopeInfo: true` and
  `defaultResource().merge(resourceFromAttributes(...))` -> the same two lines with
  `telemetry_sdk_version="2.12.0"`. Without the merge, 2.x printed
  `target_info{service_name="mandate-worker"} 1`.
  `sdk-metrics@2.12.0` `MeterProvider.js` uses `options?.resource ?? defaultResource()`;
  `sdk-trace-base@1.30.1` `BasicTracerProvider.js` did `Resource.default().merge(this.resource)`.
  The api and worker unit tests now match the full `target_info` line and the span resource's
  `telemetry.sdk.*` attributes.
- `JsonTraceSerializer` (`@opentelemetry/otlp-transformer@0.223.0`, a worker devDependency) over
  spans from `workflowSpanProcessor` keeps `parentSpanId`, the scope name and `service.name`;
  before the scope default, a sink span without `instrumentationLibrary` threw
  `Cannot read properties of undefined (reading 'name')` (`src/telemetry/tracing.test.ts`).
- `otlp-exporter-base@0.223.0` `build/src/retrying-transport.js`: `MAX_ATTEMPTS = 5`,
  `INITIAL_BACKOFF = 1000`, `BACKOFF_MULTIPLIER = 1.5`; `transport/http-transport-utils.js`
  treats `ECONNREFUSED` as retryable.
- `bash scripts/dependency-scan.sh` -> four `allowed ... (moderate)` lines,
  `dependency audit gate: pass`, exit 0.
