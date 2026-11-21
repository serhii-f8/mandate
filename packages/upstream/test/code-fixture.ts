// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The AI Operations Layer Authors
/**
 * Loads the code fixture preset of `@aiops/testing` through the real loader, without a resolver
 * (HTTP `method`/`path` bindings bind). Each call copies the fixture into a new temporary preset
 * directory, so the process-wide code-import cache never sees a changed tree under one entry path.
 */
import { cp, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadConfigurationDirectory, type LoadedConfiguration } from '@aiops/config';
import { CODE_FIXTURE_PRESET_DIR } from '@aiops/testing';

/** The connection's settings; `max_concurrency` is the per-record writer's in-flight limit. */
export function fixtureConfig(maxConcurrency: number): string {
  return `version: 1
presets:
  - { id: fixture, package: "@aiops/code-fixture-preset" }
connections:
  - id: items
    adapter: openapi
    base_url: https://items.example.test/api
    credential_ref: items-token
    max_concurrency: ${String(maxConcurrency)}
    preset: fixture
roles:
  - id: integration_admin
    grants: []
    manage_credentials: [items-token]
role_mapping:
  - { group: admins, roles: [integration_admin] }
`;
}

/** The fixture loaded under a fresh copy; temporary directories are removed before it returns. */
export async function loadCodeFixture(maxConcurrency = 2): Promise<LoadedConfiguration> {
  const presets = await mkdtemp(join(tmpdir(), 'aiops-upstream-code-presets-'));
  const config = await mkdtemp(join(tmpdir(), 'aiops-upstream-code-config-'));
  try {
    await cp(CODE_FIXTURE_PRESET_DIR, join(presets, 'code-fixture'), { recursive: true });
    await writeFile(join(config, 'config.yaml'), fixtureConfig(maxConcurrency));
    const loaded = await loadConfigurationDirectory(config, { presetDirs: [presets] });
    if (!loaded.ok) throw new Error(`code fixture did not load: ${JSON.stringify(loaded.issues)}`);
    return loaded.configuration;
  } finally {
    await rm(presets, { recursive: true, force: true });
    await rm(config, { recursive: true, force: true });
  }
}
