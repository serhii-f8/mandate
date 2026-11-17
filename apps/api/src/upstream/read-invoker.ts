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

/** The direct path runs only `read` operations bound to GET; anything else goes through a change-set (MCP-4, CS-1). */
export const NOT_DIRECT_READ = 'only read operations bound to GET run directly';

/** One log record per upstream call: identifiers, status and timing only (SEC-3). */
export interface UpstreamCallLog {
  readonly correlationId: string;
  readonly operation: string;
  readonly connection: string;
  /** HTTP method of the binding; always GET for reads (CS-1). */
  readonly method: string;
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

/** What one read through a binding produced: a refusal before any upstream call, or the adapter outcome. */
export type SingleRead =
  | { readonly ok: false; readonly code: 'not_bound' }
  | { readonly ok: false; readonly code: 'not_get' | 'credential_unusable'; readonly connection: string }
  | { readonly ok: true; readonly outcome: ReadOutcome; readonly connection: string };

export type SingleReadDeps = Pick<DirectReadInvokerDeps, 'configuration' | 'vault' | 'adapter' | 'correlationId' | 'log'>;

/**
 * One upstream read under the given configuration (design §4.2): binding lookup, the GET
 * check, the credential (opened only inside the adapter, SEC-2), the adapter call and one
 * log line with identifiers, method, status and timing only (SEC-3). No policy decision:
 * callers have made it.
 */
export async function performRead(deps: SingleReadDeps, operationId: string, args: Readonly<Record<string, unknown>>): Promise<SingleRead> {
  const { configuration } = deps;
  const binding = configuration.bindings.get(operationId);
  const connection = binding === undefined ? undefined : configuration.connectionSettings.get(binding.connection);
  if (binding === undefined || connection === undefined) return { ok: false, code: 'not_bound' };
  // Configuration refuses a read that is not GET; checked again so nothing writes without a change-set (CS-1, MCP-4).
  if (binding.mapping.method !== 'GET') return { ok: false, code: 'not_get', connection: binding.connection };
  const credential = await connectionCredential(deps.vault, connection.credentialRef);
  if (credential === 'unusable') return { ok: false, code: 'credential_unusable', connection: binding.connection };

  const outcome = await deps.adapter.read({ connection, mapping: binding.mapping, args, ...(credential === undefined ? {} : { credential }) });
  deps.log?.({
    correlationId: deps.correlationId ?? '',
    operation: operationId,
    connection: binding.connection,
    method: binding.mapping.method,
    ...(outcome.status === undefined ? {} : { status: outcome.status }),
    durationMs: outcome.durationMs,
    ...(outcome.ok ? {} : { errorCode: outcome.code }),
  });
  return { ok: true, outcome, connection: binding.connection };
}

export class DirectReadInvoker implements OperationInvoker {
  constructor(private readonly deps: DirectReadInvokerDeps) {}

  async invoke({ operation, args }: InvocationRequest): Promise<InvocationResult> {
    const base: Details = { operation: operation.id, connection: operation.connection };
    const notDirect = (details: Details): InvocationResult => ({
      isError: true,
      text: `${operation.id} cannot run: ${NOT_DIRECT_READ}.`,
      auditDetails: { ...details, errorCode: 'not_readable' },
    });
    if (operation.risk !== 'read') return notDirect(base);

    const read = await performRead(this.deps, operation.id, args);
    if (!read.ok && read.code === 'not_bound') {
      // Not reachable with a fully checked configuration; answered without detail all the same.
      return { isError: true, text: READ_RESULT_TEXT.unknown(operation.id), auditDetails: { ...base, errorCode: 'not_bound' } };
    }
    // From here on the binding decides the connection, for the call and for the audit.
    const bound: Details = { operation: operation.id, connection: read.connection };
    if (!read.ok) {
      if (read.code === 'not_get') return notDirect(bound);
      return { ...readErrorResult(operation.id, 'credential_unusable'), auditDetails: { ...bound, errorCode: 'credential_unusable' } };
    }
    return fromOutcome(operation.id, bound, read.outcome);
  }
}
