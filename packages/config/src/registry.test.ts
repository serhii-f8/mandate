import { cp, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { FakeResolver, fakeCatalogEntry } from '@aiops/testing';
import { formatIssue, type ConfigIssue } from './issues.js';
import { loadConfigurationDirectory, loadConfigurationSources, type LoadedConfiguration, type LoadOptions, type LoadResult } from './load.js';

const FIXTURES = fileURLToPath(new URL('../test/fixtures', import.meta.url));
const PRESET_DIRS = [join(FIXTURES, 'preset-dir')];

function shopCatalog() {
  return [
    fakeCatalogEntry('shop', { operationId: 'listItems', method: 'GET', path: '/items', query: ['brand'], summary: 'List items' }),
    fakeCatalogEntry('shop', { operationId: 'getItem', method: 'GET', path: '/items/{sku}' }),
    fakeCatalogEntry('shop', { operationId: 'deleteItem', method: 'DELETE', path: '/items/{sku}' }),
  ];
}

const resolver = (): FakeResolver => new FakeResolver({ shop: shopCatalog() });

const dirs: string[] = [];
afterEach(async () => {
  await Promise.all(dirs.splice(0).map((d) => rm(d, { recursive: true, force: true })));
});

/** Copies a fixture directory to a temporary one, then writes (or with `null` deletes) files. */
async function fixture(name: string, files: Record<string, string | null> = {}): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'aiops-registry-'));
  dirs.push(dir);
  await cp(join(FIXTURES, name), dir, { recursive: true });
  for (const [file, text] of Object.entries(files)) {
    if (text === null) await rm(join(dir, file));
    else await writeFile(join(dir, file), text);
  }
  return dir;
}

/** A copy of the preset directory, so a test can change the preset. */
async function presetDir(files: Record<string, string | null> = {}): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'aiops-presets-'));
  dirs.push(dir);
  await cp(join(FIXTURES, 'preset-dir'), dir, { recursive: true });
  for (const [file, text] of Object.entries(files)) {
    if (text === null) await rm(join(dir, 'fake-preset', file));
    else await writeFile(join(dir, 'fake-preset', file), text);
  }
  return dir;
}

function ok(result: LoadResult): LoadedConfiguration {
  if (!result.ok) throw new Error(result.issues.map(formatIssue).join('\n'));
  return result.configuration;
}

function issues(result: LoadResult): readonly ConfigIssue[] {
  if (result.ok) throw new Error('expected issues');
  return result.issues;
}

const BASE = `version: 1
connections:
  - id: shop
    adapter: openapi
    base_url: https://shop.example.test/api
    credential_ref: shop-token
    auth: { scheme: bearer }
`;
const SEARCH = `version: 1
operations:
  - id: shop.search
    connection: shop
    risk: read
    description: Search.
    upstream:
      method: GET
      path: /items
      query: { q: { arg: q }, "searchCriteria[pageSize]": { arg: page_size, default: 20 }, fixed: literal }
      response: { items: items, total: total_count, fields_from_arg: fields }
    input_schema:
      type: object
      properties: { q: { type: string }, page_size: { type: integer }, fields: { type: array, items: { type: string } } }
      required: [fields]
    fields_arg: fields
`;

function sources(files: Record<string, string>, options: LoadOptions = {}): Promise<LoadResult> {
  return loadConfigurationSources(
    Object.entries({ 'base.yaml': BASE, 'search.yaml': SEARCH, ...files }).map(([file, text]) => ({ file, text })),
    options,
  );
}

describe('OPS-1 operations are enabled only by configuration or an applied preset', () => {
  it('enables the operations of a preset bound to a connection, with the preset as source', async () => {
    const config = ok(await loadConfigurationDirectory(join(FIXTURES, 'with-preset'), { resolver: resolver(), presetDirs: PRESET_DIRS }));
    expect(config.policy.operations.map((o) => [o.id, o.source, o.connection, o.toolName])).toEqual([
      ['fake.search_items', 'preset:fake', 'shop', 'fake.search_items'],
      ['fake.get_item', 'preset:fake', 'shop', 'fake.get_item'],
    ]);
    expect(config.bindings.get('fake.get_item')).toEqual({
      connection: 'shop',
      mapping: { operation: 'getItem', method: 'GET', path: '/items/{sku}', pathParams: { sku: { arg: 'sku' } }, query: {}, headers: {}, response: { maxItems: 100 } },
    });
    expect(config.bindings.get('fake.search_items')?.mapping).toMatchObject({
      method: 'GET',
      path: '/items',
      query: { brand: { arg: 'brand' } },
      response: { items: 'items', total: 'total', fieldsFromArg: 'fields', maxItems: 100 },
    });
    expect(config.specChecksSkipped).toBe(false);
  });

  it('registers catalog entries that no operation references as disabled, never as operations', async () => {
    const config = ok(await loadConfigurationDirectory(join(FIXTURES, 'with-preset'), { resolver: resolver(), presetDirs: PRESET_DIRS }));
    expect(config.disabled).toEqual([{ key: 'shop:deleteItem', connection: 'shop', method: 'DELETE', path: '/items/{sku}', operationId: 'deleteItem' }]);
    expect(config.policy.operations.map((o) => o.id)).not.toContain('shop:deleteItem');
  });

  it('skips preset loading without preset directories, without reporting preset operations as undefined', async () => {
    const config = ok(await loadConfigurationDirectory(join(FIXTURES, 'with-preset'), { resolver: resolver() }));
    expect(config.presetChecksSkipped).toBe(true);
    expect(config.policy.operations).toEqual([]);
    expect(config.credentialRefs.has('shop-token')).toBe(false);
    const full = ok(await loadConfigurationDirectory(join(FIXTURES, 'with-preset'), { resolver: resolver(), presetDirs: PRESET_DIRS }));
    expect(full.presetChecksSkipped).toBe(false);
  });

  it('does not enable the operations of a preset that no connection binds', async () => {
    const dir = await fixture('with-preset', {
      'config.yaml': `version: 1
presets:
  - { id: fake, package: "@aiops/fake-preset" }
connections:
  - { id: shop, adapter: openapi, base_url: https://shop.example.test/api }
`,
    });
    const config = ok(await loadConfigurationDirectory(dir, { resolver: resolver(), presetDirs: PRESET_DIRS }));
    expect(config.policy.operations).toEqual([]);
  });

  it('removes an operation disabled by an override and lists it as disabled', async () => {
    const dir = await fixture('with-preset', { 'overrides.yaml': 'version: 1\noverrides:\n  - { operation: fake.get_item, enabled: false }\n' });
    const config = ok(await loadConfigurationDirectory(dir, { resolver: resolver(), presetDirs: PRESET_DIRS }));
    expect(config.policy.operations.map((o) => o.id)).toEqual(['fake.search_items']);
    expect(config.bindings.has('fake.get_item')).toBe(false);
    expect(config.disabled).toEqual([
      { key: 'fake.get_item', connection: 'shop', method: 'GET', path: '/items/{sku}', operationId: 'getItem' },
      { key: 'shop:deleteItem', connection: 'shop', method: 'DELETE', path: '/items/{sku}', operationId: 'deleteItem' },
    ]);
  });

  it('lists an operation disabled while its spec is unresolved with an unknown method and path', async () => {
    const dir = await fixture('derived', { 'overrides.yaml': 'version: 1\noverrides:\n  - { operation: shop.get_item, enabled: false }\n' });
    const config = ok(await loadConfigurationDirectory(dir));
    expect(config.disabled).toEqual([{ key: 'shop.get_item', connection: 'shop', method: 'unknown', path: 'unknown' }]);
  });
});

describe('MCP-9 tool names and descriptions can be overridden', () => {
  it('applies tool name, title and description; grants keep the operation ID', async () => {
    const dir = await fixture('with-preset', {
      'overrides.yaml': `version: 1
overrides:
  - operation: fake.search_items
    tool_name: catalog.find_items
    title: Find items
    description: Find items of your brand.
`,
    });
    const config = ok(await loadConfigurationDirectory(dir, { resolver: resolver(), presetDirs: PRESET_DIRS }));
    expect(config.policy.operations[0]).toMatchObject({
      id: 'fake.search_items',
      toolName: 'catalog.find_items',
      title: 'Find items',
      description: 'Find items of your brand.',
    });
    expect(config.policy.roles[0]?.grants[0]?.operation).toBe('fake.search_items');
  });

  it('rejects a tool name another enabled operation already has', async () => {
    const dir = await fixture('with-preset', { 'overrides.yaml': 'version: 1\noverrides:\n  - { operation: fake.get_item, tool_name: fake.search_items }\n' });
    const found = issues(await loadConfigurationDirectory(dir, { resolver: resolver(), presetDirs: PRESET_DIRS }));
    expect(found).toEqual([expect.objectContaining({ file: 'overrides.yaml', path: 'overrides[0].tool_name', line: 3 })]);
    expect(found[0]?.message).toMatch(/duplicate tool name/);
  });

  it('rejects a tool name reserved for a built-in tool', async () => {
    const dir = await fixture('with-preset', { 'overrides.yaml': 'version: 1\noverrides:\n  - { operation: fake.get_item, tool_name: ping }\n' });
    const found = issues(await loadConfigurationDirectory(dir, { resolver: resolver(), presetDirs: PRESET_DIRS }));
    expect(found).toEqual([expect.objectContaining({ path: 'overrides[0].tool_name', message: 'is reserved for a built-in tool' })]);
  });

  it('rejects an override of an unknown operation, a duplicate override and an invalid tool name', async () => {
    const found = issues(
      await sources({
        'overrides.yaml': `version: 1
overrides:
  - { operation: shop.nope, title: Nope }
  - { operation: shop.search, title: One }
  - { operation: shop.search, title: Two }
`,
      }),
    );
    expect(found.map((i) => i.path)).toEqual(['overrides[0].operation', 'overrides[2].operation']);
    const invalid = issues(await sources({ 'overrides.yaml': 'version: 1\noverrides:\n  - { operation: shop.search, tool_name: Not A Name }\n' }));
    expect(invalid).toEqual([expect.objectContaining({ path: 'overrides[0].tool_name', message: 'has an invalid format' })]);
  });
});

describe('CONN-2 derived input schema from the spec', () => {
  it('gives an operation without input_schema the derived schema, a compiled validator and the default mapping', async () => {
    const fake = resolver();
    const dir = join(FIXTURES, 'derived');
    const config = ok(await loadConfigurationDirectory(dir, { resolver: fake }));
    const get = config.policy.operations.find((o) => o.id === 'shop.get_item');
    expect(get?.inputSchema).toEqual(shopCatalog()[1]?.inputSchema);
    const validate = config.validators.get('shop.get_item');
    expect(validate?.({ sku: 'A-1' })).toEqual({ ok: true });
    expect(validate?.({})).toMatchObject({ ok: false });
    expect(config.bindings.get('shop.get_item')?.mapping).toEqual({ ...shopCatalog()[1]?.defaultMapping, operation: 'getItem' });
    expect(config.bindings.get('shop.list_items')?.mapping.response).toEqual({ items: 'items', maxItems: 100 });
    expect(config.disabled.map((d) => d.key)).toEqual(['shop:deleteItem']);

    expect(fake.calls).toHaveLength(1);
    expect(fake.calls[0]?.spec).toEqual({ file: join(dir, 'specs', 'shop.json') });
    expect(fake.calls[0]?.include).toEqual(['listItems', 'getItem', 'deleteItem']);
    expect(config.connectionSettings.get('shop')).toEqual({
      id: 'shop',
      baseUrl: 'https://shop.example.test/api',
      timeoutMs: 10_000,
      retry: { maxAttempts: 3, initialBackoffMs: 200 },
      maxConcurrency: 4,
      allowPrivateNetwork: false,
      extraHosts: [],
    });
  });

  it('keeps a placeholder schema and reports skipped spec checks without a resolver', async () => {
    const config = ok(await loadConfigurationDirectory(join(FIXTURES, 'derived')));
    expect(config.specChecksSkipped).toBe(true);
    expect(config.policy.operations.find((o) => o.id === 'shop.get_item')?.inputSchema).toEqual({ type: 'object', additionalProperties: false });
    expect(config.bindings.has('shop.get_item')).toBe(false);
  });

  it('binds method and path mappings without a resolver and converts connection settings', async () => {
    const config = ok(
      await sources({
        'base.yaml': `version: 1
connections:
  - id: shop
    adapter: openapi
    base_url: https://shop.example.test/api
    credential_ref: shop-oauth
    auth: { scheme: oauth_client_credentials, token_url: https://idp.example.test/token, scopes: [read] }
    openapi: { spec: https://specs.example.test/shop.json }
    timeout_ms: 5000
    retry: { max_attempts: 2, initial_backoff_ms: 50 }
    max_concurrency: 8
    allow_private_network: true
`,
      }),
    );
    expect(config.specChecksSkipped).toBe(true);
    expect(config.bindings.get('shop.search')).toEqual({
      connection: 'shop',
      mapping: {
        method: 'GET',
        path: '/items',
        pathParams: {},
        query: { q: { arg: 'q' }, 'searchCriteria[pageSize]': { arg: 'page_size', default: 20 }, fixed: 'literal' },
        headers: {},
        response: { items: 'items', total: 'total_count', fieldsFromArg: 'fields', maxItems: 100 },
      },
    });
    expect(config.connectionSettings.get('shop')).toEqual({
      id: 'shop',
      baseUrl: 'https://shop.example.test/api',
      auth: { scheme: 'oauth_client_credentials', tokenUrl: 'https://idp.example.test/token', scopes: ['read'] },
      credentialRef: 'shop-oauth',
      timeoutMs: 5000,
      retry: { maxAttempts: 2, initialBackoffMs: 50 },
      maxConcurrency: 8,
      allowPrivateNetwork: true,
      extraHosts: ['specs.example.test'],
    });
    expect(config.credentialRefs.get('shop-oauth')).toEqual({ scheme: 'oauth_client_credentials', connections: ['shop'] });
  });

  it('covers spec files in the hash', async () => {
    const dir = await fixture('derived');
    const before = ok(await loadConfigurationDirectory(dir, { resolver: resolver() })).hash;
    expect(ok(await loadConfigurationDirectory(join(FIXTURES, 'derived'), { resolver: resolver() })).hash).toBe(before);
    await writeFile(join(dir, 'specs', 'shop.json'), '{"openapi":"3.0.3","info":{"title":"x","version":"2"},"paths":{}}');
    const after = ok(await loadConfigurationDirectory(dir, { resolver: resolver() })).hash;
    expect(after).not.toBe(before);
  });

  it('covers preset files in the hash', async () => {
    const presets = await presetDir();
    const before = ok(await loadConfigurationDirectory(join(FIXTURES, 'with-preset'), { resolver: resolver(), presetDirs: [presets] })).hash;
    await writeFile(join(presets, 'fake-preset', 'spec.json'), '{}');
    const after = ok(await loadConfigurationDirectory(join(FIXTURES, 'with-preset'), { resolver: resolver(), presetDirs: [presets] })).hash;
    expect(after).not.toBe(before);
  });
});

describe('CFG-2 upstream and preset issues are located', () => {
  it('reports an upstream.operation the spec does not have', async () => {
    const dir = await fixture('derived', {
      'config.yaml': (await readFile(join(FIXTURES, 'derived', 'config.yaml'), 'utf8')).replace(
        'operation: getItem',
        'operation: getNothing',
      ),
    });
    const found = issues(await loadConfigurationDirectory(dir, { resolver: resolver() }));
    expect(found).toEqual([expect.objectContaining({ file: 'config.yaml', path: 'operations[1].upstream.operation', line: 17 })]);
    expect(found[0]?.message).toBe("is not an operation of the connection's spec");
  });

  it('reports a template argument that is not in input_schema', async () => {
    const found = issues(await sources({ 'search.yaml': SEARCH.replace('q: { arg: q }', 'q: { arg: query }') }));
    expect(found).toEqual([expect.objectContaining({ file: 'search.yaml', path: 'operations[0].upstream.query.q', message: 'names an argument that is not in input_schema' })]);
  });

  it('reports a path placeholder without a path_params entry, and a path_params entry without a placeholder', async () => {
    const found = issues(await sources({ 'search.yaml': SEARCH.replace('path: /items', 'path: /items/{sku}\n      path_params: { id: { arg: q } }') }));
    expect(found.map((i) => [i.path, i.message])).toEqual([
      ['operations[0].upstream.path', 'placeholder {sku} has no path_params entry'],
      ['operations[0].upstream.path_params.id', 'is not a placeholder in path'],
    ]);
  });

  it('reports a fields_from_arg that is not an argument', async () => {
    const found = issues(await sources({ 'search.yaml': SEARCH.replace('fields_from_arg: fields', 'fields_from_arg: columns') }));
    expect(found).toContainEqual(
      expect.objectContaining({ path: 'operations[0].upstream.response.fields_from_arg', message: 'names an argument that is not in input_schema' }),
    );
  });

  it('requires input_schema for method and path, and for explicit templates', async () => {
    const noSchema = SEARCH.replace(/ {4}input_schema:[\s\S]*$/, '');
    const found = issues(await sources({ 'search.yaml': noSchema }));
    expect(found.map((i) => [i.path, i.message])).toContainEqual(['operations[0].input_schema', 'is required for an operation with method and path']);

    const dir = await fixture('derived', {
      'config.yaml': `version: 1
connections:
  - { id: shop, adapter: openapi, base_url: https://shop.example.test/api, openapi: { spec: specs/shop.json } }
operations:
  - { id: shop.get_item, connection: shop, risk: read, description: Get., upstream: { operation: getItem, path_params: { sku: { arg: sku } } } }
`,
    });
    const derived = issues(await loadConfigurationDirectory(dir, { resolver: resolver() }));
    expect(derived).toEqual([expect.objectContaining({ path: 'operations[0].input_schema', message: 'is required when upstream declares templates' })]);
  });

  it('requires exactly one of operation or method and path, and refuses the host header', async () => {
    const both = issues(await sources({ 'search.yaml': SEARCH.replace('method: GET', 'operation: listItems\n      method: GET') }));
    expect(both).toContainEqual(expect.objectContaining({ path: 'operations[0].upstream.operation', message: 'give either operation or method and path, not both' }));
    const neither = issues(await sources({ 'search.yaml': SEARCH.replace('      method: GET\n      path: /items\n', '') }));
    expect(neither).toContainEqual(expect.objectContaining({ path: 'operations[0].upstream.method' }));
    const host = issues(await sources({ 'search.yaml': SEARCH.replace('      path: /items\n', '      path: /items\n      headers: { Host: evil.example.test }\n') }));
    expect(host).toEqual([expect.objectContaining({ path: 'operations[0].upstream.headers.Host', message: 'is set by the platform' })]);
  });

  it('reports upstream.operation on a connection without a spec', async () => {
    const found = issues(await sources({ 'search.yaml': SEARCH.replace('      method: GET\n      path: /items\n', '      operation: listItems\n') }));
    expect(found).toEqual([expect.objectContaining({ path: 'operations[0].upstream.operation', message: 'the connection has no OpenAPI spec' })]);
  });

  it('reports a missing spec file at the connection', async () => {
    const dir = await fixture('derived', { 'specs/shop.json': null });
    const found = issues(await loadConfigurationDirectory(dir, { resolver: resolver() }));
    expect(found).toEqual([{ file: 'config.yaml', path: 'connections[0].openapi.spec', line: 6, column: 16, message: 'spec file cannot be read' }]);
  });

  it('locates resolver issues at the connection that declares the spec', async () => {
    const failing = new FakeResolver({}, { shop: [{ path: ['openapi', 'spec', 'paths', '/items', 'get'], message: 'is not a valid operation' }] });
    const found = issues(await loadConfigurationDirectory(join(FIXTURES, 'derived'), { resolver: failing }));
    expect(found).toEqual([expect.objectContaining({ file: 'config.yaml', path: 'connections[0].openapi.spec.paths./items.get', line: 6, message: 'is not a valid operation' })]);
    const include = issues(await loadConfigurationDirectory(join(FIXTURES, 'derived'), { resolver: new FakeResolver({ shop: shopCatalog().slice(0, 2) }) }));
    expect(include).toEqual([expect.objectContaining({ path: 'connections[0].openapi.include[2]', message: 'matches no operation in the spec' })]);
  });

  it('reports a preset file issue with the package name as file', async () => {
    const text = (await readFile(join(FIXTURES, 'preset-dir', 'fake-preset', 'preset.yaml'), 'utf8')).replace('version: 1', 'version: 2');
    const presets = await presetDir({ 'preset.yaml': text });
    const found = issues(await loadConfigurationDirectory(join(FIXTURES, 'with-preset'), { resolver: resolver(), presetDirs: [presets] }));
    expect(found).toEqual([expect.objectContaining({ file: '@aiops/fake-preset/preset.yaml', path: 'version', line: 1, column: 1 })]);
  });

  it('reports a package version mismatch, a missing package and a missing preset spec', async () => {
    const mismatch = await fixture('with-preset');
    await writeFile(
      join(mismatch, 'config.yaml'),
      (await readFile(join(mismatch, 'config.yaml'), 'utf8')).replace('version: "0.1.0"', 'version: "0.2.0"'),
    );
    expect(issues(await loadConfigurationDirectory(mismatch, { resolver: resolver(), presetDirs: PRESET_DIRS }))).toEqual([
      expect.objectContaining({ file: 'config.yaml', path: 'presets[0].version', message: 'does not match the installed package version' }),
    ]);
    expect(issues(await loadConfigurationDirectory(join(FIXTURES, 'with-preset'), { resolver: resolver(), presetDirs: [] }))).toEqual([
      expect.objectContaining({ file: 'config.yaml', path: 'presets[0].package', message: 'is not installed in the preset directories' }),
    ]);
    const noSpec = await presetDir({ 'spec.json': null });
    expect(issues(await loadConfigurationDirectory(join(FIXTURES, 'with-preset'), { resolver: resolver(), presetDirs: [noSpec] }))).toEqual([
      expect.objectContaining({ file: '@aiops/fake-preset/preset.yaml', path: 'spec', line: 2, message: 'spec file cannot be read' }),
    ]);
  });

  it('refuses a preset spec path outside the preset directory', async () => {
    const text = (await readFile(join(FIXTURES, 'preset-dir', 'fake-preset', 'preset.yaml'), 'utf8')).replace('spec: spec.json', 'spec: ../../etc/passwd.json');
    const presets = await presetDir({ 'preset.yaml': text });
    const found = issues(await loadConfigurationDirectory(join(FIXTURES, 'with-preset'), { resolver: resolver(), presetDirs: [presets] }));
    expect(found).toEqual([expect.objectContaining({ file: '@aiops/fake-preset/preset.yaml', path: 'spec', message: 'must be a path inside the preset' })]);
  });

  it('refuses a preset bound to a connection that is not openapi', async () => {
    const dir = await fixture('with-preset', {
      'config.yaml': `version: 1
presets:
  - { id: fake, package: "@aiops/fake-preset" }
connections:
  - { id: shop, adapter: mcp, mcp_url: https://shop.example.test/mcp, preset: fake }
`,
    });
    const found = issues(await loadConfigurationDirectory(dir, { resolver: resolver(), presetDirs: PRESET_DIRS }));
    expect(found).toEqual([expect.objectContaining({ path: 'connections[0].preset', message: 'preset requires an openapi connection' })]);
  });

  it('refuses a preset spec that is a symbolic link out of the preset directory', async () => {
    const presets = await presetDir({ 'spec.json': null });
    await symlink(join(FIXTURES, 'derived', 'specs', 'shop.json'), join(presets, 'fake-preset', 'spec.json'));
    const found = issues(await loadConfigurationDirectory(join(FIXTURES, 'with-preset'), { resolver: resolver(), presetDirs: [presets] }));
    expect(found).toEqual([expect.objectContaining({ file: '@aiops/fake-preset/preset.yaml', path: 'spec', message: 'must be a path inside the preset' })]);
  });

  it('accepts a preset spec whose name starts with two dots', async () => {
    const text = (await readFile(join(FIXTURES, 'preset-dir', 'fake-preset', 'preset.yaml'), 'utf8')).replace('spec: spec.json', 'spec: ..spec.json');
    const presets = await presetDir({ 'preset.yaml': text, '..spec.json': await readFile(join(FIXTURES, 'preset-dir', 'fake-preset', 'spec.json'), 'utf8') });
    ok(await loadConfigurationDirectory(join(FIXTURES, 'with-preset'), { resolver: resolver(), presetDirs: [presets] }));
  });

  it('refuses a preset bound to two connections', async () => {
    const dir = await fixture('with-preset', {
      'second.yaml': 'version: 1\nconnections:\n  - { id: shop2, adapter: openapi, base_url: https://shop.example.test/api, credential_ref: shop-token, preset: fake }\n',
    });
    const found = issues(await loadConfigurationDirectory(dir, { resolver: resolver(), presetDirs: PRESET_DIRS }));
    expect(found).toContainEqual(expect.objectContaining({ file: 'second.yaml', path: 'connections[0].preset', message: 'the preset is already bound to connection shop' }));
  });

  it('checks the connection test operation', async () => {
    const withTest = (test: string, extraOps = ''): Record<string, string> => ({
      'base.yaml': `${BASE}    test: ${test}\n`,
      'other.yaml': `version: 1
connections:
  - { id: other, adapter: openapi, base_url: https://other.example.test }
operations:
  - { id: other.read, connection: other, risk: read, description: R., upstream: { method: GET, path: /x }, input_schema: { type: object } }
  - { id: shop.write, connection: shop, risk: write_opaque, description: W., upstream: { method: POST, path: /x }, input_schema: { type: object } }
${extraOps}`,
    });
    const okConfig = ok(await sources(withTest('{ operation: shop.search, args: { fields: [sku] } }')));
    expect(okConfig.connectionTests.get('shop')).toEqual({ operation: 'shop.search', args: { fields: ['sku'] } });
    const cases: [string, string][] = [
      ['{ operation: shop.nope }', 'names an operation that is not defined'],
      ['{ operation: shop.write }', 'must be a read operation'],
      ['{ operation: other.read }', 'must be an operation of this connection'],
      ['{ operation: shop.search, args: { fields: 3 } }', "args do not match the operation's input_schema"],
    ];
    for (const [test, message] of cases) {
      const found = issues(await sources(withTest(test)));
      expect(found).toEqual([expect.objectContaining({ file: 'base.yaml', message })]);
      expect(found[0]?.path).toMatch(/^connections\[0\]\.test\./);
    }
  });

  it('uses the preset test when the connection has none', async () => {
    const config = ok(await loadConfigurationDirectory(join(FIXTURES, 'with-preset'), { resolver: resolver(), presetDirs: PRESET_DIRS }));
    expect(config.connectionTests.get('shop')).toEqual({ operation: 'fake.search_items', args: { brand: 'acme', fields: ['sku'] } });
  });

  it('checks auth and credential references', async () => {
    const noAuth = issues(await sources({ 'base.yaml': BASE.replace('    auth: { scheme: bearer }\n', '') }));
    expect(noAuth).toEqual([expect.objectContaining({ path: 'connections[0].credential_ref', message: 'credential_ref requires auth' })]);
    const noRef = issues(await sources({ 'base.yaml': BASE.replace('    credential_ref: shop-token\n', '') }));
    expect(noRef).toEqual([expect.objectContaining({ path: 'connections[0].credential_ref', message: 'is required when auth is set' })]);
    const twoSchemes = issues(
      await sources({
        'more.yaml': 'version: 1\nconnections:\n  - { id: shop2, adapter: openapi, base_url: https://x.example.test, credential_ref: shop-token, auth: { scheme: basic } }\n',
      }),
    );
    expect(twoSchemes).toEqual([
      expect.objectContaining({ file: 'more.yaml', path: 'connections[0].credential_ref', message: 'is used with another auth scheme by connection shop' }),
    ]);
    const shared = ok(
      await sources({
        'more.yaml': 'version: 1\nconnections:\n  - { id: shop2, adapter: openapi, base_url: https://x.example.test, credential_ref: shop-token, auth: { scheme: bearer } }\n',
      }),
    );
    expect(shared.credentialRefs.get('shop-token')).toEqual({ scheme: 'bearer', connections: ['shop', 'shop2'] });
  });

  it('takes the credential scheme from the preset auth default', async () => {
    const config = ok(await loadConfigurationDirectory(join(FIXTURES, 'with-preset'), { resolver: resolver(), presetDirs: PRESET_DIRS }));
    expect(config.credentialRefs.get('shop-token')).toEqual({ scheme: 'bearer', connections: ['shop'] });
    expect(config.connectionSettings.get('shop')?.auth).toEqual({ scheme: 'bearer' });
  });
});

describe('POL-3 field rules and projection use the same argument', () => {
  it('POL-3 reports fields_arg when response.fields_from_arg names another argument', async () => {
    const text = SEARCH.replace('fields_from_arg: fields', 'fields_from_arg: q');
    const found = issues(await sources({ 'search.yaml': text }));
    expect(found).toContainEqual(
      expect.objectContaining({ path: 'operations[0].fields_arg', message: 'must equal upstream.response.fields_from_arg, so the response is projected by the same argument' }),
    );
  });

  it('POL-3 reports fields_arg when the mapping projects nothing', async () => {
    const found = issues(await sources({ 'search.yaml': SEARCH.replace(', fields_from_arg: fields', '') }));
    expect(found).toEqual([
      expect.objectContaining({ path: 'operations[0].fields_arg', message: 'must equal upstream.response.fields_from_arg, so the response is projected by the same argument' }),
    ]);
  });

  it('POL-3 reports fields_from_arg without fields_arg', async () => {
    const found = issues(await sources({ 'search.yaml': SEARCH.replace('    fields_arg: fields\n', '') }));
    expect(found).toEqual([
      expect.objectContaining({ path: 'operations[0].upstream.response.fields_from_arg', message: 'requires fields_arg naming the same argument' }),
    ]);
  });

  it('POL-3 reports fields_arg on a derived operation with the default mapping', async () => {
    const dir = await fixture('derived', {
      'config.yaml': (await readFile(join(FIXTURES, 'derived', 'config.yaml'), 'utf8')).replace(
        '    upstream: { operation: getItem }',
        '    upstream: { operation: getItem }\n    fields_arg: sku',
      ),
    });
    const found = issues(await loadConfigurationDirectory(dir, { resolver: resolver() }));
    expect(found).toEqual([
      expect.objectContaining({ path: 'operations[1].fields_arg', message: 'must equal upstream.response.fields_from_arg, so the response is projected by the same argument' }),
    ]);
  });
});

describe('OPS-6 bulk bindings', () => {
  it('OPS-6 a bulk binding is allowed on a destructive operation', async () => {
    const BULK = `version: 1
operations:
  - id: shop.retire_items
    connection: shop
    risk: destructive
    description: Retire items.
    upstream:
      method: POST
      path: /async/bulk/items
      bulk:
        body: { wrap: item }
        batch_id: bulk_uuid
        status: { method: GET, path: '/bulk/{batch_id}/status', items: ops, index: id, state: status, states: { ok: [1], retriable: [2], failed: [3], open: [4] } }
    input_schema: { type: object, properties: { skus: { type: array, items: { type: string } } } }
`;
    const result = await sources({ 'retire.yaml': BULK });
    expect(result.ok, JSON.stringify(result.ok ? [] : result.issues)).toBe(true);
  });
});

describe('MCP-4 read operations use GET; writes need change-sets', () => {
  const MESSAGE = 'read operations must use GET; writes need change-sets';

  it('MCP-4 reports a configured read operation with another method', async () => {
    const found = issues(await sources({ 'search.yaml': SEARCH.replace('method: GET', 'method: POST') }));
    expect(found).toEqual([expect.objectContaining({ path: 'operations[0].risk', message: MESSAGE })]);
  });

  it('MCP-4 reports a derived read operation whose spec method is not GET', async () => {
    const dir = await fixture('derived', {
      'config.yaml': (await readFile(join(FIXTURES, 'derived', 'config.yaml'), 'utf8')).replace('operation: getItem', 'operation: deleteItem'),
    });
    const found = issues(await loadConfigurationDirectory(dir, { resolver: resolver() }));
    expect(found).toEqual([expect.objectContaining({ path: 'operations[1].risk', message: MESSAGE })]);
  });

  it('MCP-4 reports a preset read operation whose spec method is not GET', async () => {
    const text = (await readFile(join(FIXTURES, 'preset-dir', 'fake-preset', 'preset.yaml'), 'utf8')).replace('operation: getItem', 'operation: deleteItem');
    const presets = await presetDir({ 'preset.yaml': text });
    const found = issues(await loadConfigurationDirectory(join(FIXTURES, 'with-preset'), { resolver: resolver(), presetDirs: [presets] }));
    expect(found).toEqual([expect.objectContaining({ file: '@aiops/fake-preset/preset.yaml', path: 'operations[1].risk', message: MESSAGE })]);
  });
});

describe('POL-2 scope arguments are sent upstream', () => {
  const ROLE = `version: 1
roles:
  - id: viewer
    grants:
      - { operation: shop.search, scope: { page_size: [10] } }
`;

  it('POL-2 accepts a scope on an argument a template sends', async () => {
    ok(await sources({ 'roles.yaml': ROLE }));
  });

  it('POL-2 reports a scope argument no template of the mapping references', async () => {
    const text = SEARCH.replace('page_size: { type: integer }', 'page_size: { type: integer }, region: { type: string }');
    const found = issues(await sources({ 'search.yaml': text, 'roles.yaml': ROLE.replace('page_size: [10]', 'region: [eu]') }));
    expect(found).toEqual([
      expect.objectContaining({ file: 'roles.yaml', path: 'roles[0].grants[0].scope.region', message: 'scope argument region is not sent upstream by operation shop.search' }),
    ]);
  });

  it('POL-2 accepts any scope argument of a derived operation (the default mapping sends every parameter)', async () => {
    const dir = await fixture('derived', {
      'config.yaml': (await readFile(join(FIXTURES, 'derived', 'config.yaml'), 'utf8')) + 'roles:\n  - { id: viewer, grants: [{ operation: shop.get_item, scope: { sku: [A-1] } }] }\n',
    });
    ok(await loadConfigurationDirectory(dir, { resolver: resolver() }));
  });
});

describe('CFG-5 credentials stay out of configuration', () => {
  it('rejects secret material in auth and never echoes it', async () => {
    const found = issues(await sources({ 'base.yaml': BASE.replace('auth: { scheme: bearer }', 'auth: { scheme: bearer, token: hunter2-value }') }));
    expect(found).toContainEqual(expect.objectContaining({ path: 'connections[0].auth.token', message: 'secrets never appear in configuration; reference a credential by name' }));
    expect(found).toContainEqual(expect.objectContaining({ path: 'connections[0].auth', message: 'unknown key: token' }));
    expect(found.map(formatIssue).join('\n')).not.toContain('hunter2-value');
  });

  it('accepts token_url and manage_credentials, which name no secret', async () => {
    const result = await sources({
      'base.yaml': BASE.replace('auth: { scheme: bearer }', 'auth: { scheme: oauth_client_credentials, token_url: https://idp.example.test/token }'),
      'roles.yaml': 'version: 1\nroles:\n  - { id: admin, grants: [], manage_credentials: [shop-token] }\n',
    });
    expect(result.ok).toBe(true);
  });

  it('scans connection test argument values, not argument names', async () => {
    const op = SEARCH.replace('properties: { q: { type: string }', 'properties: { page_token: { type: string }, q: { type: string }');
    const accepted = await sources({ 'base.yaml': `${BASE}    test: { operation: shop.search, args: { page_token: abc, fields: [sku] } }\n`, 'search.yaml': op });
    expect(accepted.ok).toBe(true);
    const nested = issues(await sources({ 'base.yaml': `${BASE}    test: { operation: shop.search, args: { q: { password: hunter2-value }, fields: [sku] } }\n`, 'search.yaml': op }));
    expect(nested).toContainEqual(expect.objectContaining({ path: 'connections[0].test.args.q.password' }));
  });

  it('rejects a token URL with credentials in it', async () => {
    const found = issues(await sources({ 'base.yaml': BASE.replace('auth: { scheme: bearer }', 'auth: { scheme: oauth_client_credentials, token_url: "https://u:hunter2-value@idp.example.test/token" }') }));
    expect(found).toEqual([expect.objectContaining({ path: 'connections[0].auth.token_url' })]);
    expect(found.map(formatIssue).join('\n')).not.toContain('hunter2-value');
  });
});

describe('SEC-1 manage_credentials names only known credential references', () => {
  it('maps roles to the references they manage', async () => {
    const config = ok(
      await sources({
        'roles.yaml': `version: 1
roles:
  - { id: admin, grants: [], manage_credentials: [shop-token] }
  - { id: root, grants: [], manage_credentials: ["*"] }
  - { id: viewer, grants: [] }
`,
      }),
    );
    expect([...config.credentialManagers]).toEqual([
      ['admin', ['shop-token']],
      ['root', ['*']],
    ]);
  });

  it('UI-5 rejects a reference no connection uses', async () => {
    const found = issues(await sources({ 'roles.yaml': 'version: 1\nroles:\n  - { id: admin, grants: [], manage_credentials: [shop-token, ghost] }\n' }));
    expect(found).toEqual([
      expect.objectContaining({ file: 'roles.yaml', path: 'roles[0].manage_credentials[1]', message: 'names a credential that no connection uses' }),
    ]);
  });

  it('UI-5 rejects a notification credential until notifications land (Phase 6)', async () => {
    const found = issues(
      await sources({
        'roles.yaml': `version: 1
roles:
  - { id: admin, grants: [], manage_credentials: [chat-hook] }
notifications:
  - { id: chat, kind: webhook, url_credential_ref: chat-hook }
`,
      }),
    );
    expect(found).toEqual([expect.objectContaining({ file: 'roles.yaml', path: 'roles[0].manage_credentials[0]', message: 'names a credential that no connection uses' })]);
  });
});
