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

export interface DirectReadInvokerDeps {
  /** The active configuration, read per call so a reload takes effect (CFG-2). */
  readonly configuration: () => LoadedConfiguration;
  readonly vault: CredentialVault;
  readonly adapter: ReadAdapter;
}

const isScheme = (scheme: string): scheme is CredentialScheme => (CREDENTIAL_SCHEMES as readonly string[]).includes(scheme);

/** The vault handle as the SDK's credential source; decrypts only when the adapter opens it (SEC-2). */
function credentialSource(handle: CredentialHandle, scheme: CredentialScheme): CredentialSource {
  return { ref: handle.ref, scheme, open: () => handle.open() };
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
    const configuration = this.deps.configuration();
    const binding = configuration.bindings.get(operation.id);
    const connection = binding === undefined ? undefined : configuration.connectionSettings.get(binding.connection);
    if (binding === undefined || connection === undefined) {
      // Not reachable with a fully checked configuration; answered without detail all the same.
      return { isError: true, text: READ_RESULT_TEXT.unknown(operation.id), auditDetails: { ...base, errorCode: 'not_bound' } };
    }

    let credential: CredentialSource | undefined;
    if (connection.credentialRef !== undefined) {
      const handle = await this.deps.vault.handle(connection.credentialRef);
      if (handle !== undefined) {
        if (!isScheme(handle.scheme)) {
          return { ...readErrorResult(operation.id, 'credential_unusable'), auditDetails: { ...base, errorCode: 'credential_unusable' } };
        }
        credential = credentialSource(handle, handle.scheme);
      }
    }

    const outcome = await this.deps.adapter.read({ connection, mapping: binding.mapping, args, ...(credential === undefined ? {} : { credential }) });
    return fromOutcome(operation.id, base, outcome);
  }
}
