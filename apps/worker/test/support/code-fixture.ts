/**
 * The code fixture preset of `@aiops/testing` as the worker loads it (OPS-5, OPS-6): connection
 * `items` at a fake upstream served by `installFakeItems`, a fake bearer token, and the role
 * `editor` (group `editors`, no approval) granted `fixture.update`, `fixture.set_tags` and
 * `fixture.ping`. Each load copies the fixture into a new temporary preset directory, so the
 * process-wide code-import cache never sees a changed tree under one entry path.
 */
import { cp, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { UpstreamResolver } from '@aiops/connector-sdk';
import { loadConfigurationSources, type LoadedConfiguration } from '@aiops/config';
import { CODE_FIXTURE_PRESET_DIR } from '@aiops/testing';
import { MemoryVault } from './magento.js';

export const CODE_FIXTURE_GROUP = 'editors';
export const CODE_FIXTURE_CREDENTIAL_REF = 'items-token';

function sources(baseUrl: string, maxConcurrency: number): { file: string; text: string }[] {
  return [
    {
      file: 'connections.yaml',
      text: `version: 1
presets:
  - { id: fixture, package: "@aiops/code-fixture-preset" }
connections:
  - id: items
    adapter: openapi
    base_url: ${baseUrl}
    credential_ref: ${CODE_FIXTURE_CREDENTIAL_REF}
    max_concurrency: ${String(maxConcurrency)}
    preset: fixture
    allow_private_network: true
`,
    },
    {
      file: 'roles.yaml',
      text: `version: 1
roles:
  - id: editor
    grants:
      - operation: fixture.update
      - operation: fixture.set_tags
      - operation: fixture.ping
    approval: { required: never }
role_mapping:
  - group: ${CODE_FIXTURE_GROUP}
    roles: [editor]
`,
    },
  ];
}

/** The fixture bound to `baseUrl`; the temporary preset copy is removed before it returns. */
export async function loadCodeFixture(
  baseUrl: string,
  opts: { readonly maxConcurrency?: number; readonly resolver?: UpstreamResolver } = {},
): Promise<LoadedConfiguration> {
  const presets = await mkdtemp(join(tmpdir(), 'aiops-worker-code-presets-'));
  try {
    await cp(CODE_FIXTURE_PRESET_DIR, join(presets, 'code-fixture'), { recursive: true });
    const loaded = await loadConfigurationSources(sources(baseUrl, opts.maxConcurrency ?? 2), {
      presetDirs: [presets],
      ...(opts.resolver === undefined ? {} : { resolver: opts.resolver }),
    });
    if (!loaded.ok) throw new Error(`code fixture did not load: ${JSON.stringify(loaded.issues)}`);
    return loaded.configuration;
  } finally {
    await rm(presets, { recursive: true, force: true });
  }
}

/** A memory vault holding the fake bearer token of connection `items`. */
export async function codeFixtureVault(token: string): Promise<MemoryVault> {
  const vault = new MemoryVault();
  await vault.put({ ref: CODE_FIXTURE_CREDENTIAL_REF, scheme: 'bearer', secret: { token }, actor: 'test' });
  return vault;
}
