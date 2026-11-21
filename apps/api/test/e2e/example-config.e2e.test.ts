// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The AI Operations Layer Authors
import { fileURLToPath } from 'node:url';
import { loadConfigurationDirectory } from '@aiops/config';
import { describe, expect, it } from 'vitest';

const EXAMPLE_DIR = fileURLToPath(new URL('../../../../examples/config', import.meta.url));
const PRESET_DIR = fileURLToPath(new URL('../../../../presets', import.meta.url));

describe('CFG-1 CFG-2 the example configuration loads with the shipped presets', () => {
  it('CFG-1 CFG-2 loads without issues and enables the documented operations, roles and limits', async () => {
    const result = await loadConfigurationDirectory(EXAMPLE_DIR, { presetDirs: [PRESET_DIR] });
    if (!result.ok) throw new Error(`example configuration has issues: ${JSON.stringify(result.issues)}`);
    const { configuration } = result;

    const operations = new Map(configuration.policy.operations.map((o) => [o.id, o]));
    expect(operations.has('catalog.update_content')).toBe(true);
    expect(operations.has('issues.set_labels')).toBe(true);
    expect(operations.has('docs.search')).toBe(true);
    expect(configuration.bindings.get('docs.search')?.kind).toBe('mcp');

    const roles = configuration.policy.roles.map((r) => r.id);
    expect(roles).toEqual(expect.arrayContaining(['content_manager', 'content_lead', 'integration_admin', 'auditor']));

    expect(configuration.rateLimits).toEqual({ mcpUserPerMinute: 200, mcpServiceAccountPerMinute: 500, unauthenticatedPerMinute: 30 });

    expect(configuration.serviceAccounts.size).toBe(1);
    expect([...configuration.serviceAccounts.values()][0]?.rateLimitPerMinute).toBe(1000);
  });
});
