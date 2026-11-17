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
 * activity (the wake condition, the prepare-retry pause, the expire-retry pause), completed per code path, failed and cancelled, one per continue-as-new run.
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
];

/** Every payload's `metadata.encoding` in a history JSON (base64 in the proto JSON form), decoded. */
function payloadEncodings(node: unknown): string[] {
  if (Array.isArray(node)) return node.flatMap(payloadEncodings);
  if (node === null || typeof node !== 'object') return [];
  const found: string[] = [];
  for (const [key, value] of Object.entries(node) as [string, unknown][]) {
    if (key === 'metadata' && value !== null && typeof value === 'object') {
      const encoding: unknown = (value as { encoding?: unknown }).encoding;
      if (typeof encoding === 'string') found.push(Buffer.from(encoding, 'base64').toString('utf8'));
    }
    found.push(...payloadEncodings(value));
  }
  return found;
}

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
