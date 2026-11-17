/**
 * The worker's writer per operation (design part 2 §4, OPS-6): a `ManifestBatchWriter` for a
 * `write` or `destructive` operation with a manifest whose binding has a `bulk` block, `UnsupportedWriter` for
 * everything else. Reads and bulk calls are bound to the change-set's correlation ID and to the
 * configuration snapshot the activity passes in.
 */
import type { ReadAdapter, WriteAdapter } from '@aiops/connector-sdk';
import type { LoadedConfiguration } from '@aiops/config';
import { ManifestBatchWriter, UnsupportedWriter, type ChangeWriter, type Clock, type CredentialVault } from '@aiops/core';
import { createBulkWriter, createUpstreamReader, type UpstreamCallLog } from '@aiops/upstream';

export interface WriterForDeps {
  readonly vault: CredentialVault;
  readonly adapter: ReadAdapter & WriteAdapter;
  /** Default: wall-clock time and a `setTimeout` sleep. */
  readonly clock?: Clock;
  readonly log?: (record: UpstreamCallLog) => void;
}

const systemClock: Clock = {
  now: () => Date.now(),
  sleep: (ms) =>
    new Promise((resolve) => {
      setTimeout(resolve, ms);
    }),
};

export function createWriterFor(deps: WriterForDeps): (configuration: LoadedConfiguration, operationId: string) => ChangeWriter {
  const { vault, adapter } = deps;
  const clock = deps.clock ?? systemClock;
  const log = deps.log === undefined ? {} : { log: deps.log };

  return (configuration, operationId) => {
    const operation = configuration.policy.operations.find((o) => o.id === operationId);
    const manifest = operation?.manifest;
    if ((operation?.risk !== 'write' && operation?.risk !== 'destructive') || manifest === undefined) return new UnsupportedWriter();
    const bulkFor = (correlationId: string) => createBulkWriter({ configuration, vault, adapter, operationId, correlationId, ...log });
    // Checked once here so a ManifestBatchWriter is only built for a bulk binding.
    if (bulkFor('') === undefined) return new UnsupportedWriter();
    const readOperation = configuration.policy.operations.find((o) => o.id === manifest.readBefore.operation);

    return new ManifestBatchWriter({
      operation: { ...operation, manifest },
      readFieldsArg: readOperation?.fieldsArg,
      readerFor: (cs) => createUpstreamReader({ configuration, vault, adapter, correlationId: cs.correlationId, ...log }),
      bulkFor: (cs) => {
        const bulk = bulkFor(cs.correlationId);
        // Unreachable: the same configuration snapshot answered a bulk writer above.
        if (bulk === undefined) throw new Error('bulk binding vanished from the configuration snapshot');
        return bulk;
      },
      clock,
    });
  };
}
