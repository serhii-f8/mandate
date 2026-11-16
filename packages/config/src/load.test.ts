import { cp, mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { formatIssue, type ConfigIssue } from './issues.js';
import { loadConfigurationDirectory, loadConfigurationSources, type LoadResult } from './load.js';

const VALID_DIR = fileURLToPath(new URL('../test/fixtures/valid', import.meta.url));

const CONNECTIONS = `version: 1
connections:
  - { id: magento, adapter: openapi, base_url: https://shop.example.test/rest, credential_ref: magento-integration }
`;
const OPERATIONS = `version: 1
operations:
  - id: catalog.search_products
    connection: magento
    risk: read
    description: Search.
    upstream: { method: GET, path: /V1/products }
    input_schema:
      type: object
      properties: { brand: { type: string }, fields: { type: array, items: { type: string } } }
      required: [brand, fields]
    fields_arg: fields
`;
const ROLES = `version: 1
roles:
  - id: content_manager
    grants:
      - { operation: catalog.search_products, scope: { brand: [acme] }, deny_fields: [cost] }
role_mapping:
  - { group: content, roles: [content_manager] }
`;

function load(overrides: Record<string, string> = {}): LoadResult {
  const files: Record<string, string> = { 'connections.yaml': CONNECTIONS, 'operations.yaml': OPERATIONS, 'roles.yaml': ROLES, ...overrides };
  return loadConfigurationSources(Object.entries(files).map(([file, text]) => ({ file, text })));
}

function issues(result: LoadResult): readonly ConfigIssue[] {
  if (result.ok) throw new Error('expected issues');
  return result.issues;
}

describe('CFG-1 load a configuration directory', () => {
  it('loads operations, roles and mapping from several files, nested ones included', async () => {
    const result = await loadConfigurationDirectory(VALID_DIR);
    if (!result.ok) throw new Error(result.issues.map(formatIssue).join('\n'));
    const { policy, connections } = result.configuration;
    expect(policy.operations.map((o) => o.id)).toEqual(['catalog.search_products', 'support.lookup_order']);
    expect(policy.roles.map((r) => r.id)).toEqual(['content_manager', 'support_agent']);
    expect(policy.roleMapping).toEqual([
      { group: 'content', roles: ['content_manager'] },
      { group: 'support', roles: ['support_agent'] },
    ]);
    expect(policy.roles[0]?.grants[0]).toEqual({ operation: 'catalog.search_products', id: 'own-brands', scope: { brand: ['acme', 'globex'] }, denyFields: ['cost'] });
    expect(policy.operations[0]).toMatchObject({ fieldsArg: 'fields', risk: 'read', title: 'Search products' });
    expect(connections.map((c) => c.id)).toEqual(['magento']);
  });

  it('gives the same hash for the same input and another for other input', async () => {
    const a = await loadConfigurationDirectory(VALID_DIR);
    const b = await loadConfigurationDirectory(VALID_DIR);
    const c = load();
    if (!a.ok || !b.ok || !c.ok) throw new Error('expected valid');
    expect(a.configuration.hash).toMatch(/^[0-9a-f]{64}$/);
    expect(a.configuration.hash).toBe(b.configuration.hash);
    expect(c.configuration.hash).not.toBe(a.configuration.hash);
  });

  it('rejects a directory without configuration files', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'aiops-config-'));
    try {
      expect(issues(await loadConfigurationDirectory(dir))[0]?.message).toMatch(/no configuration files/);
    } finally {
      await rm(dir, { recursive: true });
    }
  });

  it('reports an unreadable file as an issue instead of failing', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'aiops-config-'));
    try {
      await cp(VALID_DIR, dir, { recursive: true });
      await symlink(join(dir, 'does-not-exist.yaml'), join(dir, 'dangling.yaml'));
      const found = issues(await loadConfigurationDirectory(dir));
      expect(found).toEqual([{ file: 'dangling.yaml', path: '', message: 'cannot be read' }]);
    } finally {
      await rm(dir, { recursive: true });
    }
  });

  it('skips hidden files and directories, such as editor lock files', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'aiops-config-'));
    try {
      await cp(VALID_DIR, dir, { recursive: true });
      await symlink('nobody@host.123', join(dir, '.#roles.yaml'));
      await mkdir(join(dir, '..data'));
      await writeFile(join(dir, '..data', 'roles.yaml'), 'not: [valid');
      expect((await loadConfigurationDirectory(dir)).ok).toBe(true);
    } finally {
      await rm(dir, { recursive: true });
    }
  });

  it('reports a missing directory as an issue', async () => {
    expect(issues(await loadConfigurationDirectory('/nonexistent/aiops-config'))[0]?.message).toMatch(/cannot be read/);
  });
});

describe('CFG-2 invalid configuration is rejected as a whole', () => {
  it('rejects everything when one file is invalid, with file, line and path', () => {
    const found = issues(load({ 'extra.yaml': 'version: 1\nroles:\n  - id: Bad Role\n    grants: []\n' }));
    expect(found).toEqual([{ file: 'extra.yaml', line: 3, column: 5, path: 'roles[0].id', message: 'has an invalid format' }]);
  });

  it('names both files for a duplicate operation ID', () => {
    const second = OPERATIONS.replace('version: 1\n', 'version: 1\n');
    const found = issues(load({ 'z-operations.yaml': second }));
    expect(found).toHaveLength(1);
    expect(found[0]).toMatchObject({ file: 'z-operations.yaml', path: 'operations[0].id' });
    expect(found[0]?.message).toContain('operations.yaml');
  });

  it.each([
    ['a grant for an unknown operation', { 'roles.yaml': ROLES.replace('operation: catalog.search_products', 'operation: catalog.nope') }, 'roles[0].grants[0].operation'],
    ['an operation on an unknown connection', { 'operations.yaml': OPERATIONS.replace('connection: magento', 'connection: shopify') }, 'operations[0].connection'],
    ['a scope key that is not an argument', { 'roles.yaml': ROLES.replace('scope: { brand: [acme] }', 'scope: { store: [x] }') }, 'roles[0].grants[0].scope.store'],
    ['a mapping to an unknown role', { 'roles.yaml': ROLES.replace('roles: [content_manager]', 'roles: [ghost]') }, 'role_mapping[0].roles[0]'],
    ['an operation ID reserved for a built-in tool', { 'operations.yaml': OPERATIONS.replace('id: catalog.search_products', 'id: ping') }, 'operations[0].id'],
  ])('rejects %s', (_name, override, path) => {
    const found = issues(load(override));
    expect(found.map((i) => i.path)).toContain(path);
  });

  it('rejects field rules on an operation without fields_arg', () => {
    const found = issues(load({ 'operations.yaml': OPERATIONS.replace('    fields_arg: fields\n', '') }));
    expect(found).toContainEqual(expect.objectContaining({ path: 'roles[0].grants[0].deny_fields' }));
  });

  it('rejects field rules when fields_arg is not a required argument', () => {
    const found = issues(load({ 'operations.yaml': OPERATIONS.replace('required: [brand, fields]', 'required: [brand]') }));
    expect(found).toContainEqual(expect.objectContaining({ path: 'operations[0].fields_arg' }));
  });

  it('rejects an approver role that does not exist', () => {
    const found = issues(load({ 'roles.yaml': ROLES.replace('    grants:', '    approval: { approver_role: nobody }\n    grants:') }));
    expect(found).toContainEqual(expect.objectContaining({ path: 'roles[0].approval.approver_role' }));
  });

  it('rejects an input schema whose root is not an object', () => {
    const found = issues(load({ 'operations.yaml': OPERATIONS.replace('      type: object\n      properties', '      type: array\n      properties') }));
    expect(found).toContainEqual(expect.objectContaining({ path: 'operations[0].input_schema' }));
  });

  it('rejects an input schema with an unknown keyword (Ajv strict mode)', () => {
    const found = issues(load({ 'operations.yaml': OPERATIONS.replace('required: [brand, fields]', 'required: [brand, fields]\n      requird: [brand]') }));
    expect(found).toContainEqual(expect.objectContaining({ path: 'operations[0].input_schema' }));
  });
});

describe('CFG-5 secrets never appear in configuration', () => {
  const message = 'secrets never appear in configuration; reference a credential by name';

  it.each([
    ['password', 'connections[0].password'],
    ['api_key', 'connections[0].api_key'],
    ['clientSecret', 'connections[0].clientSecret'],
  ])('rejects the key %s', (key, path) => {
    const found = issues(load({ 'connections.yaml': CONNECTIONS.replace('credential_ref: magento-integration', `credential_ref: magento-integration, ${key}: hunter2-value`) }));
    expect(found).toContainEqual(expect.objectContaining({ path, message }));
    expect(found.map(formatIssue).join('\n')).not.toContain('hunter2-value');
  });

  it.each([['cookie'], ['bearer'], ['credential']])('rejects the key %s', (key) => {
    const found = issues(load({ 'operations.yaml': OPERATIONS.replace('upstream: { method: GET, path: /V1/products }', `upstream: { method: GET, path: /V1/products, ${key}: x-value }`) }));
    expect(found).toContainEqual(expect.objectContaining({ path: `operations[0].upstream.${key}`, message }));
  });

  it('rejects a connection URL with a user name or password in it', () => {
    const found = issues(load({ 'connections.yaml': CONNECTIONS.replace('https://shop.example.test/rest', 'https://svc:hunter2-value@shop.example.test/rest') }));
    expect(found).toContainEqual(expect.objectContaining({ path: 'connections[0].base_url', message: 'must not contain a user name or password; reference a credential by name' }));
    expect(found.map(formatIssue).join('\n')).not.toContain('hunter2-value');
  });

  it('rejects a secret inside upstream, where unknown keys are otherwise allowed', () => {
    const found = issues(load({ 'operations.yaml': OPERATIONS.replace('upstream: { method: GET, path: /V1/products }', 'upstream: { method: GET, path: /V1/products, headers: { Authorization: Bearer abc.def } }') }));
    expect(found).toEqual([expect.objectContaining({ path: 'operations[0].upstream.headers.Authorization', message })]);
    expect(JSON.stringify(found)).not.toContain('abc.def');
  });

  it('accepts credential references and argument names inside input schemas', () => {
    const result = load({
      'operations.yaml': OPERATIONS.replace('fields: { type: array', 'page_token: { type: string }, fields: { type: array'),
      'notify.yaml': 'version: 1\nnotifications:\n  - { id: chat, kind: webhook, url_credential_ref: chat-hook }\n',
    });
    expect(result.ok).toBe(true);
  });
});

describe('MCP-3 argument validators', () => {
  it('compiles one validator per operation', () => {
    const result = load();
    if (!result.ok) throw new Error('expected valid');
    const validate = result.configuration.validators.get('catalog.search_products');
    expect(validate?.({ brand: 'acme', fields: ['name'] })).toEqual({ ok: true });
    const bad = validate?.({ fields: 'x' });
    expect(bad?.ok).toBe(false);
    if (bad?.ok === false) {
      expect(bad.message).toMatch(/brand/);
      expect(bad.message).not.toContain('"x"');
    }
  });
});
