// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The AI Operations Layer Authors
/**
 * Tracing through Temporal with the OpenTelemetry plugin and the encrypting codec on (NFR-11,
 * SEC-4, ADR 0047): one trace runs from the caller through the workflow start, the workflow's
 * activity schedules and the activity runs, and the only plaintext the trace adds to history is
 * the W3C context in the `_tracer-data` header.
 */
import type { ReadPage, UpstreamReader } from '@aiops/core';
import { trace, type Span } from '@opentelemetry/api';
import { InMemorySpanExporter, SimpleSpanProcessor, type ReadableSpan } from '@opentelemetry/sdk-trace-base';
import { NodeTracerProvider } from '@opentelemetry/sdk-trace-node';
import { ScriptedWriter } from '@aiops/testing';
import { OpenTelemetryWorkflowClientInterceptor } from '@temporalio/interceptors-opentelemetry';
import { historyToJSON } from '@temporalio/common/lib/proto-utils';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createTracingPlugin } from '../../src/telemetry/tracing.js';
import type { changesetWorkflow } from '../../src/workflows/changeset.js';
import { startExecutionOf } from '../support/changesets.js';
import { startInfrastructure, startTestWorker, type Infra, type TestWorker } from '../support/harness.js';
import { isSdkPlaintext, payloadEncodings, TRACE_HEADER, traceContextOf, traceIdOf } from '../support/history.js';
import { preparedByWorkflow, statusOf } from '../support/prepared-by-workflow.js';

const exporter = new InMemorySpanExporter();
let provider: NodeTracerProvider;
let infra: Infra;

beforeAll(async () => {
  provider = new NodeTracerProvider({ spanProcessors: [new SimpleSpanProcessor(exporter)] });
  provider.register();
  infra = await startInfrastructure({ clientInterceptors: { workflow: [new OpenTelemetryWorkflowClientInterceptor()] } });
});

afterAll(async () => {
  try {
    await infra.close();
  } finally {
    await provider.shutdown();
    trace.disable();
  }
});

beforeEach(() => {
  exporter.reset();
});

/** Reads answer every requested SKU with brand `acme`. */
const catalogReader: UpstreamReader = {
  read(_operationId, args): Promise<ReadPage> {
    const skus = Array.isArray(args.skus) ? args.skus.filter((s): s is string => typeof s === 'string') : [];
    return Promise.resolve({ ok: true, items: skus.map((sku) => ({ sku, brand: 'acme', name: `old ${sku}` })), truncated: false });
  },
};

const handleOf = (id: string) => infra.client.workflow.getHandle<typeof changesetWorkflow>(id);

async function withTracedWorker(run: (worker: TestWorker) => Promise<void>): Promise<void> {
  const worker = await startTestWorker(infra, {
    reader: catalogReader,
    writer: new ScriptedWriter(),
    plugins: [createTracingPlugin({ spanProcessor: new SimpleSpanProcessor(exporter), serviceName: 'aiops-worker' })],
  });
  try {
    await run(worker);
  } finally {
    await worker.stop();
  }
}

/** Runs `fn` under an active root span and ends it; returns the root's trace and span ID. */
async function underRoot<T>(fn: () => Promise<T>): Promise<{ result: T; traceId: string; spanId: string }> {
  return trace.getTracer('test').startActiveSpan('test.root', async (root: Span) => {
    try {
      const { traceId, spanId } = root.spanContext();
      return { result: await fn(), traceId, spanId };
    } finally {
      root.end();
    }
  });
}

type HistoryEvent = Record<string, { header?: { fields?: Record<string, unknown> } } | undefined>;
interface TracedHistory {
  readonly json: unknown;
  readonly events: HistoryEvent[];
}

/** The workflow's history in its proto JSON form (base64 payload fields). */
async function historyOf(id: string): Promise<TracedHistory> {
  const json: unknown = JSON.parse(historyToJSON(await handleOf(id).fetchHistory()));
  return { json, events: (json as { events?: HistoryEvent[] }).events ?? [] };
}

/** The `_tracer-data` header of an event's `attributes` (undefined when absent). */
const headerOf = (event: HistoryEvent | undefined, attributes: string): unknown => event?.[attributes]?.header?.fields?.[TRACE_HEADER];

/** The `_tracer-data` header of every event that has `attributes`. */
const headersOf = (history: TracedHistory, attributes: string): unknown[] =>
  history.events.filter((e) => e[attributes] !== undefined).map((e) => headerOf(e, attributes));

/** Each header is present, holds only W3C trace context and belongs to `traceId`. */
function expectTraceContextOf(headers: readonly unknown[], traceId: string): void {
  for (const header of headers) {
    const context = traceContextOf(header);
    expect(context, 'only traceparent/tracestate').toBeDefined();
    expect(traceIdOf(context)).toBe(traceId);
  }
}

/** Apart from the shape-checked SDK plaintext, every payload is `binary/encrypted` (SEC-4). */
function expectEncryptedApartFromSdkPlaintext(history: unknown): void {
  const encodings = payloadEncodings(history, isSdkPlaintext);
  expect(encodings.length).toBeGreaterThan(0);
  expect(new Set(encodings)).toEqual(new Set(['binary/encrypted']));
}

const finished = (): ReadableSpan[] => exporter.getFinishedSpans();

/** The one finished span called `name`. */
function spanNamed(name: string): ReadableSpan {
  const spans = finished().filter((s) => s.name === name);
  expect(spans.map((s) => s.name), `exactly one ${name}`).toEqual([name]);
  const [span] = spans;
  if (span === undefined) throw new Error(`no span ${name}`);
  return span;
}

describe('NFR-11 tracing through Temporal', () => {
  it("NFR-11 one trace links the caller, the workflow start, the workflow's activity schedules and the activity runs", async () => {
    await withTracedWorker(async (worker) => {
      const { result: prepared, traceId, spanId } = await underRoot(() => preparedByWorkflow(infra, worker, ['t-0001', 't-0002']));
      await startExecutionOf(infra.repository, prepared);
      await worker.executor.wake(prepared.id);
      await vi.waitFor(
        async () => {
          expect(await statusOf(infra, prepared.id)).toBe('completed');
          expect(finished().map((s) => s.name)).toContain('RunActivity:finishExecution');
        },
        { timeout: 30_000, interval: 100 },
      );

      const start = spanNamed('StartWorkflow:changesetWorkflow');
      expect(start.spanContext().traceId).toBe(traceId);
      expect(start.parentSpanContext?.spanId).toBe(spanId);

      const schedule = spanNamed('StartActivity:prepare');
      const run = spanNamed('RunActivity:prepare');
      expect(schedule.spanContext().traceId).toBe(traceId);
      expect(run.spanContext().traceId).toBe(traceId);
      expect(run.parentSpanContext?.spanId).toBe(schedule.spanContext().spanId);

      for (const name of ['RunActivity:executeBatch', 'RunActivity:finishExecution']) {
        const spans = finished().filter((s) => s.name === name);
        expect(spans.length, name).toBeGreaterThan(0);
        for (const s of spans) expect(s.spanContext().traceId, name).toBe(traceId);
      }
    });
  }, 60_000);

  it('NFR-11 activity spans carry the change-set ID and the correlation ID of their phase', async () => {
    await withTracedWorker(async (worker) => {
      const prepared = await preparedByWorkflow(infra, worker, ['t-0001'], { correlationId: 'corr-prepare' });
      await startExecutionOf(infra.repository, prepared, { correlationId: 'corr-execute' });
      await worker.executor.wake(prepared.id);
      await vi.waitFor(
        async () => {
          expect(await statusOf(infra, prepared.id)).toBe('completed');
          expect(finished().map((s) => s.name)).toContain('RunActivity:executeBatch');
        },
        { timeout: 30_000, interval: 100 },
      );

      const prepare = spanNamed('RunActivity:prepare');
      expect(prepare.attributes['aiops.changeset_id']).toBe(prepared.id);
      expect(prepare.attributes['aiops.correlation_id']).toBe('corr-prepare');
      const batches = finished().filter((s) => s.name === 'RunActivity:executeBatch');
      expect(batches.length).toBeGreaterThan(0);
      for (const batch of batches) {
        expect(batch.attributes['aiops.changeset_id']).toBe(prepared.id);
        expect(batch.attributes['aiops.correlation_id']).toBe('corr-execute');
      }
    });
  }, 60_000);

  it('NFR-11 the workflow span is exported when the workflow closes', async () => {
    await withTracedWorker(async (worker) => {
      const { result: prepared, traceId } = await underRoot(() => preparedByWorkflow(infra, worker, ['t-0001']));
      await worker.executor.cancel({ changesetId: prepared.id, actor: 'alice', correlationId: 'corr-cancel' });
      await expect(handleOf(prepared.id).result()).resolves.toEqual({ status: 'cancelled' });
      await vi.waitFor(
        () => {
          expect(finished().map((s) => s.name)).toContain('RunWorkflow:changesetWorkflow');
        },
        { timeout: 30_000, interval: 100 },
      );

      const start = spanNamed('StartWorkflow:changesetWorkflow');
      const workflow = spanNamed('RunWorkflow:changesetWorkflow');
      expect(workflow.spanContext().traceId).toBe(traceId);
      expect(workflow.parentSpanContext?.spanId).toBe(start.spanContext().spanId);
    });
  }, 60_000);

  it('NFR-11 workflow spans reach the 2.x span processor in its span shape, with parent, scope and resource', async () => {
    // The plugin's sink hands over spans built by its own 1.x SDK (`parentSpanId`,
    // `instrumentationLibrary`); the OTLP exporter reads `parentSpanContext` and
    // `instrumentationScope` (ADR 0054).
    await withTracedWorker(async (worker) => {
      const { result: prepared, traceId } = await underRoot(() => preparedByWorkflow(infra, worker, ['t-0001']));
      await worker.executor.cancel({ changesetId: prepared.id, actor: 'alice', correlationId: 'corr-cancel' });
      await expect(handleOf(prepared.id).result()).resolves.toEqual({ status: 'cancelled' });
      await vi.waitFor(
        () => {
          expect(finished().map((s) => s.name)).toContain('RunWorkflow:changesetWorkflow');
        },
        { timeout: 30_000, interval: 100 },
      );

      const workflow = spanNamed('RunWorkflow:changesetWorkflow');
      const schedule = spanNamed('StartActivity:prepare');
      expect(schedule.parentSpanContext).toEqual(expect.objectContaining({ traceId, spanId: workflow.spanContext().spanId }));
      for (const span of [workflow, schedule]) {
        expect(span.instrumentationScope.name, span.name).toEqual(expect.any(String));
        expect(span.resource.attributes['service.name'], span.name).toBe('aiops-worker');
        expect(span, span.name).not.toHaveProperty('parentSpanId');
      }
    });
  }, 60_000);

  it('SEC-4 SEC-3 the trace header carries only W3C trace context and every other payload is encrypted', async () => {
    await withTracedWorker(async (worker) => {
      const { result: prepared, traceId } = await underRoot(() => preparedByWorkflow(infra, worker, ['t-0001']));
      const parked = await historyOf(prepared.id);
      const headers = [headerOf(parked.events[0], 'workflowExecutionStartedEventAttributes'), ...headersOf(parked, 'activityTaskScheduledEventAttributes')];
      // The start event and at least `inspect` and `prepare`.
      expect(headers.length).toBeGreaterThanOrEqual(3);
      expectTraceContextOf(headers, traceId);
      expectEncryptedApartFromSdkPlaintext(parked.json);

      // A signal (the cancel's wake) carries its own trace header into history.
      const { traceId: cancelTraceId } = await underRoot(() => worker.executor.cancel({ changesetId: prepared.id, actor: 'alice', correlationId: 'corr-cancel' }));
      await expect(handleOf(prepared.id).result()).resolves.toEqual({ status: 'cancelled' });
      const closed = await historyOf(prepared.id);
      const signals = headersOf(closed, 'workflowExecutionSignaledEventAttributes');
      expect(signals.length).toBeGreaterThanOrEqual(1);
      expectTraceContextOf(signals, cancelTraceId);
      expectTraceContextOf(headersOf(closed, 'activityTaskScheduledEventAttributes'), traceId);
      expectEncryptedApartFromSdkPlaintext(closed.json);
    });
  }, 60_000);
});
