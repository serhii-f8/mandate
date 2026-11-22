// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Mandate Authors
import type { ManifestTemplate } from '../policy-model.js';

/** The arguments of a manifest read: literals as they are, `{ arg }` from the call or its default. */
export function resolveTemplates(
  templates: Readonly<Record<string, ManifestTemplate>>,
  args: Readonly<Record<string, unknown>>,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, t] of Object.entries(templates)) {
    const value = typeof t === 'object' ? (args[t.arg] ?? t.default) : t;
    if (value !== undefined) out[key] = value;
  }
  return out;
}
