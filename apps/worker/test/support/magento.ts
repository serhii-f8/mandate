// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The AI Operations Layer Authors
/**
 * The Magento catalog preset 1.0.0 as the worker loads it (specs resolved, presets loaded), bound
 * to connection `magento` at a fake catalog's `/rest/all`, plus a memory credential vault holding a
 * fake bearer token. Shared by the writer unit test and the bulk-write integration test.
 */
import { resolve } from 'node:path';
import { createOpenApiAdapter } from '@aiops/adapters';
import { loadConfigurationSources, type LoadedConfiguration } from '@aiops/config';
import type { CredentialHandle, CredentialStatus, CredentialVault } from '@aiops/core';
import { PRESET_DIR } from '@aiops/magento2-catalog';

export const MAGENTO_BASE_PATH = '/rest/all';
export const MAGENTO_CREDENTIAL_REF = 'magento-token';

/**
 * Loads the preset bound to `baseUrl` (which ends in `/rest/all`). `extra` sources are loaded
 * with it, e.g. roles for the execution guard or an operation without a bulk binding.
 */
export async function loadMagentoPreset(
  baseUrl: string,
  extra: readonly { readonly file: string; readonly text: string }[] = [],
): Promise<LoadedConfiguration> {
  const connections = [
    'version: 1',
    'presets:',
    "  - { id: magento-catalog, package: '@aiops/magento2-catalog', version: '1.0.0' }",
    'connections:',
    '  - id: magento',
    '    adapter: openapi',
    `    base_url: ${baseUrl}`,
    `    credential_ref: ${MAGENTO_CREDENTIAL_REF}`,
    '    preset: magento-catalog',
    '    allow_private_network: true',
    '',
  ].join('\n');
  const result = await loadConfigurationSources([{ file: 'connections.yaml', text: connections }, ...extra], {
    resolver: createOpenApiAdapter().resolver,
    presetDirs: [resolve(PRESET_DIR, '..')],
  });
  if (!result.ok) throw new Error(`preset did not load: ${JSON.stringify(result.issues)}`);
  return result.configuration;
}

/** A credential vault in memory (fake tokens only). */
export class MemoryVault implements CredentialVault {
  private readonly rows = new Map<string, { scheme: string; secret: Readonly<Record<string, string>> }>();

  put(input: { ref: string; scheme: string; secret: Readonly<Record<string, string>>; actor: string }): Promise<{ keyVersion: number }> {
    this.rows.set(input.ref, { scheme: input.scheme, secret: input.secret });
    return Promise.resolve({ keyVersion: 1 });
  }

  describe(refs: readonly string[]): Promise<CredentialStatus[]> {
    return Promise.resolve(refs.map((ref) => ({ ref, set: this.rows.has(ref) })));
  }

  handle(ref: string): Promise<CredentialHandle | undefined> {
    const row = this.rows.get(ref);
    if (row === undefined) return Promise.resolve(undefined);
    return Promise.resolve({ ref, scheme: row.scheme, open: () => Promise.resolve(row.secret) });
  }
}

/** A memory vault with the fake bearer token stored under the preset connection's credential. */
export async function vaultWithToken(token: string): Promise<MemoryVault> {
  const vault = new MemoryVault();
  await vault.put({ ref: MAGENTO_CREDENTIAL_REF, scheme: 'bearer', secret: { token }, actor: 'test' });
  return vault;
}
