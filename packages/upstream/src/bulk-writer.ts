// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The AI Operations Layer Authors
/**
 * The worker implementation of the core `BulkWriter` port (design part 2 §4): one change-set's
 * bulk submit and status calls through the connection's `WriteAdapter` (OPS-6). The credential is
 * opened only inside the adapter (SEC-2); results keep only what the batch writer decides on, and
 * each call logs identifiers, method, status and timing only, never records or batch content (SEC-3).
 */
import type { WriteAdapter, WriteFailure } from '@aiops/connector-sdk';
import type { LoadedConfiguration } from '@aiops/config';
import type { BulkWriter, CredentialVault } from '@aiops/core';
import { connectionCredential, type UpstreamCallLog } from './read.js';

export interface BulkWriterDeps {
  readonly configuration: LoadedConfiguration;
  readonly vault: CredentialVault;
  readonly adapter: WriteAdapter;
  readonly operationId: string;
  readonly correlationId: string;
  readonly log?: (record: UpstreamCallLog) => void;
}

interface Failure {
  readonly ok: false;
  readonly code: string;
  readonly retriable: boolean;
}

const UNUSABLE: Failure = { ok: false, code: 'credential_unusable', retriable: false };

/** The port's failure: the fixed code and whether a retry may help; status and duration stay behind. */
const failure = (outcome: WriteFailure): Failure => ({ ok: false, code: outcome.code, retriable: outcome.retriable });

/** A status failure also keeps the HTTP status of an `http_status` failure: the writer retries a 401 or 403 (EXE-4). */
const statusFailure = (outcome: WriteFailure): Failure & { status?: number } =>
  outcome.code === 'http_status' && outcome.status !== undefined ? { ...failure(outcome), status: outcome.status } : failure(outcome);

/** undefined when the operation has no binding, no connection settings or no `bulk`. */
export function createBulkWriter(deps: BulkWriterDeps): BulkWriter | undefined {
  const { configuration, adapter } = deps;
  const binding = configuration.bindings.get(deps.operationId);
  // Bulk writes are HTTP only (OPS-6); an MCP tool has no bulk mapping.
  if (binding?.kind !== 'http') return undefined;
  const connection = configuration.connectionSettings.get(binding.connection);
  const bulk = binding.mapping.bulk;
  if (connection === undefined || bulk === undefined) return undefined;
  const { mapping } = binding;

  const log = (method: string, outcome: { readonly status?: number; readonly durationMs: number } & ({ ok: true } | WriteFailure)): void => {
    deps.log?.({
      correlationId: deps.correlationId,
      operation: deps.operationId,
      connection: binding.connection,
      method,
      ...(outcome.status === undefined ? {} : { status: outcome.status }),
      durationMs: outcome.durationMs,
      ...(outcome.ok ? {} : { errorCode: outcome.code }),
    });
  };

  return {
    async submit(records) {
      const credential = await connectionCredential(deps.vault, connection.credentialRef);
      if (credential === 'unusable') return UNUSABLE;
      const outcome = await adapter.submitBulk({ connection, mapping, records, ...(credential === undefined ? {} : { credential }) });
      log(mapping.method, outcome);
      return outcome.ok ? { ok: true, batchId: outcome.batchId } : failure(outcome);
    },
    async status(batchId, keys) {
      const credential = await connectionCredential(deps.vault, connection.credentialRef);
      if (credential === 'unusable') return UNUSABLE;
      const outcome = await adapter.bulkStatus({
        connection,
        mapping,
        batchId,
        keys,
        ...(credential === undefined ? {} : { credential }),
      });
      log(bulk.status.method, outcome);
      return outcome.ok ? { ok: true, items: outcome.items.map(({ index, state }) => ({ index, state })) } : statusFailure(outcome);
    },
  };
}
