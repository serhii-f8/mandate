// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Mandate Authors
/**
 * The JSON-RPC answers of the MCP endpoint when a request is over its rate limit or the limit
 * cannot be checked (SEC-10). Fixed text: nothing of the request but its JSON-RPC id is echoed.
 */

/** `Retry-After` of the answer when the counter is unavailable (fail closed). */
export const UNAVAILABLE_RETRY_AFTER_SECONDS = 5;

export interface RateLimitErrorBody {
  readonly jsonrpc: '2.0';
  readonly id: string | number | null;
  readonly error: {
    readonly code: -32000;
    readonly message: string;
    readonly data: { readonly reason: 'rate_limited' | 'rate_limit_unavailable'; readonly retryAfterSeconds: number };
  };
}

/** The JSON-RPC id of a parsed request body: a string or number `id` of a single request, else null (a batch gets null). */
export function requestId(body: unknown): string | number | null {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) return null;
  const id: unknown = (body as { id?: unknown }).id;
  return typeof id === 'string' || typeof id === 'number' ? id : null;
}

/** The 429 body; `retryAfterSeconds` is also the `Retry-After` header. */
export function rateLimitedBody(id: string | number | null, retryAfterSeconds: number): RateLimitErrorBody {
  return {
    jsonrpc: '2.0',
    id,
    error: {
      code: -32000,
      message: `Rate limit exceeded; retry after ${String(retryAfterSeconds)} seconds`,
      data: { reason: 'rate_limited', retryAfterSeconds },
    },
  };
}

/** The 503 body when the counter fails. */
export function rateLimitUnavailableBody(id: string | number | null): RateLimitErrorBody {
  return {
    jsonrpc: '2.0',
    id,
    error: {
      code: -32000,
      message: 'Rate limit check unavailable; retry later',
      data: { reason: 'rate_limit_unavailable', retryAfterSeconds: UNAVAILABLE_RETRY_AFTER_SECONDS },
    },
  };
}
