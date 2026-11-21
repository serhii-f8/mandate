// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The AI Operations Layer Authors
import { describe, expect, it } from 'vitest';
import { loadConfigurationSources, type LoadedConfiguration } from '@aiops/config';
import type { UpstreamResolver } from '@aiops/connector-sdk';
import { assertFullyChecked, configurationLoadOptions } from './load-options.js';

const loaded = await loadConfigurationSources([{ file: 'c.yaml', text: 'version: 1\n' }]);
if (!loaded.ok) throw new Error(JSON.stringify(loaded.issues));
const CONFIG: LoadedConfiguration = loaded.configuration;

describe('CONN-2 the api always loads the configuration with spec and preset checks', () => {
  it('CONN-2 load options carry the adapter resolver and the preset directories', () => {
    const adapter = { resolver: { resolveSpec: () => Promise.resolve({ ok: true as const, catalog: [] }) } satisfies UpstreamResolver };
    expect(configurationLoadOptions(adapter, { presetDirs: ['/opt/presets'] })).toEqual({ resolver: adapter.resolver, presetDirs: ['/opt/presets'] });
  });

  it('CONN-2 accepts a fully checked configuration', () => {
    expect(() => {
      assertFullyChecked(CONFIG);
    }).not.toThrow();
  });

  it('CONN-2 refuses a configuration whose spec or preset checks were skipped', () => {
    expect(() => {
      assertFullyChecked({ ...CONFIG, specChecksSkipped: true });
    }).toThrow('configuration was loaded without spec checks');
    expect(() => {
      assertFullyChecked({ ...CONFIG, presetChecksSkipped: true });
    }).toThrow('configuration was loaded without preset checks');
  });
});
