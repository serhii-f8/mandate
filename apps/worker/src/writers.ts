/**
 * The worker's writers per operation (design part 2 §4, OPS-6; EXE-8, OPS-3). Forward: a
 * `ManifestBatchWriter` for a `write` or `destructive` operation with a manifest whose binding has a
 * `bulk` block, `UnsupportedWriter` for everything else. Rollback: the same writer in the reverse
 * direction, through the operation's own bulk binding (`replay_previous_state`) or the inverse
 * operation's (`inverse_operation`), or none. Reads and bulk calls are bound to the configuration
 * snapshot the activity passes in and to the correlation ID of the request that runs them (EXE-4):
 * the execution request's going forward, the rollback request's going back.
 */
import type { ReadAdapter, WriteAdapter } from '@aiops/connector-sdk';
import type { LoadedConfiguration } from '@aiops/config';
import {
  ManifestBatchWriter,
  UnsupportedWriter,
  type ChangeSetRecord,
  type ChangeWriter,
  type Clock,
  type CredentialVault,
  type WriteDirection,
} from '@aiops/core';
import { createBulkWriter, createUpstreamReader, type UpstreamCallLog } from '@aiops/upstream';

export interface WriterForDeps {
  readonly vault: CredentialVault;
  readonly adapter: ReadAdapter & WriteAdapter;
  /** Default: wall-clock time and a `setTimeout` sleep. */
  readonly clock?: Clock;
  readonly log?: (record: UpstreamCallLog) => void;
}

export type WriterFor = (configuration: LoadedConfiguration, operationId: string) => ChangeWriter;
export type RollbackWriterFor = (configuration: LoadedConfiguration, operationId: string) => ChangeWriter | undefined;

const systemClock: Clock = {
  now: () => Date.now(),
  sleep: (ms) =>
    new Promise((resolve) => {
      setTimeout(resolve, ms);
    }),
};

/** Forward calls run under the execution request, falling back to the change-set's own ID. */
const executionCorrelation = (cs: ChangeSetRecord): string => cs.executionRequest?.correlationId ?? cs.correlationId;
/** Rollback calls run under the rollback request, with the same fallbacks. */
const rollbackCorrelation = (cs: ChangeSetRecord): string => cs.rollbackRequest?.correlationId ?? executionCorrelation(cs);

/**
 * A manifest writer of `operationId`'s manifest whose bulk calls use `bulkOperationId`'s binding;
 * undefined when the operation, its manifest or that bulk binding is missing.
 */
function manifestWriter(
  deps: WriterForDeps,
  configuration: LoadedConfiguration,
  input: {
    readonly operationId: string;
    readonly bulkOperationId: string;
    readonly direction: WriteDirection;
    readonly correlation: (cs: ChangeSetRecord) => string;
  },
): ManifestBatchWriter | undefined {
  const { vault, adapter } = deps;
  const log = deps.log === undefined ? {} : { log: deps.log };
  const operation = configuration.policy.operations.find((o) => o.id === input.operationId);
  const manifest = operation?.manifest;
  if (operation === undefined || manifest === undefined) return undefined;
  const bulkFor = (correlationId: string) =>
    createBulkWriter({ configuration, vault, adapter, operationId: input.bulkOperationId, correlationId, ...log });
  // Checked once here so a ManifestBatchWriter is only built for a bulk binding.
  if (bulkFor('') === undefined) return undefined;
  const readOperation = configuration.policy.operations.find((o) => o.id === manifest.readBefore.operation);

  return new ManifestBatchWriter({
    operation: { ...operation, manifest },
    readFieldsArg: readOperation?.fieldsArg,
    readerFor: (cs) => createUpstreamReader({ configuration, vault, adapter, correlationId: input.correlation(cs), ...log }),
    bulkFor: (cs) => {
      const bulk = bulkFor(input.correlation(cs));
      // Unreachable: the same configuration snapshot answered a bulk writer above.
      if (bulk === undefined) throw new Error('bulk binding vanished from the configuration snapshot');
      return bulk;
    },
    clock: deps.clock ?? systemClock,
    direction: input.direction,
  });
}

export function createWriterFor(deps: WriterForDeps): WriterFor {
  return (configuration, operationId) => {
    const operation = configuration.policy.operations.find((o) => o.id === operationId);
    if (operation?.risk !== 'write' && operation?.risk !== 'destructive') return new UnsupportedWriter();
    return (
      manifestWriter(deps, configuration, { operationId, bulkOperationId: operationId, direction: 'forward', correlation: executionCorrelation }) ??
      new UnsupportedWriter()
    );
  };
}

/**
 * EXE-8, OPS-3 (ruling R13): undefined for strategy `none`, an unknown operation, a missing manifest
 * or a missing bulk binding. `inverse_operation` keeps the original manifest (its `id_field` and
 * fields, checked against the inverse's at load) and submits through the inverse operation's binding.
 */
export function createRollbackWriterFor(deps: WriterForDeps): RollbackWriterFor {
  return (configuration, operationId) => {
    const strategy = configuration.policy.operations.find((o) => o.id === operationId)?.manifest?.rollback;
    if (strategy === undefined || strategy.strategy === 'none') return undefined;
    const bulkOperationId = strategy.strategy === 'inverse_operation' ? strategy.operation : operationId;
    return manifestWriter(deps, configuration, { operationId, bulkOperationId, direction: 'reverse', correlation: rollbackCorrelation });
  };
}
