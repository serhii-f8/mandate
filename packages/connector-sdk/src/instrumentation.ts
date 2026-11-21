// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The AI Operations Layer Authors
import type { HttpMethod } from './mapping.js';

/** One upstream request attempt as instrumentation sees it: identifiers only (SEC-3). */
export interface RequestAttempt {
  readonly connection: string;
  readonly method: HttpMethod;
  /** URL host name only; never path, query or port-qualified credentials. */
  readonly host: string;
}

export interface RequestAttemptEnd {
  /** HTTP status when a response arrived. */
  readonly status?: number;
  /** The client's fixed code when no response arrived (`timeout`, `network`, `egress_denied`, `invalid_response`). */
  readonly errorCode?: string;
}

export interface RequestSpan {
  /** Extra request headers: only `traceparent` and `tracestate` (any case) are sent; never replace connection or auth headers. */
  readonly headers: Readonly<Record<string, string>>;
  end(result: RequestAttemptEnd): void;
}

/**
 * Optional hook around each upstream request attempt (NFR-11, NFR-12); added in 0.5.0 (NFR-18).
 * `start` is called only once the attempt holds a concurrency slot, so an attempt that ends as
 * `busy` never starts a span. A throwing hook never fails or alters the request.
 */
export interface RequestInstrumentation {
  start(attempt: RequestAttempt): RequestSpan;
}
