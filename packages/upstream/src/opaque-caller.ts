/**
 * The worker implementation of the core `OpaqueCaller` port (design phase 9 §5): one upstream
 * call of an opaque operation through the connection's `WriteAdapter.callOnce`, sent at most once
 * (EXE-4, NFR-2). Pre-flight (credential; for an MCP tool a fresh pin check, CONN-4) answers
 * `not_sent` without calling the adapter. The credential is opened only inside the adapter
 * (SEC-2); each call logs identifiers, method, status and timing only, never arguments (SEC-3).
 */
import type { LoadedConfiguration, PinEvaluation } from '@aiops/config';
import type { CallOutcome, CallTarget, WriteAdapter, WriteErrorCode } from '@aiops/connector-sdk';
import { isOpaque, type CredentialVault, type OpaqueCaller, type OpaqueCallOutcome, type OpaqueNotSentCode } from '@aiops/core';
import { connectionCredential, type UpstreamCallLog } from './read.js';

export interface OpaqueCallerDeps {
  /** The configuration this execution runs under (the activity's snapshot). */
  readonly configuration: LoadedConfiguration;
  readonly vault: CredentialVault;
  readonly adapter: WriteAdapter;
  readonly operationId: string;
  readonly correlationId: string;
  /**
   * A fresh pin evaluation of an MCP-backed operation, built per call as
   * `(id) => verifyPinNow(lister, configuration, id)` (ruling F8). Absent (no tool lister wired),
   * an MCP call fails closed with `not_sent/upstream_unavailable`.
   */
  readonly pinCheck?: (operationId: string) => Promise<PinEvaluation | undefined>;
  readonly log?: (record: UpstreamCallLog) => void;
}

/** A pre-send failure code of the adapter as the port's code (ruling F9). */
function notSentCode(code: WriteErrorCode | undefined): OpaqueNotSentCode {
  switch (code) {
    case 'credential_missing':
    case 'credential_unusable':
    case 'egress_denied':
      return code;
    case 'mapping':
    case 'rejected':
      return 'upstream_rejected';
    case 'busy':
    case 'timeout':
    case 'network':
    case 'http_status':
    case 'upstream_error':
    case 'invalid_response':
    case undefined:
      return 'upstream_unavailable';
  }
}

/** The adapter outcome as the port's: codes of a sent call stay behind (SEC-5). */
function outcomeOf(outcome: CallOutcome): OpaqueCallOutcome {
  switch (outcome.result) {
    case 'accepted':
    case 'refused':
    case 'unknown':
      return { kind: outcome.result };
    case 'not_sent':
      return { kind: 'not_sent', code: notSentCode(outcome.code) };
  }
}

/** The pin state of a fresh check as a refusal, or undefined when the call may go ahead (CONN-4). */
function pinRefusal(evaluation: PinEvaluation | undefined): OpaqueNotSentCode | undefined {
  switch (evaluation?.state) {
    case 'ok':
      return undefined;
    case 'changed':
    case 'missing':
      return 'upstream_changed';
    case 'unverified':
    case 'schema_invalid':
    case undefined:
      return 'upstream_unavailable';
  }
}

/**
 * undefined when the operation has no binding or connection settings, or is not opaque. Creating
 * the caller has no side effects (the `callerFor` contract of `OpaqueCallWriter`): the vault, the
 * pin check and the adapter are reached only in `call`.
 */
export function createOpaqueCaller(deps: OpaqueCallerDeps): OpaqueCaller | undefined {
  const { configuration, adapter, operationId } = deps;
  const operation = configuration.policy.operations.find((op) => op.id === operationId);
  if (operation === undefined || !isOpaque(operation)) return undefined;
  const binding = configuration.bindings.get(operationId);
  if (binding === undefined) return undefined;
  const connection = configuration.connectionSettings.get(binding.connection);
  if (connection === undefined) return undefined;

  let target: CallTarget;
  let method: string;
  let idempotent: boolean;
  switch (binding.kind) {
    case 'http':
      // An opaque call is one request; a bulk mapping is never one (OPS-6).
      if (binding.mapping.bulk !== undefined) return undefined;
      target = { kind: 'http', mapping: binding.mapping };
      method = binding.mapping.method;
      idempotent = binding.mapping.idempotency !== undefined;
      break;
    case 'mcp':
      target = { kind: 'mcp', tool: binding.tool };
      method = 'tools/call';
      idempotent = false;
      break;
    case 'code':
      // OPS-5: code calls run once the code runner is wired (plan task 10); until then, fail closed.
      return undefined;
  }

  const log = (record: { readonly status?: number; readonly durationMs: number; readonly errorCode?: string }): void =>
    deps.log?.({ correlationId: deps.correlationId, operation: operationId, connection: binding.connection, method, ...record });
  const refuse = (code: OpaqueNotSentCode): OpaqueCallOutcome => {
    log({ durationMs: 0, errorCode: code });
    return { kind: 'not_sent', code };
  };

  return {
    idempotent,
    async call({ args, idempotencyKey, beforeSend }) {
      const credential = await connectionCredential(deps.vault, connection.credentialRef);
      if (credential === 'unusable') return refuse('credential_unusable');
      if (binding.kind === 'mcp') {
        // Fail closed: without a fresh list the pin cannot be verified (ruling F8, F20).
        const refusal = deps.pinCheck === undefined ? 'upstream_unavailable' : pinRefusal(await deps.pinCheck(operationId));
        if (refusal !== undefined) return refuse(refusal);
      }
      // beforeSend goes to the adapter unchanged: if it throws, nothing is sent and the error propagates.
      const outcome = await adapter.callOnce({
        connection,
        target,
        args,
        ...(credential === undefined ? {} : { credential }),
        ...(idempotent ? { idempotencyKey } : {}),
        beforeSend,
      });
      log({
        ...(outcome.status === undefined ? {} : { status: outcome.status }),
        durationMs: outcome.durationMs,
        ...(outcome.code === undefined ? {} : { errorCode: outcome.code }),
      });
      return outcomeOf(outcome);
    },
  };
}
