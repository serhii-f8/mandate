/**
 * One upstream read under a configuration snapshot (design §4.2), shared by the api read
 * path and the worker: binding lookup, the GET check, the credential and the adapter call.
 */
import { CREDENTIAL_SCHEMES, type CredentialScheme, type CredentialSource, type ReadAdapter, type ReadOutcome } from '@aiops/connector-sdk';
import type { LoadedConfiguration } from '@aiops/config';
import type { CredentialHandle, CredentialVault } from '@aiops/core';

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

/** What one read through a binding produced: a refusal before any upstream call, or the adapter outcome. */
export type SingleRead =
  | { readonly ok: false; readonly code: 'not_bound' }
  | { readonly ok: false; readonly code: 'not_get' | 'credential_unusable'; readonly connection: string }
  | { readonly ok: true; readonly outcome: ReadOutcome; readonly connection: string };

export interface ReadDeps {
  /** The request's configuration snapshot, the one its policy decision used (SEC-1). */
  readonly configuration: LoadedConfiguration;
  readonly vault: CredentialVault;
  readonly adapter: ReadAdapter;
  readonly correlationId?: string;
  readonly log?: (record: UpstreamCallLog) => void;
}

/**
 * One upstream read under the given configuration (design §4.2): binding lookup, the GET
 * check, the credential (opened only inside the adapter, SEC-2), the adapter call and one
 * log line with identifiers, method, status and timing only (SEC-3). No policy decision:
 * callers have made it.
 */
export async function performRead(
  deps: ReadDeps,
  operationId: string,
  args: Readonly<Record<string, unknown>>,
  options: { readonly exactValues?: true } = {},
): Promise<SingleRead> {
  const { configuration } = deps;
  const binding = configuration.bindings.get(operationId);
  const connection = binding === undefined ? undefined : configuration.connectionSettings.get(binding.connection);
  if (binding === undefined || connection === undefined) return { ok: false, code: 'not_bound' };
  // MCP-backed reads are not wired here yet (Phase 9 adapter plan, Task 9).
  if (binding.kind !== 'http') return { ok: false, code: 'not_bound' };
  // Configuration refuses a read that is not GET; checked again so nothing writes without a change-set (CS-1, MCP-4).
  if (binding.mapping.method !== 'GET') return { ok: false, code: 'not_get', connection: binding.connection };
  const credential = await connectionCredential(deps.vault, connection.credentialRef);
  if (credential === 'unusable') return { ok: false, code: 'credential_unusable', connection: binding.connection };

  const outcome = await deps.adapter.read({
    connection,
    mapping: binding.mapping,
    args,
    ...(credential === undefined ? {} : { credential }),
    ...(options.exactValues === true ? { exactValues: true } : {}),
  });
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

