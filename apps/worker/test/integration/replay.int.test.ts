import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { parseTemporalKeys, workerDataConverter } from '@aiops/temporal';
import type { DataConverter } from '@temporalio/common';
import { InMemorySpanExporter, SimpleSpanProcessor } from '@opentelemetry/sdk-trace-base';
import { Worker } from '@temporalio/worker';
import { describe, expect, it } from 'vitest';
import { createTracingPlugin } from '../../src/telemetry/tracing.js';
import { workflowBundlerOptions, workflowsPath } from '../../src/worker.js';
import { isSdkPlaintext, payloadEncodings, plain } from '../support/history.js';
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
];

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

  it('SEC-4 no changesetWorkflow fixture carries a json/plain payload', () => {
    const encodings = new Set<string>();
    for (const fixture of fixtures.filter((f) => f.type === 'changesetWorkflow')) {
      for (const encoding of payloadEncodings(JSON.parse(readFileSync(fixture.path, 'utf8')))) encodings.add(encoding);
    }
    // Non-vacuous: the walk does find the encrypted payloads.
    expect(encodings).toContain('binary/encrypted');
    expect(encodings).not.toContain('json/plain');
  });

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

  it('NFR-11 replay exports no workflow span', () => {
    // Sinks are not called during replay, so the workflow's spans never reach the processor.
    const names = exporter.getFinishedSpans().map((s) => s.name);
    expect(names.filter((n) => n.startsWith('RunWorkflow:') || n.startsWith('StartActivity:'))).toEqual([]);
  });
});
