// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Mandate Authors
/**
 * CONN-8: the Magento catalog preset's parameters. The scope attribute and the readable fields are
 * set per connection; without `preset_params` the preset behaves as 1.0.0 (the fixture
 * `operations-1.0.0.json` is the loaded configuration of the 1.0.0 preset).
 */
import { readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { createOpenApiAdapter } from '@mandate/adapters';
import { loadConfigurationSources, type HttpOperationBinding, type LoadedConfiguration } from '@mandate/config';
import { presetConnectionYaml } from '@mandate/testing';
import { PRESET_DIR } from '../src/index.js';

/** The seven content fields and status that catalog.update_content reads before and carries (the manifest). */
const MANIFEST_FIELDS = ['name', 'description', 'short_description', 'meta_title', 'meta_keyword', 'meta_description', 'url_key', 'status'];
const SCOPE_FIELD = 'searchCriteria[filter_groups][0][filters][0][field]';

async function load(presetParams?: string) {
  const yaml = presetConnectionYaml({
    presetId: 'magento-catalog',
    package: '@mandate/magento2-catalog',
    version: '1.1.0',
    connectionId: 'magento',
    baseUrl: 'http://127.0.0.1:1/rest/all',
    credentialRef: 'magento-token',
    ...(presetParams === undefined ? {} : { extra: `    preset_params: ${presetParams}` }),
  });
  return loadConfigurationSources([{ file: 'config.yaml', text: yaml }], {
    resolver: createOpenApiAdapter().resolver,
    presetDirs: [resolve(PRESET_DIR, '..')],
  });
}
async function loaded(presetParams?: string): Promise<LoadedConfiguration> {
  const result = await load(presetParams);
  if (!result.ok) throw new Error(`preset did not load: ${JSON.stringify(result.issues)}`);
  return result.configuration;
}
function http(config: LoadedConfiguration, operation: string): HttpOperationBinding {
  const binding = config.bindings.get(operation);
  if (binding?.kind !== 'http') throw new Error(`no HTTP binding for ${operation}`);
  return binding;
}
function manifestOf(config: LoadedConfiguration): unknown {
  return config.policy.operations.find((o) => o.id === 'catalog.update_content')?.manifest?.scopeArgs;
}
function fieldsEnum(config: LoadedConfiguration, operation: string): unknown {
  const op = config.policy.operations.find((o) => o.id === operation);
  const schema = op?.inputSchema as { properties?: { fields?: { items?: { enum?: unknown } } } } | undefined;
  return schema?.properties?.fields?.items?.enum;
}

describe('CONN-8 magento2-catalog parameters', () => {
  it('binds the scope attribute and the readable fields from preset_params', async () => {
    const readFields = ['sku', ...MANIFEST_FIELDS, 'manufacturer'];
    const config = await loaded(`{ scope_attribute: manufacturer, read_fields: [${readFields.join(', ')}] }`);
    for (const op of ['catalog.search_products', 'catalog.get_product', 'catalog.get_products_by_sku']) {
      expect(http(config, op).mapping.query[SCOPE_FIELD], op).toBe('manufacturer');
      expect(fieldsEnum(config, op), op).toEqual(readFields);
    }
    expect(manifestOf(config)).toEqual({ brand: 'manufacturer' });
  });

  it('without parameters the registered operations equal those of 1.0.0', async () => {
    const config = await loaded();
    const expected: unknown = JSON.parse(await readFile(join(PRESET_DIR, 'test', 'operations-1.0.0.json'), 'utf8'));
    const actual: unknown = JSON.parse(
      JSON.stringify({ policy: config.policy, bindings: [...config.bindings.entries()].sort(([a], [b]) => a.localeCompare(b)) }),
    );
    expect(actual).toEqual(expected);
  });

  it('read_fields must still cover the fields catalog.update_content reads and carries', async () => {
    const result = await load('{ read_fields: [sku, name, manufacturer] }');
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.issues.length).toBeGreaterThan(0);
    for (const issue of result.issues) {
      expect(issue.path).toBe('connections[0].preset_params');
      expect(issue.message).toContain('makes preset operation catalog.update_content invalid');
    }
  });

  it('the scope attribute must be listed in read_fields (the scope check reads it back)', async () => {
    const result = await load(`{ scope_attribute: manufacturer, read_fields: [sku, ${MANIFEST_FIELDS.join(', ')}] }`);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.issues).toHaveLength(1);
    expect(result.issues[0]?.path).toBe('connections[0].preset_params');
    expect(result.issues[0]?.message).toContain('manifest.scope_args.brand is not a field operation catalog.get_products_by_sku can return');
  });
});
