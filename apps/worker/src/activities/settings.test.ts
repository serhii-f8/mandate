// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Mandate Authors
import { ApplicationFailure } from '@temporalio/common';
import { describe, expect, it } from 'vitest';
import { OPAQUE_OPERATION, testConfiguration, WRITE_OPERATION } from '../../test/support/configuration.js';
import { executionSettings, verificationManifest } from './settings.js';

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

describe('EXE-12 verificationManifest', () => {
  it('EXE-12 verificationManifest answers a manifest with verify_after only', () => {
    const verifyAfter = { afterSeconds: 0, everySeconds: 30, timeoutSeconds: 600, checks: [{ code: 'not_live', require: [{ present: { record: 'name' } }] }] };
    const verifying = {
      ...configuration,
      policy: {
        ...configuration.policy,
        operations: configuration.policy.operations.map((o) => (o.id === WRITE_OPERATION && o.manifest !== undefined ? { ...o, manifest: { ...o.manifest, verifyAfter } } : o)),
      },
    };
    expect(verificationManifest(verifying, WRITE_OPERATION)).toMatchObject({ batchSize: 2, verifyAfter });
    for (const id of [WRITE_OPERATION, OPAQUE_OPERATION, 'catalog.gone']) expect(verificationManifest(configuration, id)).toBeUndefined();
  });
});
