// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Mandate Authors
/**
 * The worker's writers per operation (design part 2 §4, design phase 9 §4; OPS-5, OPS-6, EXE-8,
 * OPS-3). Forward: an `OpaqueCallWriter` for an opaque operation (one call sent at most once,
 * design phase 9 §5); for a `write` or `destructive` operation with a manifest, a
 * `ManifestBatchWriter` whose write mode follows the operation's binding: an HTTP binding with a
 * `bulk` block submits and polls (`bulkFor`), an HTTP non-GET binding without one sends one request
 * per record and a `code` binding hands the records to the preset's code module (both
 * `directFor`); `UnsupportedWriter` for everything else, including an adapter that cannot write per
 * record or run code (fail closed). Rollback: the same writer in the reverse direction, through
 * the operation's own binding (`replay_previous_state`) or the inverse operation's
 * (`inverse_operation`), or none. Reads and writes are bound to the configuration snapshot the
 * activity passes in and to the correlation ID of the request that runs them (EXE-4): the
 * execution request's going forward, the rollback request's going back.
 */
import type { CodeAdapter, ReadAdapter, RecordWriteAdapter, WriteAdapter } from '@mandate/connector-sdk';
import type { LoadedConfiguration } from '@mandate/config';
import {
  isOpaque,
  type FileStore,
  ManifestBatchWriter,
  OpaqueCallWriter,
  UnsupportedWriter,
  type BulkWriter,
  type ChangeSetRecord,
  type ChangeWriter,
  type Clock,
  type CredentialVault,
  type DirectWriter,
  type OpaqueCaller,
  type WriteDirection,
} from '@mandate/core';
import {
  createBulkWriter,
  createCodeRecordWriter,
  createOpaqueCaller,
  createPerRecordWriter,
  createUpstreamReader,
  verifyPinNow,
  type ToolLister,
  type UpstreamCallLog,
} from '@mandate/upstream';

export interface WriterForDeps {
  readonly vault: CredentialVault;
  /**
   * Bulk writes and reads always; per-record writes need `writeRecord` and code operations the
   * `CodeAdapter` methods (ruling F14): without them such a binding gets no writer and fails closed.
   * The worker passes the composite adapter, which has all of them.
   */
  readonly adapter: ReadAdapter & WriteAdapter & Partial<RecordWriteAdapter> & Partial<CodeAdapter>;
  /**
   * Lists an MCP connection's tools for the fresh pin check of an opaque MCP call (CONN-4, ruling
   * F8). Absent, every opaque MCP call fails closed with `upstream_unavailable` and nothing is sent.
   */
  readonly toolLister?: ToolLister;
  /** Default: wall-clock time and a `setTimeout` sleep. */
  readonly clock?: Clock;
  readonly log?: (record: UpstreamCallLog) => void;
  /**
   * The staged files' content for an opaque call with files (EXE-4, CS-10). Absent, such a call is
   * `not_sent/file_unavailable`: nothing is sent without its verified content.
   */
  readonly files?: Pick<FileStore, 'content'>;
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

type WriterAdapter = WriterForDeps['adapter'];
/** The two write modes of a `ManifestBatchWriter`: exactly one is given. */
type WriteMode = { readonly bulkFor: (cs: ChangeSetRecord) => BulkWriter } | { readonly directFor: (cs: ChangeSetRecord) => DirectWriter };

/** The adapter can write per record and run code: the direct writers need both interfaces. */
function directCapable(adapter: WriterAdapter): adapter is WriterAdapter & RecordWriteAdapter & CodeAdapter {
  return (
    typeof adapter.writeRecord === 'function' &&
    typeof adapter.codeRead === 'function' &&
    typeof adapter.codeWrite === 'function' &&
    typeof adapter.codeCall === 'function'
  );
}

/**
 * The write mode of `writeOperationId`'s binding for records of `manifestOperationId`'s manifest
 * (OPS-5, OPS-6; for an `inverse_operation` rollback the inverse needs no manifest of its own): `bulkFor` for an HTTP binding with
 * `bulk`, `directFor` with a per-record writer for an HTTP non-GET binding without it, `directFor`
 * with a code writer for a `code` binding; undefined for anything else (an MCP binding, a GET, a
 * missing binding or connection, an adapter without the needed methods).
 */
function writeModeOf(
  deps: WriterForDeps,
  configuration: LoadedConfiguration,
  writeOperationId: string,
  manifestOperationId: string,
  direction: WriteDirection,
  correlation: (cs: ChangeSetRecord) => string,
): WriteMode | undefined {
  const { vault, adapter } = deps;
  const log = deps.log === undefined ? {} : { log: deps.log };
  const binding = configuration.bindings.get(writeOperationId);
  if (binding?.kind === 'http' && binding.mapping.bulk !== undefined) {
    const bulkFor = (correlationId: string) => createBulkWriter({ configuration, vault, adapter, operationId: writeOperationId, correlationId, ...log });
    // Checked once here so a ManifestBatchWriter is only built for a usable bulk binding.
    if (bulkFor('') === undefined) return undefined;
    return {
      bulkFor: (cs) => {
        const bulk = bulkFor(correlation(cs));
        // Unreachable: the same configuration snapshot answered a bulk writer above.
        if (bulk === undefined) throw new Error('bulk binding vanished from the configuration snapshot');
        return bulk;
      },
    };
  }
  if (binding === undefined || binding.kind === 'mcp' || !directCapable(adapter)) return undefined;
  const create = binding.kind === 'code' ? createCodeRecordWriter : createPerRecordWriter;
  // A code module learns it is restoring values: its `args` are still the forward change (OPS-5, EXE-8).
  const codeDirection = direction === 'reverse' ? 'rollback' : 'forward';
  const directFor = (correlationId: string, args: Readonly<Record<string, unknown>>) =>
    create({ configuration, vault, adapter, operationId: writeOperationId, manifestOperationId, correlationId, args, direction: codeDirection, ...log });
  // Checked once here: a GET binding, a code operation of another kind or a missing connection answers undefined.
  if (directFor('', {}) === undefined) return undefined;
  return {
    directFor: (cs) => {
      const direct = directFor(correlation(cs), cs.args);
      // Unreachable: the same configuration snapshot answered a direct writer above.
      if (direct === undefined) throw new Error('write binding vanished from the configuration snapshot');
      return direct;
    },
  };
}

/**
 * A manifest writer of `operationId`'s manifest whose writes use `writeOperationId`'s binding;
 * undefined when the operation, its manifest or a usable write binding is missing.
 */
function manifestWriter(
  deps: WriterForDeps,
  configuration: LoadedConfiguration,
  input: {
    readonly operationId: string;
    readonly writeOperationId: string;
    readonly direction: WriteDirection;
    readonly correlation: (cs: ChangeSetRecord) => string;
  },
): ManifestBatchWriter | undefined {
  const { vault, adapter } = deps;
  const log = deps.log === undefined ? {} : { log: deps.log };
  const operation = configuration.policy.operations.find((o) => o.id === input.operationId);
  const manifest = operation?.manifest;
  if (operation === undefined || manifest === undefined) return undefined;
  // The records come from this operation's manifest; the write binding only sends them (T11 I1).
  const mode = writeModeOf(deps, configuration, input.writeOperationId, input.operationId, input.direction, input.correlation);
  if (mode === undefined) return undefined;
  const readOperation = configuration.policy.operations.find((o) => o.id === manifest.readBefore.operation);

  return new ManifestBatchWriter({
    operation: { ...operation, manifest },
    readFieldsArg: readOperation?.fieldsArg,
    readerFor: (cs) => createUpstreamReader({ configuration, vault, adapter, correlationId: input.correlation(cs), ...log }),
    ...mode,
    clock: deps.clock ?? systemClock,
    direction: input.direction,
  });
}

/** The caller of an opaque operation whose binding is gone from the snapshot: refused, nothing sent. */
const unavailableCaller: OpaqueCaller = {
  call: () => Promise.resolve({ kind: 'not_sent', code: 'upstream_rejected' }),
};

/**
 * One call per change-set (EXE-4). The caller and its pin check are both bound to `configuration`,
 * the snapshot the activity runs under, so the pin is verified against the configuration of this
 * execution and never against an earlier one (ruling F8).
 */
function opaqueWriter(deps: WriterForDeps, configuration: LoadedConfiguration, operationId: string): OpaqueCallWriter {
  const { vault, adapter, toolLister } = deps;
  const log = deps.log === undefined ? {} : { log: deps.log };
  const files = deps.files === undefined ? {} : { files: deps.files };
  const pinCheck = toolLister === undefined ? {} : { pinCheck: (id: string) => verifyPinNow(toolLister, configuration, id) };
  return new OpaqueCallWriter({
    callerFor: (cs) =>
      createOpaqueCaller({ configuration, vault, adapter, operationId, correlationId: executionCorrelation(cs), ...pinCheck, ...files, ...log }) ??
      unavailableCaller,
  });
}

export function createWriterFor(deps: WriterForDeps): WriterFor {
  return (configuration, operationId) => {
    const operation = configuration.policy.operations.find((o) => o.id === operationId);
    if (operation !== undefined && isOpaque(operation)) return opaqueWriter(deps, configuration, operationId);
    if (operation?.risk !== 'write' && operation?.risk !== 'destructive') return new UnsupportedWriter();
    return (
      manifestWriter(deps, configuration, { operationId, writeOperationId: operationId, direction: 'forward', correlation: executionCorrelation }) ??
      new UnsupportedWriter()
    );
  };
}

/**
 * EXE-8, OPS-3 (ruling R13): undefined for strategy `none`, an unknown operation, a missing manifest
 * or a missing usable write binding. `inverse_operation` keeps the original manifest (its `id_field`
 * and fields, checked against the inverse's at load) and writes through the inverse operation's
 * binding, in that binding's write mode, with the change-set's own arguments.
 */
export function createRollbackWriterFor(deps: WriterForDeps): RollbackWriterFor {
  return (configuration, operationId) => {
    const strategy = configuration.policy.operations.find((o) => o.id === operationId)?.manifest?.rollback;
    if (strategy === undefined || strategy.strategy === 'none') return undefined;
    const writeOperationId = strategy.strategy === 'inverse_operation' ? strategy.operation : operationId;
    return manifestWriter(deps, configuration, { operationId, writeOperationId, direction: 'reverse', correlation: rollbackCorrelation });
  };
}
