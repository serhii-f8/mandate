import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { parseTemporalKeys, workerDataConverter } from '@aiops/temporal';
import type { DataConverter } from '@temporalio/common';
import { Worker } from '@temporalio/worker';
import { describe, expect, it } from 'vitest';
import { workflowBundlerOptions, workflowsPath } from '../../src/worker.js';
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

/**
 * SDK-internal payloads that never pass the codec and carry only a patch id: the `core_patch`
 * marker's `patch-data` (`{ id, deprecated }`) and the `TemporalChangeVersion` search attribute
 * (`[id]`). The SEC-4 walk accepts them only when the decoded content has exactly that shape; any
 * other content under these keys is walked and reported like every other payload.
 */
const PATCH_ID = /^[a-z0-9-]+-\d{8}$/;

function isPatchData(value: unknown): boolean {
  if (typeof value !== 'object' || value === null) return false;
  const keys = Object.keys(value).sort();
  const v = value as { id?: unknown; deprecated?: unknown };
  return keys.join() === 'deprecated,id' && typeof v.id === 'string' && PATCH_ID.test(v.id) && typeof v.deprecated === 'boolean';
}

function isPatchIdList(value: unknown): boolean {
  return Array.isArray(value) && value.every((id) => typeof id === 'string' && PATCH_ID.test(id));
}

/** A json/plain payload `{ metadata, data }` whose decoded data passes `check`. */
function isPatchPayload(payload: unknown, check: (decoded: unknown) => boolean): boolean {
  if (typeof payload !== 'object' || payload === null) return false;
  const { metadata, data } = payload as { metadata?: { encoding?: unknown }; data?: unknown };
  if (typeof metadata?.encoding !== 'string' || Buffer.from(metadata.encoding, 'base64').toString('utf8') !== 'json/plain') return false;
  if (typeof data !== 'string') return false;
  try {
    return check(JSON.parse(Buffer.from(data, 'base64').toString('utf8')));
  } catch {
    return false;
  }
}

/** True when `value` under `key` is a genuine SDK patch payload. */
function isPatchMetadata(key: string, value: unknown): boolean {
  if (key === 'TemporalChangeVersion') return isPatchPayload(value, isPatchIdList);
  if (key !== 'patch-data' || typeof value !== 'object' || value === null) return false;
  const payloads = (value as { payloads?: unknown }).payloads;
  return Array.isArray(payloads) && payloads.length === 1 && isPatchPayload(payloads[0], isPatchData);
}

/** Every payload's `metadata.encoding` in a history JSON (base64 in the proto JSON form), decoded. */
function payloadEncodings(node: unknown): string[] {
  if (Array.isArray(node)) return node.flatMap(payloadEncodings);
  if (node === null || typeof node !== 'object') return [];
  const found: string[] = [];
  for (const [key, value] of Object.entries(node) as [string, unknown][]) {
    if (isPatchMetadata(key, value)) continue;
    if (key === 'metadata' && value !== null && typeof value === 'object') {
      const encoding: unknown = (value as { encoding?: unknown }).encoding;
      if (typeof encoding === 'string') found.push(Buffer.from(encoding, 'base64').toString('utf8'));
    }
    found.push(...payloadEncodings(value));
  }
  return found;
}

const plain = (data: string): { metadata: { encoding: string }; data: string } => ({
  metadata: { encoding: Buffer.from('json/plain').toString('base64') },
  data: Buffer.from(data).toString('base64'),
});

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
});
