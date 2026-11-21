// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The AI Operations Layer Authors
import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { parseTemporalKeys, workerDataConverter } from '@aiops/temporal';
import type { DataConverter } from '@temporalio/common';
import { InMemorySpanExporter, SimpleSpanProcessor } from '@opentelemetry/sdk-trace-base';
import { Worker } from '@temporalio/worker';
import { describe, expect, it } from 'vitest';
import { createTracingPlugin } from '../../src/telemetry/tracing.js';
import { workflowBundlerOptions, workflowsPath } from '../../src/worker.js';
import { isSdkPlaintext, payloadEncodings, plain, TRACE_HEADER } from '../support/history.js';
import { TEST_TEMPORAL_KEYS } from '../support/keys.js';

const historiesDir = fileURLToPath(new URL('../workflow-histories/', import.meta.url));

/** Every committed history: test/workflow-histories/<workflowType>/<name>.json (ADR 0006). */
const fixtures = readdirSync(historiesDir, { withFileTypes: true })
  .filter((d) => d.isDirectory())
  .flatMap((d) =>
    readdirSync(`${historiesDir}${d.name}`)
      .filter((f) => f.endsWith('.json'))
      .map((f) => ({ type: d.name, name: f, path: `${historiesDir}${d.name}/${f}` })),
  );

/**
 * The data converter a type's histories were recorded with. `smokeWorkflow`'s fixture predates
 * the codec (SEC-4) and is plaintext; `changesetWorkflow`'s are encrypted with the fixed test key.
 * A type without an entry fails the gate until its converter is named here.
 */
function converterFor(type: string): DataConverter | undefined {
  switch (type) {
    case 'smokeWorkflow':
      return undefined;
    case 'changesetWorkflow':
      return workerDataConverter(parseTemporalKeys(TEST_TEMPORAL_KEYS));
    default:
      throw new Error(`no replay converter for workflow type ${type}`);
  }
}

/**
 * Required `changesetWorkflow` histories (CLAUDE.md fixture rule): parked at each wait after an
 * activity (the wake condition in `prepared` and in `pending_approval`, the prepare-retry pause, the
 * expire-retry pause), completed per code path (also after approval), failed, cancelled, rejected and
 * expired (also in `pending_approval`, and after a return and a resubmission), one per continue-as-new run.
 * The rollback patch: parked in the window, rolled back after completion and after a cancel, window
 * closed by the timer, a failed rollback, one per continue-as-new run of a rollback.
 */
const REQUIRED_CHANGESET_FIXTURES = [
  'parked-prepared',
  'completed',
  'completed-continued-run1',
  'completed-continued-run2',
  'cancelled-during-execution',
  'expired',
  'prepare-failed',
  'failed-writer-error',
  'failure-threshold',
  'policy-denied',
  'executor-error',
  'cancelled-while-prepared',
  'prepare-retry-sleep',
  'prepare-retry-parked',
  'expire-retry',
  'expire-retry-parked',
  'parked-pending-approval',
  'approved-executed',
  'rejected-while-pending',
  'returned-resubmitted-expired',
  'expired-pending-approval',
  'rollback-window-parked',
  'rolled-back',
  'rolled-back-cancelled',
  'rollback-window-closed',
  'rollback-failed',
  'rollback-continued-run2',
  'rollback-continued-run3',
  'opaque-executed',
];

/**
 * Histories recorded as production runs (`record-history <scenario> --traced`, NFR-11): the
 * `_tracer-data` headers and the OpenTelemetry interceptors' SDK flags. Parked at the wake condition,
 * completed, one per continue-as-new run, rolled back. They replay with the plugin (production) and
 * without it (tracing switched off, `WORKFLOW_TRACING` fallback).
 */
const REQUIRED_TRACED_FIXTURES = [
  'parked-prepared-traced',
  'completed-traced',
  'completed-continued-run1-traced',
  'completed-continued-run2-traced',
  'rolled-back-traced',
];

const isTraced = (name: string): boolean => name.endsWith('-traced.json');

describe('SEC-4 patch payload exemption', () => {
  it('SEC-4 accepts the SDK patch marker and change-version shapes only', () => {
    const genuine = { 'patch-data': { payloads: [plain('{"id":"a-b-20261118","deprecated":false}')] }, TemporalChangeVersion: plain('["a-b-20261118"]') };
    expect(payloadEncodings(genuine)).toEqual([]);
  });

  it('SEC-4 reports a forged patch-data payload carrying other data', () => {
    expect(payloadEncodings({ 'patch-data': { payloads: [plain('{"id":"a-b-20261118","deprecated":false,"secret":"x"}')] } })).toEqual(['json/plain']);
    expect(payloadEncodings({ 'patch-data': { payloads: [plain('{"customer":"jane"}')] } })).toEqual(['json/plain']);
    expect(payloadEncodings({ TemporalChangeVersion: plain('["jane@example.com"]') })).toEqual(['json/plain']);
  });
});

describe('SEC-4 trace header exemption (ADR 0047)', () => {
  const traceparent = '00-0123456789abcdef0123456789abcdef-0123456789abcdef-01';

  it('SEC-4 SEC-3 accepts a _tracer-data header carrying only W3C trace context', () => {
    const headers = {
      a: { '_tracer-data': plain(JSON.stringify({ traceparent })) },
      b: { '_tracer-data': plain(JSON.stringify({ traceparent, tracestate: 'vendor=x' })) },
      c: { '_tracer-data': plain('{}') },
    };
    expect(payloadEncodings(headers, isSdkPlaintext)).toEqual([]);
  });

  it('SEC-4 SEC-3 reports a _tracer-data header carrying anything else', () => {
    expect(payloadEncodings({ '_tracer-data': plain(JSON.stringify({ traceparent, customer: 'jane' })) }, isSdkPlaintext)).toEqual(['json/plain']);
    expect(payloadEncodings({ '_tracer-data': plain(JSON.stringify({ traceparent: 'jane@example.com' })) }, isSdkPlaintext)).toEqual(['json/plain']);
    expect(payloadEncodings({ '_tracer-data': plain(JSON.stringify({ tracestate: 'vendor=x' })) }, isSdkPlaintext)).toEqual(['json/plain']);
    expect(payloadEncodings({ '_tracer-data': plain('["00"]') }, isSdkPlaintext)).toEqual(['json/plain']);
    // Under another key the same content is an ordinary payload.
    expect(payloadEncodings({ other: plain(JSON.stringify({ traceparent })) }, isSdkPlaintext)).toEqual(['json/plain']);
  });

  it('SEC-4 the replay gate itself does not exempt trace headers', () => {
    expect(payloadEncodings({ '_tracer-data': plain(JSON.stringify({ traceparent })) })).toEqual(['json/plain']);
  });
});

describe('EXE-10 workflow replay gate', () => {
  it('has at least one recorded history', () => {
    expect(fixtures.map((f) => `${f.type}/${f.name}`)).toContain('smokeWorkflow/completed.json');
  });

  it('EXE-10 has the required changesetWorkflow fixtures', () => {
    const names = fixtures.filter((f) => f.type === 'changesetWorkflow').map((f) => f.name.replace(/\.json$/, ''));
    expect(names).toEqual(expect.arrayContaining(REQUIRED_CHANGESET_FIXTURES));
  });

  it('EXE-10 NFR-11 has the required traced changesetWorkflow fixtures, and only they carry trace headers', () => {
    const changeset = fixtures.filter((f) => f.type === 'changesetWorkflow');
    expect(changeset.filter((f) => isTraced(f.name)).map((f) => f.name.replace(/\.json$/, ''))).toEqual(expect.arrayContaining(REQUIRED_TRACED_FIXTURES));
    for (const fixture of changeset) {
      expect(readFileSync(fixture.path, 'utf8').includes(`"${TRACE_HEADER}"`), fixture.name).toBe(isTraced(fixture.name));
    }
  });

  it('SEC-4 no untraced changesetWorkflow fixture carries a json/plain payload', () => {
    const encodings = new Set<string>();
    for (const fixture of fixtures.filter((f) => f.type === 'changesetWorkflow' && !isTraced(f.name))) {
      for (const encoding of payloadEncodings(JSON.parse(readFileSync(fixture.path, 'utf8')))) encodings.add(encoding);
    }
    // Non-vacuous: the walk does find the encrypted payloads.
    expect(encodings).toContain('binary/encrypted');
    expect(encodings).not.toContain('json/plain');
  });

  it('SEC-4 SEC-3 a traced fixture carries no json/plain payload apart from W3C trace headers (ADR 0047)', () => {
    const encodings = new Set<string>();
    for (const fixture of fixtures.filter((f) => f.type === 'changesetWorkflow' && isTraced(f.name))) {
      const history: unknown = JSON.parse(readFileSync(fixture.path, 'utf8'));
      // Non-vacuous: without the trace-header exemption the walk does find the headers.
      expect(payloadEncodings(history), fixture.name).toContain('json/plain');
      for (const encoding of payloadEncodings(history, isSdkPlaintext)) encodings.add(encoding);
    }
    expect(encodings).toContain('binary/encrypted');
    expect(encodings).not.toContain('json/plain');
  });

  // For a traced fixture this is the tracing-off case: the history replays without the interceptors.
  it.each(fixtures)('EXE-10 replays $type/$name with the current workflow code', async ({ type, path, name }) => {
    const history: unknown = JSON.parse(readFileSync(path, 'utf8'));
    const dataConverter = converterFor(type);
    await expect(
      Worker.runReplayHistory(
        { workflowsPath, bundlerOptions: workflowBundlerOptions(), ...(dataConverter === undefined ? {} : { dataConverter }) },
        history,
        name,
      ),
    ).resolves.toBeUndefined();
  });

  const exporter = new InMemorySpanExporter();

  it.each(fixtures)('EXE-10 NFR-11 replays $type/$name with the OpenTelemetry plugin installed', async ({ type, path, name }) => {
    const history: unknown = JSON.parse(readFileSync(path, 'utf8'));
    const dataConverter = converterFor(type);
    const plugins = [createTracingPlugin({ spanProcessor: new SimpleSpanProcessor(exporter), serviceName: 'aiops-worker' })];
    await expect(
      Worker.runReplayHistory(
        { workflowsPath, bundlerOptions: workflowBundlerOptions(), plugins, ...(dataConverter === undefined ? {} : { dataConverter }) },
        history,
        name,
      ),
    ).resolves.toBeUndefined();
  });

  it('NFR-11 replay exports no workflow span', async () => {
    // Self-contained (also under `-t`): replays one history that runs activities and closes.
    const own = new InMemorySpanExporter();
    const fixture = fixtures.find((f) => f.type === 'changesetWorkflow' && f.name === 'completed.json');
    if (fixture === undefined) throw new Error('fixture changesetWorkflow/completed.json missing');
    const plugins = [createTracingPlugin({ spanProcessor: new SimpleSpanProcessor(own), serviceName: 'aiops-worker' })];
    await Worker.runReplayHistory(
      { workflowsPath, bundlerOptions: workflowBundlerOptions(), plugins, dataConverter: workerDataConverter(parseTemporalKeys(TEST_TEMPORAL_KEYS)) },
      JSON.parse(readFileSync(fixture.path, 'utf8')) as unknown,
      fixture.name,
    );
    // Sinks are not called during replay, so the workflow's spans never reach the processor.
    for (const spans of [own.getFinishedSpans(), exporter.getFinishedSpans()]) {
      const names = spans.map((s) => s.name);
      expect(names.filter((n) => n.startsWith('RunWorkflow:') || n.startsWith('StartActivity:'))).toEqual([]);
    }
  });
});
