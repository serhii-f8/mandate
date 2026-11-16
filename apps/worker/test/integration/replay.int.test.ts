import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { Worker } from '@temporalio/worker';
import { describe, expect, it } from 'vitest';
import { workflowsPath } from '../../src/worker.js';

const historiesDir = fileURLToPath(new URL('../workflow-histories/', import.meta.url));

/** Every committed history: test/workflow-histories/<workflowType>/<name>.json (ADR 0006). */
const fixtures = readdirSync(historiesDir, { withFileTypes: true })
  .filter((d) => d.isDirectory())
  .flatMap((d) =>
    readdirSync(`${historiesDir}${d.name}`)
      .filter((f) => f.endsWith('.json'))
      .map((f) => ({ type: d.name, name: f, path: `${historiesDir}${d.name}/${f}` })),
  );

describe('EXE-10 workflow replay gate', () => {
  it('has at least one recorded history', () => {
    expect(fixtures.map((f) => `${f.type}/${f.name}`)).toContain('smokeWorkflow/completed.json');
  });

  it.each(fixtures)('EXE-10 replays $type/$name with the current workflow code', async ({ path, name }) => {
    const history: unknown = JSON.parse(readFileSync(path, 'utf8'));
    await expect(
      Worker.runReplayHistory({ workflowsPath }, history, name),
    ).resolves.toBeUndefined();
  });
});
