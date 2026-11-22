// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Mandate Authors
/**
 * The role behind an allow decision's rule (`role:<id>/grant:<id>`), for limits that are
 * keyed by role (POL-4). Built-ins and default-deny have none.
 */
export function allowingRole(rule: string): string | undefined {
  const match = /^role:([^/]+)\//.exec(rule);
  return match?.[1];
}
