// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The AI Operations Layer Authors
/**
 * Conformance scenarios the platform implements (NFR-16, MCP-1): each must run, report at least
 * one check and have no failing check. A baseline may never excuse one of them wholesale; it may
 * excuse a single check of one only when that check needs a capability the platform does not
 * offer (ADR 0055).
 */
export const MUST_PASS: Record<'2026-07-28' | '2025-11-25', readonly string[]> = {
  '2026-07-28': ['server-stateless', 'tools-list', 'caching', 'dns-rebinding-protection', 'sep-2164-resource-not-found', 'resources-list', 'server-sse-multiple-streams'],
  '2025-11-25': ['server-initialize', 'ping', 'tools-list', 'resources-list', 'dns-rebinding-protection'],
};
