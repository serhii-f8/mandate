// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Mandate Authors
/** Who may search and export the audit log on the trusted page (SEC-1, AUD-6). */
import type { LoadedConfiguration } from '@mandate/config';

/** True when one of `roles` has `view_audit: true` in `configuration`; no role, no access. */
export function mayViewAudit(configuration: LoadedConfiguration, roles: readonly string[]): boolean {
  return roles.some((role) => configuration.auditViewers.has(role));
}
