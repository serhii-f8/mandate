import { ApplicationFailure } from '@temporalio/common';
import { describe, expect, it } from 'vitest';
import { OPAQUE_OPERATION, testConfiguration, WRITE_OPERATION } from '../../test/support/configuration.js';
import { executionSettings } from './settings.js';

const configuration = await testConfiguration();

/** The test configuration with one more operation: a `write` without a manifest, as a broken reload might leave it. */
function withManifestlessWrite() {
  const source = configuration.policy.operations.find((o) => o.id === WRITE_OPERATION);
  if (source === undefined) throw new Error('test operation missing');
  const manifestless = { ...source, id: 'catalog.no_manifest' };
  delete manifestless.manifest;
  return { ...configuration, policy: { ...configuration.policy, operations: [...configuration.policy.operations, manifestless] } };
}

function failureOf(fn: () => unknown): unknown {
  try {
    fn();
  } catch (error) {
    return error;
  }
  return undefined;
}

describe('EXE-4 executionSettings', () => {
  it('EXE-4 executionSettings of an opaque operation has batch size 1; a write without manifest is operation_unavailable', () => {
    expect(executionSettings(configuration, OPAQUE_OPERATION)).toEqual({
      batchSize: 1,
      failureThreshold: 0.5,
      itemsPerRun: 100,
      rollbackWindowHours: configuration.changesets.rollbackWindowHours,
    });
    // A manifest operation keeps its manifest's batch size.
    expect(executionSettings(configuration, WRITE_OPERATION).batchSize).toBe(2);

    for (const id of ['catalog.no_manifest', 'catalog.gone']) {
      const error = failureOf(() => executionSettings(withManifestlessWrite(), id));
      expect(error).toBeInstanceOf(ApplicationFailure);
      expect(error).toMatchObject({ message: 'operation_unavailable', nonRetryable: true });
    }
  });
});
