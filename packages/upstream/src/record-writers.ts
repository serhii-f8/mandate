/**
 * The worker implementations of the core `DirectWriter` port (design phase 9 §4): a per-record
 * write binding sends one request per record (OPS-6), a code write binding hands the records to
 * the preset's code module (OPS-5). The credential is opened only inside the adapter (SEC-2);
 * each request logs identifiers, method, status and timing only, never records (SEC-3).
 */
import { recordOutcomeOf, type CodeAdapter, type CodeWriteDirection, type CodeWriteOperation, type RecordSendOutcome, type RecordWriteAdapter } from '@aiops/connector-sdk';
import type { LoadedConfiguration } from '@aiops/config';
import type { CredentialVault, DirectRecordState, DirectWriter } from '@aiops/core';
import { connectionCredential, type UpstreamCallLog } from './read.js';

export interface DirectWriterDeps {
  /** The configuration this execution runs under (the activity's snapshot). */
  readonly configuration: LoadedConfiguration;
  readonly vault: CredentialVault;
  readonly adapter: RecordWriteAdapter & CodeAdapter;
  /** The operation whose binding sends the records. */
  readonly operationId: string;
  /**
   * The operation whose manifest the records come from; default `operationId`. An
   * `inverse_operation` rollback names the original here: the inverse then needs only a write
   * binding, as on the bulk path (ruling on T11 I1).
   */
  readonly manifestOperationId?: string;
  readonly correlationId: string;
  /** The change-set's validated arguments, for `{ arg }` templates and the code module. */
  readonly args: Readonly<Record<string, unknown>>;
  /**
   * Why the records are written: `rollback` when they carry the values to restore (EXE-8). Handed
   * to a code module as `ctx.direction`; default `forward`.
   */
  readonly direction?: CodeWriteDirection;
  readonly log?: (record: UpstreamCallLog) => void;
}

type Answer = Awaited<ReturnType<DirectWriter['write']>>;

const UNUSABLE: Answer = { ok: false, code: 'credential_unusable', retriable: false };
/** A code answer that cannot be aligned with the records: the upstream may have applied them (T9-M2). */
const MISALIGNED = { ok: false, code: 'invalid_response', retriable: false } as const;

/** The operation is a manifest write (`write`, or `destructive` with a manifest): the only kind direct writers serve. */
function isManifestWrite(configuration: LoadedConfiguration, operationId: string): boolean {
  const operation = configuration.policy.operations.find((op) => op.id === operationId);
  return operation?.manifest !== undefined && (operation.risk === 'write' || operation.risk === 'destructive');
}

/**
 * The records come from a manifest write and the binding's operation is a write: the same operation
 * by default, or for an `inverse_operation` rollback the original's manifest and the inverse's
 * binding, whether or not the inverse has a manifest of its own.
 */
function servesManifestWrite(deps: DirectWriterDeps): boolean {
  const { configuration, operationId } = deps;
  const manifestOperationId = deps.manifestOperationId ?? operationId;
  if (manifestOperationId === operationId) return isManifestWrite(configuration, operationId);
  const operation = configuration.policy.operations.find((op) => op.id === operationId);
  const writes = operation?.risk === 'write' || operation?.risk === 'destructive';
  return writes && isManifestWrite(configuration, manifestOperationId);
}

type LogFields = { readonly status?: number; readonly durationMs: number } & ({ readonly ok: true } | { readonly ok: false; readonly code: string });

function logger(deps: DirectWriterDeps, connection: string, method: string): (outcome: LogFields) => void {
  return (outcome) =>
    deps.log?.({
      correlationId: deps.correlationId,
      operation: deps.operationId,
      connection,
      method,
      ...(outcome.status === undefined ? {} : { status: outcome.status }),
      durationMs: outcome.durationMs,
      ...(outcome.ok ? {} : { errorCode: outcome.code }),
    });
}

/**
 * undefined unless the binding is HTTP, non-GET, without bulk, for a manifest write. Requests run
 * with at most `connection.maxConcurrency` in flight; once a record answers `retriable` no new
 * request starts (ruling F10): those in flight finish and the unsent records answer `retriable`,
 * so the retry re-reads and sends only what is not yet written (NFR-2). A rejected send stops the
 * lanes the same way and is rethrown once every lane has settled. One heartbeat per response.
 */
export function createPerRecordWriter(deps: DirectWriterDeps): DirectWriter | undefined {
  const { configuration, adapter, operationId } = deps;
  const binding = configuration.bindings.get(operationId);
  if (binding?.kind !== 'http' || !servesManifestWrite(deps)) return undefined;
  const { mapping } = binding;
  if (mapping.method === 'GET' || mapping.bulk !== undefined) return undefined;
  const connection = configuration.connectionSettings.get(binding.connection);
  if (connection === undefined) return undefined;
  const log = logger(deps, binding.connection, mapping.method);

  return {
    async write(records, heartbeat) {
      const credential = await connectionCredential(deps.vault, connection.credentialRef);
      if (credential === 'unusable') return UNUSABLE;
      const states: DirectRecordState[] = records.map(() => 'retriable');
      let next = 0;
      let stopped = false;
      const worker = async (): Promise<void> => {
        while (!stopped && next < records.length) {
          const index = next;
          next += 1;
          const record = records[index];
          // In range by the loop condition; kept for noUncheckedIndexedAccess.
          if (record === undefined) continue;
          let outcome: RecordSendOutcome;
          try {
            outcome = await adapter.writeRecord({ connection, mapping, record, args: deps.args, ...(credential === undefined ? {} : { credential }) });
          } catch (error) {
            // A rejected send stops every lane: no request may start that could race the retry's read-before-write.
            stopped = true;
            throw error;
          }
          log(outcome);
          heartbeat();
          // The SDK's mapping, shared with the preset contract helper (OPS-6).
          const state: DirectRecordState = recordOutcomeOf(outcome);
          states[index] = state;
          if (state === 'retriable') stopped = true;
        }
      };
      const lanes = Math.max(1, Math.min(connection.maxConcurrency, records.length));
      // Wait for every lane, so a rejection surfaces only once nothing is in flight; then rethrow the first.
      const settled = await Promise.allSettled(Array.from({ length: lanes }, worker));
      const rejected = settled.find((result): result is PromiseRejectedResult => result.status === 'rejected');
      if (rejected !== undefined) throw rejected.reason;
      return { ok: true, states };
    },
  };
}

/**
 * undefined unless the binding is kind `code` with a write operation, for a manifest write. The
 * code module answers one outcome per record; an answer of another length is a non-retriable
 * `invalid_response` (every to-write item ends `no_outcome`), never trusted in part (T9-M2).
 */
export function createCodeRecordWriter(deps: DirectWriterDeps): DirectWriter | undefined {
  const { configuration, adapter, operationId } = deps;
  const binding = configuration.bindings.get(operationId);
  if (binding?.kind !== 'code' || !servesManifestWrite(deps)) return undefined;
  const code = configuration.codeOperations.get(operationId);
  if (code?.kind !== 'write') return undefined;
  const operation: CodeWriteOperation = code;
  const connection = configuration.connectionSettings.get(binding.connection);
  if (connection === undefined) return undefined;
  const log = logger(deps, binding.connection, 'CODE');

  return {
    async write(records, heartbeat) {
      const credential = await connectionCredential(deps.vault, connection.credentialRef);
      if (credential === 'unusable') return UNUSABLE;
      const outcome = await adapter.codeWrite({
        connection,
        name: binding.name,
        operation,
        records,
        args: deps.args,
        direction: deps.direction ?? 'forward',
        ...(credential === undefined ? {} : { credential }),
        onProgress: heartbeat,
      });
      if (!outcome.ok) {
        log(outcome);
        return { ok: false, code: outcome.code, retriable: outcome.retriable };
      }
      if (outcome.outcomes.length !== records.length) {
        log({ ok: false, code: MISALIGNED.code, durationMs: outcome.durationMs });
        return MISALIGNED;
      }
      log(outcome);
      return { ok: true, states: outcome.outcomes };
    },
  };
}
