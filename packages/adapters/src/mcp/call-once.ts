/**
 * The outcome of one MCP `tools/call` sent at most once (EXE-4, NFR-2, ruling F7), codes only
 * (SEC-3, SEC-5): the result's content, `structuredContent` and `_meta` are never read, and no
 * upstream text reaches the outcome. Only a definite answer reads `refused`; anything that may
 * have been applied is `unknown`, the fail-safe class.
 */
import type { CallOutcome } from '@aiops/connector-sdk';
import { InsufficientScopeError, ProtocolError, SdkError, SdkErrorCode, SdkHttpError } from '@modelcontextprotocol/client';
import { GuardedFetchError } from '../http/guarded-fetch.js';

/** A tools/call result: without `isError` it is accepted, with `isError: true` a refusal. */
export function outcomeOfResult(result: Readonly<Record<string, unknown>>, durationMs: number): CallOutcome {
  return result.isError === true ? { result: 'refused', code: 'rejected', durationMs } : { result: 'accepted', durationMs };
}

function guardedCause(error: unknown): GuardedFetchError | undefined {
  for (let e: unknown = error, depth = 0; e instanceof Error && depth < 8; e = e.cause, depth += 1) {
    if (e instanceof GuardedFetchError) return e;
  }
  return undefined;
}

/**
 * The outcome of an error thrown once the hook ran and the call may have left. A JSON-RPC error
 * answer, a transport 4xx and a 403 insufficient_scope are refusals; a 5xx, a redirect, a timeout,
 * a network error, a cut-off or oversized body, an aborted stream and any other error are
 * `unknown`. Only the egress guard refusing the resolved address at connect sent nothing (R4).
 */
export function outcomeAfterSend(error: unknown, durationMs: number): CallOutcome {
  const guarded = guardedCause(error);
  if (guarded !== undefined) {
    if (guarded.code === 'egress_denied') {
      return guarded.status === undefined ? { result: 'not_sent', code: 'egress_denied', durationMs } : { result: 'unknown', code: 'http_status', status: guarded.status, durationMs };
    }
    return { result: 'unknown', code: guarded.code, ...(guarded.status === undefined ? {} : { status: guarded.status }), durationMs };
  }
  if (ProtocolError.isInstance(error)) return { result: 'refused', code: 'rejected', durationMs };
  if (error instanceof InsufficientScopeError) return { result: 'refused', code: 'rejected', status: 403, durationMs };
  if (SdkHttpError.isInstance(error)) {
    const status = error.status;
    if (typeof status === 'number' && status >= 400 && status < 500) return { result: 'refused', code: 'rejected', status, durationMs };
    return { result: 'unknown', code: 'http_status', ...(typeof status === 'number' ? { status } : {}), durationMs };
  }
  if (SdkError.isInstance(error) && error.code === SdkErrorCode.RequestTimeout) return { result: 'unknown', code: 'timeout', durationMs };
  if (error instanceof Error && error.name === 'AbortError') return { result: 'unknown', code: 'network', durationMs };
  return { result: 'unknown', code: 'upstream_error', durationMs };
}
