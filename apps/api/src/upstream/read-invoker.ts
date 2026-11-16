/**
 * The direct read path (design part 1 §5, ADR 0017 decision 6): an allowed `read`
 * operation runs from `api` straight through its connection's adapter, as SPEC
 * section 2 says for reads. Writes need change-sets (Phase 4).
 */
import { CREDENTIAL_SCHEMES, type CredentialScheme, type CredentialSource, type ReadAdapter, type ReadOutcome } from '@aiops/connector-sdk';
import type { LoadedConfiguration } from '@aiops/config';
import {
  READ_RESULT_TEXT,
  readErrorResult,
  readToolResult,
  type CredentialHandle,
  type CredentialVault,
  type InvocationRequest,
  type InvocationResult,
  type OperationInvoker,
} from '@aiops/core';

export const WRITE_NEEDS_CHANGESET = 'write operations need change-sets, which arrive in Phase 4';

/** One log record per upstream call: identifiers, status and timing only (SEC-3). */
export interface UpstreamCallLog {
  readonly correlationId: string;
  readonly operation: string;
  readonly connection: string;
  readonly status?: number;
  readonly durationMs: number;
  readonly errorCode?: string;
}

export interface DirectReadInvokerDeps {
  /** The request's configuration snapshot, the one its policy decision used (SEC-1). */
  readonly configuration: LoadedConfiguration;
  readonly vault: CredentialVault;
  readonly adapter: ReadAdapter;
  readonly correlationId?: string;
  readonly log?: (record: UpstreamCallLog) => void;
}

/** Builds the per-call invoker the pipeline asks for (`PipelineDeps.invokerFor`). */
export function directReadInvokers(
  base: Omit<DirectReadInvokerDeps, 'configuration' | 'correlationId'>,
): (configuration: LoadedConfiguration, correlationId: string) => DirectReadInvoker {
  return (configuration, correlationId) => new DirectReadInvoker({ ...base, configuration, correlationId });
}

const isScheme = (scheme: string): scheme is CredentialScheme => (CREDENTIAL_SCHEMES as readonly string[]).includes(scheme);

/** The vault handle as the SDK's credential source; decrypts only when the adapter opens it (SEC-2). */
function credentialSource(handle: CredentialHandle, scheme: CredentialScheme): CredentialSource {
  return { ref: handle.ref, scheme, open: () => handle.open() };
}

/**
 * The credential of a connection as the adapter takes it: `undefined` when the connection
 * has no reference or nothing is stored (the adapter answers `credential_missing` if it
 * needs one), `'unusable'` when the stored scheme is unknown.
 */
export async function connectionCredential(vault: CredentialVault, ref: string | undefined): Promise<CredentialSource | 'unusable' | undefined> {
  if (ref === undefined) return undefined;
  const handle = await vault.handle(ref);
  if (handle === undefined) return undefined;
  return isScheme(handle.scheme) ? credentialSource(handle, handle.scheme) : 'unusable';
}

type Details = Record<string, string | number | boolean>;

function fromOutcome(operation: string, base: Details, outcome: ReadOutcome): InvocationResult {
  if (!outcome.ok) {
    // The adapter's message stays out of the result and the audit: only the fixed code (SEC-3).
    const details: Details = { ...base, ...(outcome.status === undefined ? {} : { upstreamStatus: outcome.status }), upstreamMs: outcome.durationMs, errorCode: outcome.code };
    return { ...readErrorResult(operation, outcome.code, outcome.status), auditDetails: details };
  }
  const result = readToolResult({
    operation,
    ...(outcome.items === undefined ? { value: outcome.value } : { items: outcome.items }),
    ...(outcome.total === undefined ? {} : { total: outcome.total }),
    truncated: outcome.truncated,
  });
  const itemCount = outcome.items?.length;
  return {
    ...result,
    auditDetails: { ...base, upstreamStatus: outcome.status, ...(itemCount === undefined ? {} : { itemCount }), upstreamMs: outcome.durationMs },
  };
}

export class DirectReadInvoker implements OperationInvoker {
  constructor(private readonly deps: DirectReadInvokerDeps) {}

  async invoke({ operation, args }: InvocationRequest): Promise<InvocationResult> {
    const base: Details = { operation: operation.id, connection: operation.connection };
    if (operation.risk !== 'read') {
      return { isError: true, text: `${operation.id} cannot run: ${WRITE_NEEDS_CHANGESET}.`, auditDetails: { ...base, errorCode: 'write_not_supported' } };
    }
    const { configuration } = this.deps;
    const binding = configuration.bindings.get(operation.id);
    const connection = binding === undefined ? undefined : configuration.connectionSettings.get(binding.connection);
    if (binding === undefined || connection === undefined) {
      // Not reachable with a fully checked configuration; answered without detail all the same.
      return { isError: true, text: READ_RESULT_TEXT.unknown(operation.id), auditDetails: { ...base, errorCode: 'not_bound' } };
    }

    // From here on the binding decides the connection, for the call and for the audit.
    const bound: Details = { operation: operation.id, connection: binding.connection };
    const credential = await connectionCredential(this.deps.vault, connection.credentialRef);
    if (credential === 'unusable') {
      return { ...readErrorResult(operation.id, 'credential_unusable'), auditDetails: { ...bound, errorCode: 'credential_unusable' } };
    }

    const outcome = await this.deps.adapter.read({ connection, mapping: binding.mapping, args, ...(credential === undefined ? {} : { credential }) });
    this.deps.log?.({
      correlationId: this.deps.correlationId ?? '',
      operation: operation.id,
      connection: binding.connection,
      ...(outcome.status === undefined ? {} : { status: outcome.status }),
      durationMs: outcome.durationMs,
      ...(outcome.ok ? {} : { errorCode: outcome.code }),
    });
    return fromOutcome(operation.id, bound, outcome);
  }
}
