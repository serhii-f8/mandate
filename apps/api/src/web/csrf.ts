// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Mandate Authors
import { timingSafeEqual } from 'node:crypto';

/** Constant-time comparison; unequal lengths are unequal without comparing content. */
export function constantTimeEqual(a: string, b: string): boolean {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  if (x.length !== y.length) return false;
  return timingSafeEqual(x, y);
}

type HeaderValue = string | string[] | undefined;

/**
 * SEC-8 synchroniser token plus origin check: `X-CSRF-Token` equals the session's token
 * (constant time) and `Origin` equals the public origin exactly (scheme, host and port).
 */
export function csrfAllowed(headers: Readonly<Record<string, HeaderValue>>, sessionToken: string, publicOrigin: string): boolean {
  const origin = headers.origin;
  const token = headers['x-csrf-token'];
  if (typeof origin !== 'string' || typeof token !== 'string') return false;
  const tokenOk = constantTimeEqual(token, sessionToken);
  return origin === publicOrigin && tokenOk;
}
