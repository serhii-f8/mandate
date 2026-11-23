// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Mandate Authors
/**
 * The worker implementation of the core `OpaqueCaller` port (design phase 9 §5): one upstream
 * call of an opaque operation through the connection's `WriteAdapter.callOnce`, or for a code
 * binding through `CodeAdapter.codeCall` after `beforeSend` (ruling F3), sent at most once
 * (EXE-4, NFR-2). Pre-flight (an adapter with `callOnce`, NFR-18; credential; for an MCP tool a fresh pin check, CONN-4) answers
 * `not_sent` without calling the adapter. The credential is opened only inside the adapter
 * (SEC-2); each call logs identifiers, method, status and timing only, never arguments (SEC-3).
 */
import type { LoadedConfiguration, PinEvaluation } from '@mandate/config';
import type { CallOutcome, CallTarget, CodeAdapter, ConnectionSettings, CodeCallOperation, CodeCallResult, WriteAdapter, WriteErrorCode } from '@mandate/connector-sdk';
import { fileDescriptorAt, isOpaque, sha256Of, storedFilesMatch, withValueAt, type CredentialVault, type FileArgument, type FileLink, type FileStore, type OpaqueCaller, type OpaqueCallOutcome, type OpaqueNotSentCode } from '@mandate/core';
import { connectionCredential, type UpstreamCallLog } from './read.js';

export interface OpaqueCallerDeps {
  /** The configuration this execution runs under (the activity's snapshot). */
  readonly configuration: LoadedConfiguration;
  readonly vault: CredentialVault;
  /** Code calls need `codeCall`; without it a code-bound call fails closed with `not_sent/upstream_unavailable`. */
  readonly adapter: WriteAdapter & Partial<Pick<CodeAdapter, 'codeCall'>>;
  readonly operationId: string;
  readonly correlationId: string;
  /**
   * A fresh pin evaluation of an MCP-backed operation, built per call as
   * `(id) => verifyPinNow(lister, configuration, id)` (ruling F8). Absent (no tool lister wired),
   * an MCP call fails closed with `not_sent/upstream_unavailable`.
   */
  readonly pinCheck?: (operationId: string) => Promise<PinEvaluation | undefined>;
  /**
   * The staged files' content (CS-10). Absent, a call of an operation with files, or one that
   * carries links, is `not_sent/file_unavailable`: content is never sent unchecked.
   */
  readonly files?: Pick<FileStore, 'content'>;
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

/** A code call's result as the port's (OPS-5): success, a definite refusal, or an outcome nobody knows. */
function codeOutcomeOf(result: CodeCallResult): OpaqueCallOutcome {
  if (result.ok) return { kind: 'accepted' };
  return { kind: result.definite ? 'refused' : 'unknown' };
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
 * The arguments with each `send: base64` file replaced by its stored content, standard base64 with padding
 * (EXE-4, CS-10); undefined when a file is missing, purged, differs from its sealed descriptor, or the links
 * are not exactly what the operation declares. Nothing is returned for content that does not hash to the
 * descriptor's `sha256`, and neither content nor name is logged or thrown (SEC-3).
 */
async function argsWithFiles(
  operation: { readonly files?: readonly FileArgument[] },
  args: Readonly<Record<string, unknown>>,
  links: readonly FileLink[],
  store: Pick<FileStore, 'content'> | undefined,
): Promise<Readonly<Record<string, unknown>> | undefined> {
  if (!storedFilesMatch(operation.files, { args, files: links })) return undefined;
  if (store === undefined) return undefined;
  let sent = args;
  for (const entry of operation.files ?? []) {
    const descriptor = fileDescriptorAt(args, entry.path);
    if (descriptor === undefined) return undefined;
    const content = await store.content(descriptor.id);
    if (content === undefined) return undefined;
    if (content.byteLength !== descriptor.size || sha256Of(content) !== descriptor.sha256) return undefined;
    // Only base64 exists until multipart sending lands; any other kind never goes out as base64.
    if (entry.send !== 'base64') return undefined;
    sent = withValueAt(sent, entry.path, Buffer.from(content).toString('base64'));
  }
  return sent;
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

  if (binding.kind === 'code') return createCodeCaller(deps, binding.connection, binding.name, connection);

  let target: CallTarget;
  let method: string;
  let idempotencyHeader: string | undefined;
  switch (binding.kind) {
    case 'http':
      // An opaque call is one request; a bulk mapping is never one (OPS-6).
      if (binding.mapping.bulk !== undefined) return undefined;
      target = { kind: 'http', mapping: binding.mapping };
      method = binding.mapping.method;
      // Header names are case-insensitive; the recorded submission names the lower-case form (EXE-4).
      idempotencyHeader = binding.mapping.idempotency?.header.toLowerCase();
      break;
    case 'mcp':
      target = { kind: 'mcp', tool: binding.tool };
      method = 'tools/call';
      idempotencyHeader = undefined;
      break;
  }

  const log = (record: { readonly status?: number; readonly durationMs: number; readonly errorCode?: string }): void =>
    deps.log?.({ correlationId: deps.correlationId, operation: operationId, connection: binding.connection, method, ...record });
  const refuse = (code: OpaqueNotSentCode): OpaqueCallOutcome => {
    log({ durationMs: 0, errorCode: code });
    return { kind: 'not_sent', code };
  };

  return {
    ...(idempotencyHeader === undefined ? {} : { idempotencyHeader }),
    async call({ args: callArgs, idempotencyKey, files, beforeSend }) {
      let args = callArgs;
      // An adapter written against connector-sdk 0.5.x has no callOnce (NFR-18): fail closed, nothing sent.
      if (adapter.callOnce === undefined) return refuse('upstream_unavailable');
      const credential = await connectionCredential(deps.vault, connection.credentialRef);
      if (credential === 'unusable') return refuse('credential_unusable');
      if (binding.kind === 'mcp') {
        // A file argument is an HTTP feature (OPS-8): a link here is a mismatch and nothing is sent.
        if ((files?.length ?? 0) > 0) return refuse('file_unavailable');
        // Fail closed: without a fresh list the pin cannot be verified (ruling F8, F20).
        const refusal = deps.pinCheck === undefined ? 'upstream_unavailable' : pinRefusal(await deps.pinCheck(operationId));
        if (refusal !== undefined) return refuse(refusal);
      }
      if ((operation.files?.length ?? 0) > 0 || (files?.length ?? 0) > 0) {
        // CS-10: load each file, hash it against the sealed descriptor, and only then put it into the request.
        const withFiles = binding.kind === 'http' ? await argsWithFiles(operation, args, files ?? [], deps.files) : undefined;
        if (withFiles === undefined) return refuse('file_unavailable');
        args = withFiles;
      }
      // beforeSend goes to the adapter unchanged: if it throws, nothing is sent and the error propagates.
      const outcome = await adapter.callOnce({
        connection,
        target,
        args,
        ...(credential === undefined ? {} : { credential }),
        ...(idempotencyHeader === undefined ? {} : { idempotencyKey }),
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

/**
 * The code branch (OPS-5, ruling F3): never idempotent (no `idempotencyHeader`), logged as `CODE`. Pre-flight answers
 * `not_sent` without calling `beforeSend`: an adapter without `codeCall` (`upstream_unavailable`),
 * an unusable credential, a module operation that is absent or not a `call` (`upstream_rejected`).
 * Then `beforeSend` records the submission; if it throws, the error propagates and the code module
 * never runs (EXE-4). The code module's result maps to `accepted`, `refused` or `unknown`.
 */
function createCodeCaller(
  deps: OpaqueCallerDeps,
  connectionId: string,
  name: string,
  connection: ConnectionSettings,
): OpaqueCaller {
  const log = (record: { readonly durationMs: number; readonly errorCode?: string }): void =>
    deps.log?.({ correlationId: deps.correlationId, operation: deps.operationId, connection: connectionId, method: 'CODE', ...record });
  const refuse = (code: OpaqueNotSentCode): OpaqueCallOutcome => {
    log({ durationMs: 0, errorCode: code });
    return { kind: 'not_sent', code };
  };
  return {
    async call({ args, files, beforeSend }) {
      const { adapter } = deps;
      if ((files?.length ?? 0) > 0) return refuse('file_unavailable');
      const { codeCall } = adapter;
      if (codeCall === undefined) return refuse('upstream_unavailable');
      const credential = await connectionCredential(deps.vault, connection.credentialRef);
      if (credential === 'unusable') return refuse('credential_unusable');
      const code = deps.configuration.codeOperations.get(deps.operationId);
      if (code?.kind !== 'call') return refuse('upstream_rejected');
      const operation: CodeCallOperation = code;
      await beforeSend();
      const result = await codeCall.call(adapter, { connection, name, operation, args, ...(credential === undefined ? {} : { credential }) });
      log({ durationMs: result.durationMs, ...(result.ok ? {} : { errorCode: result.code }) });
      return codeOutcomeOf(result);
    },
  };
}
