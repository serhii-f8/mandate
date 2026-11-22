// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Mandate Authors
import { validateHostHeader, validateOriginHeader } from '@modelcontextprotocol/server';

/**
 * DNS-rebinding protection for the MCP endpoint (ADR 0013). The SDK handler
 * checks neither header, so `api` does, with the SDK's own validators.
 * Host names are compared without the port. IPv6 entries may be written with
 * or without brackets; the SDK compares the bracketed form (`[::1]`).
 */
function normalize(allowedHosts: readonly string[]): string[] {
  return allowedHosts.map((h) => (h.includes(':') && !h.startsWith('[') ? `[${h}]` : h));
}

export function hostAllowed(host: string | undefined, allowedHosts: readonly string[]): boolean {
  if (host === undefined || host === '') return false;
  return validateHostHeader(host, normalize(allowedHosts)).ok;
}

/** A missing Origin (non-browser client) is allowed; a present one must name an allowed host. */
export function originAllowed(origin: string | undefined, allowedHosts: readonly string[]): boolean {
  if (origin === undefined) return true;
  return validateOriginHeader(origin, normalize(allowedHosts)).ok;
}
