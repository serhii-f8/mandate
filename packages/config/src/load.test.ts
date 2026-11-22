// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Mandate Authors
import { createHash } from 'node:crypto';
import { cp, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { formatIssue, type ConfigIssue } from './issues.js';
import { DEFAULT_RATE_LIMITS } from './schema.js';
import { loadConfigurationDirectory, loadConfigurationSources, type LoadResult } from './load.js';
import { resolvePreset } from './presets.js';
import { SECRET_MESSAGE } from './secrets.js';
import { FIXTURE_CONFIG, FIXTURE_PRESET_FILE, loadCodeFixture, presetWithoutUpdate } from '../test/code-fixture.js';

const VALID_DIR = fileURLToPath(new URL('../test/fixtures/valid', import.meta.url));
const FIXTURES = fileURLToPath(new URL('../test/fixtures', import.meta.url));

const CONNECTIONS = `version: 1
connections:
  - { id: magento, adapter: openapi, base_url: https://shop.example.test/rest, credential_ref: magento-integration, auth: { scheme: bearer } }
`;
const OPERATIONS = `version: 1
operations:
  - id: catalog.search_products
    connection: magento
    risk: read
    description: Search.
    upstream: { method: GET, path: /V1/products, query: { brand: { arg: brand } }, response: { fields_from_arg: fields } }
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

function load(overrides: Record<string, string> = {}): Promise<LoadResult> {
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
    const c = await load();
    if (!a.ok || !b.ok || !c.ok) throw new Error('expected valid');
    expect(a.configuration.hash).toMatch(/^[0-9a-f]{64}$/);
    expect(a.configuration.hash).toBe(b.configuration.hash);
    expect(c.configuration.hash).not.toBe(a.configuration.hash);
  });

  it('rejects a directory without configuration files', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'mandate-config-'));
    try {
      expect(issues(await loadConfigurationDirectory(dir))[0]?.message).toMatch(/no configuration files/);
    } finally {
      await rm(dir, { recursive: true });
    }
  });

  it('reports an unreadable file as an issue instead of failing', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'mandate-config-'));
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
    const dir = await mkdtemp(join(tmpdir(), 'mandate-config-'));
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
    expect(issues(await loadConfigurationDirectory('/nonexistent/mandate-config'))[0]?.message).toMatch(/cannot be read/);
  });
});

describe('CFG-2 invalid configuration is rejected as a whole', () => {
  it('rejects everything when one file is invalid, with file, line and path', async () => {
    const found = issues(await load({ 'extra.yaml': 'version: 1\nroles:\n  - id: Bad Role\n    grants: []\n' }));
    expect(found).toEqual([{ file: 'extra.yaml', line: 3, column: 5, path: 'roles[0].id', message: 'has an invalid format' }]);
  });

  it('tells a wrong value or type apart from a missing key, without echoing the value', async () => {
    const found = issues(await load({ 'extra.yaml': 'version: 2\nroles: nope-value\n' }));
    expect(found.map((i) => [i.path, i.message])).toEqual([
      ['version', 'must be one of: 1'],
      ['roles', 'must be array'],
    ]);
    expect(issues(await load({ 'extra.yaml': 'roles: []\n' }))).toEqual([expect.objectContaining({ path: 'version', message: 'is required' })]);
  });

  it('CFG-2 reports a base URL that is not a URL as a located issue', async () => {
    const result = await load({
      'extra-connections.yaml': 'version: 1\nconnections:\n  - { id: broken, adapter: openapi, base_url: "__UPSTREAM_URL__/rest" }\n',
    });
    expect(issues(result)).toEqual([expect.objectContaining({ file: 'extra-connections.yaml', path: 'connections[0].base_url' })]);
    expect(JSON.stringify(issues(result))).not.toContain('__UPSTREAM_URL__');
  });

  it('names both files for a duplicate operation ID', async () => {
    const second = OPERATIONS.replace('version: 1\n', 'version: 1\n');
    const found = issues(await load({ 'z-operations.yaml': second }));
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
    ['MCP-8 the operation ID exclude_changeset_items (built-in)', { 'operations.yaml': OPERATIONS.replace('id: catalog.search_products', 'id: exclude_changeset_items') }, 'operations[0].id'],
    ['MCP-8 the operation ID decide_changeset (built-in)', { 'operations.yaml': OPERATIONS.replace('id: catalog.search_products', 'id: decide_changeset') }, 'operations[0].id'],
    ['APR-8 the operation ID review_changeset (built-in)', { 'operations.yaml': OPERATIONS.replace('id: catalog.search_products', 'id: review_changeset') }, 'operations[0].id'],
  ])('rejects %s', async (_name, override, path) => {
    const found = issues(await load(override));
    expect(found.map((i) => i.path)).toContain(path);
  });

  it('rejects field rules on an operation without fields_arg', async () => {
    const found = issues(await load({ 'operations.yaml': OPERATIONS.replace('    fields_arg: fields\n', '') }));
    expect(found).toContainEqual(expect.objectContaining({ path: 'roles[0].grants[0].deny_fields' }));
  });

  it('rejects field rules when fields_arg is not a required argument', async () => {
    const found = issues(await load({ 'operations.yaml': OPERATIONS.replace('required: [brand, fields]', 'required: [brand]') }));
    expect(found).toContainEqual(expect.objectContaining({ path: 'operations[0].fields_arg' }));
  });

  it('rejects an input schema whose root is not an object', async () => {
    const found = issues(await load({ 'operations.yaml': OPERATIONS.replace('      type: object\n      properties', '      type: array\n      properties') }));
    expect(found).toContainEqual(expect.objectContaining({ path: 'operations[0].input_schema' }));
  });

  it('rejects an input schema with an unknown keyword (Ajv strict mode)', async () => {
    const found = issues(await load({ 'operations.yaml': OPERATIONS.replace('required: [brand, fields]', 'required: [brand, fields]\n      requird: [brand]') }));
    expect(found).toContainEqual(expect.objectContaining({ path: 'operations[0].input_schema' }));
  });
});

describe('CFG-5 secrets never appear in configuration', () => {
  const message = 'secrets never appear in configuration; reference a credential by name';

  it.each([
    ['password', 'connections[0].password'],
    ['api_key', 'connections[0].api_key'],
    ['clientSecret', 'connections[0].clientSecret'],
  ])('rejects the key %s', async (key, path) => {
    const found = issues(await load({ 'connections.yaml': CONNECTIONS.replace('credential_ref: magento-integration', `credential_ref: magento-integration, ${key}: hunter2-value`) }));
    expect(found).toContainEqual(expect.objectContaining({ path, message }));
    expect(found.map(formatIssue).join('\n')).not.toContain('hunter2-value');
  });

  it.each([['cookie'], ['bearer'], ['credential']])('rejects the key %s', async (key) => {
    const found = issues(await load({ 'operations.yaml': OPERATIONS.replace('path: /V1/products,', `path: /V1/products, ${key}: x-value,`) }));
    expect(found).toContainEqual(expect.objectContaining({ path: `operations[0].upstream.${key}`, message }));
  });

  it('rejects a connection URL with a user name or password in it', async () => {
    const found = issues(await load({ 'connections.yaml': CONNECTIONS.replace('https://shop.example.test/rest', 'https://svc:hunter2-value@shop.example.test/rest') }));
    expect(found).toContainEqual(expect.objectContaining({ path: 'connections[0].base_url', message: 'must not contain a user name or password; reference a credential by name' }));
    expect(found.map(formatIssue).join('\n')).not.toContain('hunter2-value');
  });

  it('rejects a secret header inside upstream', async () => {
    const found = issues(await load({ 'operations.yaml': OPERATIONS.replace('path: /V1/products,', 'path: /V1/products, headers: { Authorization: Bearer abc.def },') }));
    expect(found).toEqual([expect.objectContaining({ path: 'operations[0].upstream.headers.Authorization', message })]);
    expect(JSON.stringify(found)).not.toContain('abc.def');
  });

  it('accepts credential references and argument names inside input schemas', async () => {
    const result = await load({
      'operations.yaml': OPERATIONS.replace('fields: { type: array', 'page_token: { type: string }, fields: { type: array'),
      'notify.yaml': 'version: 1\nnotifications:\n  - { id: chat, kind: webhook, url_credential_ref: chat-hook, allowed_hosts: [hooks.example.test] }\n',
    });
    expect(result.ok).toBe(true);
  });
});

describe('MCP-3 argument validators', () => {
  it('compiles one validator per operation', async () => {
    const result = await load();
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

describe('EXE-5 EXE-9 changesets in the loaded configuration', () => {
  it('EXE-5 EXE-9 the loaded configuration carries both values and the single-document rule still applies', async () => {
    const defaults = await load();
    if (!defaults.ok) throw new Error('expected ok');
    expect(defaults.configuration.changesets).toEqual({ expireAfterHours: 72, failureThreshold: 0.5, itemsPerWorkflowRun: 2000, rollbackWindowHours: 168 });
    const set = await load({ 'cs.yaml': 'version: 1\nchangesets: { failure_threshold: 0.25, items_per_workflow_run: 300 }\n' });
    if (!set.ok) throw new Error('expected ok');
    expect(set.configuration.changesets).toEqual({ expireAfterHours: 72, failureThreshold: 0.25, itemsPerWorkflowRun: 300, rollbackWindowHours: 168 });
    const twice = issues(await load({ 'cs.yaml': 'version: 1\nchangesets: { failure_threshold: 0.25 }\n', 'cs2.yaml': 'version: 1\nchangesets: { items_per_workflow_run: 300 }\n' }));
    expect(twice).toEqual([expect.objectContaining({ path: 'changesets' })]);
  });
});

describe('CFG-2 APR-3 POL-5 approval configuration', () => {
  const withApproval = (approval: string, roles = ROLES) => roles.replace('    grants:', `    approval: ${approval}\n    grants:`);
  const SUPPORT = `
  - id: support_agent
    grants: []`;
  const rolesWith = (approval: string) => withApproval(approval).replace('role_mapping:', `${SUPPORT.slice(1)}\nrole_mapping:`);

  it('maps steps, step-up and widget onto the core rule', async () => {
    const result = await load({
      'roles.yaml': rolesWith('{ required: above_threshold, record_threshold: 25, steps: [{ role: support_agent }], step_up_max_age_seconds: 300, allow_widget: true }'),
    });
    if (!result.ok) throw new Error(JSON.stringify(result.issues));
    expect(result.configuration.approval.get('content_manager')).toEqual({
      required: 'above_threshold',
      recordThreshold: 25,
      steps: ['support_agent'],
      stepUpMaxAgeSeconds: 300,
      allowWidget: true,
    });
  });

  it('APR-3 a step role that is not defined', async () => {
    const found = issues(await load({ 'roles.yaml': withApproval('{ steps: [{ role: nobody }] }') }));
    expect(found).toContainEqual(expect.objectContaining({ path: 'roles[0].approval.steps[0].role', message: 'names a role that is not defined' }));
  });

  it('above_threshold without record_threshold', async () => {
    const found = issues(await load({ 'roles.yaml': withApproval('{ required: above_threshold }') }));
    expect(found).toContainEqual(expect.objectContaining({ path: 'roles[0].approval.record_threshold', message: 'is required with required: above_threshold' }));
  });

  it('record_threshold with another mode', async () => {
    const found = issues(await load({ 'roles.yaml': withApproval('{ required: always, record_threshold: 5, steps: [{ role: content_manager }] }') }));
    expect(found).toContainEqual(expect.objectContaining({ path: 'roles[0].approval.record_threshold', message: 'is allowed only with required: above_threshold' }));
  });

  it('a step naming the role itself is allowed', async () => {
    const result = await load({ 'roles.yaml': withApproval('{ steps: [{ role: content_manager }] }') });
    expect(result.ok, JSON.stringify(result.ok ? [] : result.issues)).toBe(true);
  });

  it('POL-5 a write_opaque grant needs an approval step unless required: never', async () => {
    const SEND = `version: 1
operations:
  - id: mail.send
    connection: magento
    risk: write_opaque
    description: Send.
    upstream: { method: POST, path: /V1/send }
    input_schema: { type: object, properties: { to: { type: string } } }
`;
    const granted = (roles: string): string => roles.replace('    grants:\n', '    grants:\n      - { operation: mail.send }\n');
    const message = 'needs at least one step: a write or destructive grant requires approval by default (set steps, or required: never for write operations)';
    const refused = issues(await load({ 'send.yaml': SEND, 'roles.yaml': granted(ROLES) }));
    expect(refused).toEqual([expect.objectContaining({ path: 'roles[0].approval', message })]);
    const never = await load({ 'send.yaml': SEND, 'roles.yaml': granted(withApproval('{ required: never }')) });
    expect(never.ok, JSON.stringify(never.ok ? [] : never.issues)).toBe(true);
    const stepped = await load({ 'send.yaml': SEND, 'roles.yaml': granted(withApproval('{ steps: [{ role: content_manager }] }')) });
    expect(stepped.ok, JSON.stringify(stepped.ok ? [] : stepped.issues)).toBe(true);
  });

  it('approver_role is no longer accepted', async () => {
    const found = issues(await load({ 'roles.yaml': withApproval('{ approver_role: content_manager }') }));
    expect(found).toContainEqual(expect.objectContaining({ path: 'roles[0].approval' }));
  });
});

describe('POL-5 approval routing configuration', () => {
  const PRICES = `version: 1
operations:
  - id: catalog.get_products
    connection: magento
    risk: read
    description: Products by SKU.
    upstream: { method: GET, path: /V1/products, query: { skus: { arg: skus, join: ',' } }, response: { items: items, fields_from_arg: fields } }
    input_schema:
      type: object
      properties: { skus: { type: array, items: { type: string } }, fields: { type: array, items: { type: string } } }
      required: [skus, fields]
    fields_arg: fields
  - id: catalog.update
    connection: magento
    risk: write
    description: Update.
    upstream: { method: POST, path: /async/bulk/V1/products }
    input_schema:
      type: object
      properties:
        skus: { type: array, items: { type: string } }
        changes: { type: object, properties: { name: { type: string }, price: { type: string } }, additionalProperties: false }
      required: [changes]
    manifest:
      id_field: sku
      ids_arg: skus
      values_arg: changes
      fields: [name, price]
      scope_args: {}
      read_before: { operation: catalog.get_products, ids_arg: skus }
      rollback: { strategy: replay_previous_state }
`;
  const rolesYaml = (editor: string, grant = '{ operation: catalog.update }') => `version: 1
roles:
  - id: editor
    grants:
      - ${grant}
${editor}
  - id: pricing_owner
    grants: []
  - id: content_lead
    grants: []
role_mapping:
  - { group: content, roles: [editor] }
`;
  const FIELD_RULE = '{ fields: [price], required: always, steps: [{ role: pricing_owner }] }';
  const loadRoles = (roles: string, extra: Record<string, string> = {}) => load({ 'prices.yaml': PRICES, 'roles.yaml': roles, ...extra });

  it('POL-5 a grant approval is keyed by the rule reference, by index or by grant ID', async () => {
    const approval = '{ required: always, steps: [{ role: pricing_owner }] }';
    const byIndex = await loadRoles(rolesYaml('    approval: { required: never }', `{ operation: catalog.update, approval: ${approval} }`));
    if (!byIndex.ok) throw new Error(JSON.stringify(byIndex.issues));
    expect(byIndex.configuration.grantApproval.get('role:editor/grant:0')?.steps).toEqual(['pricing_owner']);
    const byId = await loadRoles(rolesYaml('    approval: { required: never }', `{ operation: catalog.update, id: prices, approval: ${approval} }`));
    if (!byId.ok) throw new Error(JSON.stringify(byId.issues));
    expect(byId.configuration.grantApproval.get('role:editor/grant:prices')?.steps).toEqual(['pricing_owner']);
    expect(byId.configuration.grantApproval.has('role:editor/grant:0')).toBe(false);
  });

  it('POL-5 field rules map onto the core rule, on the role and on a grant', async () => {
    const role = await loadRoles(rolesYaml(`    approval: { required: never, field_rules: [${FIELD_RULE}] }`));
    if (!role.ok) throw new Error(JSON.stringify(role.issues));
    expect(role.configuration.approval.get('editor')?.fieldRules?.[0]).toMatchObject({ fields: ['price'], required: 'always', steps: ['pricing_owner'] });
    const grant = await loadRoles(rolesYaml('', `{ operation: catalog.update, approval: { required: never, field_rules: [${FIELD_RULE}] } }`));
    if (!grant.ok) throw new Error(JSON.stringify(grant.issues));
    expect(grant.configuration.grantApproval.get('role:editor/grant:0')?.fieldRules?.[0]?.fields).toEqual(['price']);
  });

  it('POL-5 a field-rule step naming an undefined role', async () => {
    const found = issues(await loadRoles(rolesYaml('    approval: { required: never, field_rules: [{ fields: [price], required: always, steps: [{ role: nobody }] }] }')));
    expect(found).toContainEqual(expect.objectContaining({ path: 'roles[0].approval.field_rules[0].steps[0].role', message: 'names a role that is not defined' }));
    const grant = issues(await loadRoles(rolesYaml('', '{ operation: catalog.update, approval: { required: never, steps: [{ role: nobody }] } }')));
    expect(grant).toContainEqual(expect.objectContaining({ path: 'roles[0].grants[0].approval.steps[0].role', message: 'names a role that is not defined' }));
  });

  it('POL-5 field_rules on a grant whose operation has no fields_arg', async () => {
    const without = `version: 1
operations:
  - id: catalog.update
    connection: magento
    risk: write_opaque
    description: Update.
    upstream: { method: POST, path: /V1/products }
    input_schema: { type: object, properties: { changes: { type: object } } }
`;
    const grant = issues(await loadRoles(rolesYaml('', `{ operation: catalog.update, approval: { required: never, field_rules: [${FIELD_RULE}] } }`), { 'prices.yaml': without }));
    expect(grant).toContainEqual(expect.objectContaining({ path: 'roles[0].grants[0].approval.field_rules', message: 'operation catalog.update declares no fields_arg' }));
    const role = issues(await loadRoles(rolesYaml(`    approval: { required: never, field_rules: [${FIELD_RULE}] }`), { 'prices.yaml': without }));
    expect(role).toContainEqual(expect.objectContaining({ path: 'roles[0].grants[0].operation', message: 'operation catalog.update declares no fields_arg, which the approval field_rules of role editor need' }));
  });

  it('POL-5 an empty fields list, a threshold without above_threshold and a nested field_rules are refused', async () => {
    expect(issues(await loadRoles(rolesYaml('    approval: { required: never, field_rules: [{ fields: [], required: never }] }'))).map((i) => i.path)).toContain('roles[0].approval.field_rules[0].fields');
    const threshold = issues(await loadRoles(rolesYaml('    approval: { required: never, field_rules: [{ fields: [price], record_threshold: 3, steps: [{ role: pricing_owner }] }] }')));
    expect(threshold).toContainEqual(expect.objectContaining({ path: 'roles[0].approval.field_rules[0].record_threshold', message: 'is allowed only with required: above_threshold' }));
    const noThreshold = issues(await loadRoles(rolesYaml('    approval: { required: never, field_rules: [{ fields: [price], required: above_threshold, steps: [{ role: pricing_owner }] }] }')));
    expect(noThreshold).toContainEqual(expect.objectContaining({ path: 'roles[0].approval.field_rules[0].record_threshold', message: 'is required with required: above_threshold' }));
    const nested = issues(await loadRoles(rolesYaml('    approval: { required: never, field_rules: [{ fields: [price], field_rules: [] }] }')));
    expect(nested.map((i) => i.path).some((path) => path.startsWith('roles[0].approval.field_rules[0]'))).toBe(true);
  });

  it('POL-5 a write grant approval without steps is refused unless required: never; the role rule does not cover it', async () => {
    const message = 'needs at least one step: a write or destructive grant requires approval by default (set steps, or required: never for write operations)';
    const stepless = issues(await loadRoles(rolesYaml('    approval: { steps: [{ role: pricing_owner }] }', '{ operation: catalog.update, approval: { required: always } }')));
    expect(stepless).toContainEqual(expect.objectContaining({ path: 'roles[0].grants[0].approval.steps', message }));
    const never = await loadRoles(rolesYaml('    approval: { steps: [{ role: pricing_owner }] }', '{ operation: catalog.update, approval: { required: never } }'));
    expect(never.ok, JSON.stringify(never.ok ? [] : never.issues)).toBe(true);
    const field = issues(await loadRoles(rolesYaml('    approval: { required: never, field_rules: [{ fields: [price], required: always }] }')));
    expect(field).toContainEqual(expect.objectContaining({ path: 'roles[0].approval.field_rules[0].steps', message }));
  });
});

describe('AUD-7 SEC-1 audit configuration in the loaded configuration', () => {
  it('AUD-7 audit settings come from one document only', async () => {
    const none = await load();
    if (!none.ok) throw new Error(JSON.stringify(none.issues));
    expect(none.configuration.audit).toEqual({});
    const set = await load({ 'a.yaml': 'version: 1\naudit: { retention_days: 90 }\n' });
    if (!set.ok) throw new Error(JSON.stringify(set.issues));
    expect(set.configuration.audit).toEqual({ retentionDays: 90 });
    const twice = issues(await load({ 'a.yaml': 'version: 1\naudit: { retention_days: 90 }\n', 'b.yaml': 'version: 1\naudit: { retention_days: 30 }\n' }));
    expect(twice).toEqual([expect.objectContaining({ path: 'audit', message: 'may be set in one document only; first set in a.yaml' })]);
  });

  it('SEC-1 view_audit defaults to false and fills auditViewers', async () => {
    const result = await load({ 'auditor.yaml': 'version: 1\nroles:\n  - id: auditor\n    grants: []\n    view_audit: true\n' });
    if (!result.ok) throw new Error(JSON.stringify(result.issues));
    expect([...result.configuration.auditViewers]).toEqual(['auditor']);
    const plain = await load();
    if (!plain.ok) throw new Error(JSON.stringify(plain.issues));
    expect(plain.configuration.auditViewers.size).toBe(0);
  });
});

describe('CONN-8 preset packages in the loaded configuration', () => {
  const PRESET_DIRS = [join(FIXTURES, 'preset-dir')];

  async function withConfig(config: string): Promise<string> {
    const dir = await mkdtemp(join(tmpdir(), 'mandate-load-preset-'));
    await writeFile(join(dir, 'config.yaml'), config);
    return dir;
  }

  it('CONN-8 a preset bound to a connection of another adapter is refused', async () => {
    const dir = await withConfig(`version: 1
presets:
  - { id: fake, package: "@mandate/fake-preset" }
connections:
  - { id: shop, adapter: mcp, mcp_url: https://shop.example.test/mcp, preset: fake }
`);
    try {
      expect(issues(await loadConfigurationDirectory(dir, { presetDirs: PRESET_DIRS }))).toEqual([
        expect.objectContaining({ file: 'config.yaml', path: 'connections[0].preset', message: 'the preset is for openapi connections' }),
      ]);
    } finally {
      await rm(dir, { recursive: true });
    }

    const presets = await mkdtemp(join(tmpdir(), 'mandate-load-mcp-preset-'));
    const openapiDir = await withConfig(`version: 1
presets:
  - { id: tools, package: "@acme/mcp-preset" }
connections:
  - { id: shop, adapter: openapi, base_url: https://shop.example.test/api, preset: tools }
`);
    try {
      await mkdir(join(presets, 'mcp-preset'));
      await writeFile(join(presets, 'mcp-preset', 'package.json'), JSON.stringify({ name: '@acme/mcp-preset', version: '1.0.0', mandate: { sdk: '^1.0.0' } }));
      await writeFile(join(presets, 'mcp-preset', 'preset.yaml'), 'version: 1\nadapter: mcp\n');
      expect(issues(await loadConfigurationDirectory(openapiDir, { presetDirs: [presets] }))).toEqual([
        expect.objectContaining({ file: 'config.yaml', path: 'connections[0].preset', message: 'the preset is for mcp connections' }),
      ]);
    } finally {
      await rm(presets, { recursive: true });
      await rm(openapiDir, { recursive: true });
    }
  });

  it('OPS-5 OPS-6 CONN-8 the fixture preset loads with all six operations and four code bindings plus one per-record binding', async () => {
    const dirs: string[] = [];
    try {
      const result = await loadCodeFixture(dirs);
      if (!result.ok) throw new Error(result.issues.map(formatIssue).join('\n'));
      const { configuration } = result;
      expect(configuration.policy.operations.map((o) => o.id)).toEqual([
        'fixture.search',
        'fixture.get_many',
        'fixture.update',
        'fixture.set_tags',
        'fixture.ping',
        'fixture.boom',
      ]);
      expect(Object.fromEntries([...configuration.bindings].map(([id, b]) => [id, b.kind]))).toEqual({
        'fixture.search': 'http',
        'fixture.get_many': 'code',
        'fixture.update': 'http',
        'fixture.set_tags': 'code',
        'fixture.ping': 'code',
        'fixture.boom': 'code',
      });
      expect(configuration.codeOperations.size).toBe(4);
      const update = configuration.bindings.get('fixture.update');
      if (update?.kind !== 'http') throw new Error('fixture.update has no HTTP binding');
      expect(update.mapping).toMatchObject({ method: 'PATCH', path: '/items/{id}', pathParams: { id: { record: 'id' } } });
      expect(update.mapping.bulk).toBeUndefined();
    } finally {
      await Promise.all(dirs.map((d) => rm(d, { recursive: true, force: true })));
    }
  });

  it('OPS-5 CONN-8 the fixture preset without fixture.update loads with five operations and four code bindings', async () => {
    const dirs: string[] = [];
    try {
      const result = await loadCodeFixture(dirs, { preset: await presetWithoutUpdate() });
      if (!result.ok) throw new Error(result.issues.map(formatIssue).join('\n'));
      const { configuration } = result;
      expect(configuration.policy.operations.map((o) => o.id)).toEqual(['fixture.search', 'fixture.get_many', 'fixture.set_tags', 'fixture.ping', 'fixture.boom']);
      expect(Object.fromEntries([...configuration.bindings].map(([id, b]) => [id, b.kind]))).toEqual({
        'fixture.search': 'http',
        'fixture.get_many': 'code',
        'fixture.set_tags': 'code',
        'fixture.ping': 'code',
        'fixture.boom': 'code',
      });
      expect(configuration.codeOperations.size).toBe(4);
      expect(configuration.loadedPresets.get('fixture')).toMatchObject({ package: '@mandate/code-fixture-preset', version: '1.1.0' });
    } finally {
      await Promise.all(dirs.map((d) => rm(d, { recursive: true, force: true })));
    }
  });

  it('CONN-8 loadedPresets reports the chosen version', async () => {
    const result = await loadConfigurationDirectory(join(FIXTURES, 'with-preset'), { presetDirs: PRESET_DIRS });
    if (!result.ok) throw new Error(result.issues.map(formatIssue).join('\n'));
    const resolved = await resolvePreset({ id: 'fake', package: '@mandate/fake-preset' }, PRESET_DIRS);
    if (!resolved.ok) throw new Error('fixture preset must resolve');
    const digest = createHash('sha256');
    for (const { file, text } of resolved.preset.files) digest.update(`preset:${file}`).update('\0').update(text).update('\0');
    expect([...result.configuration.loadedPresets]).toEqual([
      ['fake', { package: '@mandate/fake-preset', version: '0.1.0', adapter: 'openapi', filesDigest: digest.digest('hex') }],
    ]);
    expect(resolved.preset.files[0]?.text).toBe(await readFile(join(FIXTURES, 'preset-dir', 'fake-preset', 'package.json'), 'utf8'));
    const skipped = await loadConfigurationDirectory(join(FIXTURES, 'with-preset'));
    expect(skipped.ok && skipped.configuration.loadedPresets.size).toBe(0);
  });
});


describe('CONN-8 preset aliases', () => {
  const twoShops = (a: string, b: string, grants = '      - { operation: shop_a.search }\n'): string => `version: 1
presets:
  - { id: fixture, package: "@mandate/code-fixture-preset" }
connections:
  - { id: a, adapter: openapi, base_url: https://a.example.test/api, credential_ref: items-token, preset: fixture${a} }
  - { id: b, adapter: openapi, base_url: https://b.example.test/api, credential_ref: items-token, preset: fixture${b} }
roles:
  - id: viewer
    grants:
${grants}  - id: integration_admin
    grants: []
    manage_credentials: [items-token]
role_mapping:
  - { group: viewers, roles: [viewer] }
`;
  const PREFIXED = twoShops(', operation_prefix: shop_a', ', operation_prefix: shop_b');

  async function loadAliased(config: string, preset?: string): Promise<LoadResult> {
    const dirs: string[] = [];
    try {
      return await loadCodeFixture(dirs, { preset: preset ?? (await presetWithoutUpdate()), config: { 'config.yaml': config } });
    } finally {
      await Promise.all(dirs.map((d) => rm(d, { recursive: true, force: true })));
    }
  }

  it('CONN-8 one preset bound to two connections with distinct prefixes yields two operation sets, each bound to its connection', async () => {
    const result = await loadAliased(PREFIXED);
    if (!result.ok) throw new Error(result.issues.map(formatIssue).join('\n'));
    const ops = result.configuration.policy.operations;
    const names = ['search', 'get_many', 'set_tags', 'ping', 'boom'];
    expect(ops.map((o) => o.id)).toEqual([...names.map((n) => `shop_a.${n}`), ...names.map((n) => `shop_b.${n}`)]);
    for (const o of ops) {
      expect(o.connection).toBe(o.id.startsWith('shop_a.') ? 'a' : 'b');
      expect(o.toolName).toBe(o.id);
      expect(o.source).toBe('preset:fixture');
    }
    expect([...result.configuration.bindings.keys()]).toContain('shop_b.get_many');
    expect(result.configuration.codeOperations.size).toBe(8);
  });

  it('CONN-8 internal references follow the prefix', async () => {
    const result = await loadAliased(PREFIXED);
    if (!result.ok) throw new Error(result.issues.map(formatIssue).join('\n'));
    const byId = new Map(result.configuration.policy.operations.map((o) => [o.id, o]));
    for (const ns of ['shop_a', 'shop_b']) {
      const manifest = byId.get(`${ns}.set_tags`)?.manifest;
      expect(manifest?.readBefore.operation).toBe(`${ns}.get_many`);
      expect(manifest?.selector?.operation).toBe(`${ns}.search`);
    }
    // inverse_operation rollback: set_tags is its own inverse.
    const text = await presetWithoutUpdate();
    const at = text.indexOf('  - id: fixture.set_tags\n');
    const preset = text.slice(0, at) + text.slice(at).replace('rollback: { strategy: replay_previous_state }', 'rollback: { strategy: inverse_operation, operation: fixture.set_tags }');
    const inverse = await loadAliased(PREFIXED, preset);
    if (!inverse.ok) throw new Error(inverse.issues.map(formatIssue).join('\n'));
    const rollbacks = inverse.configuration.policy.operations.filter((o) => o.id.endsWith('.set_tags')).map((o) => o.manifest?.rollback);
    expect(rollbacks).toEqual([
      { strategy: 'inverse_operation', operation: 'shop_a.set_tags' },
      { strategy: 'inverse_operation', operation: 'shop_b.set_tags' },
    ]);
  });

  it('CONN-8 the preset test operation follows the prefix', async () => {
    const preset = (await presetWithoutUpdate()).replace('operations:\n', 'test: { operation: fixture.search, args: { page: 1, per_page: 1, fields: [id] } }\noperations:\n');
    const result = await loadAliased(PREFIXED, preset);
    if (!result.ok) throw new Error(result.issues.map(formatIssue).join('\n'));
    expect(result.configuration.connectionTests.get('a')).toEqual({ operation: 'shop_a.search', args: { page: 1, per_page: 1, fields: ['id'] } });
    expect(result.configuration.connectionTests.get('b')).toEqual({ operation: 'shop_b.search', args: { page: 1, per_page: 1, fields: ['id'] } });
  });

  it('CONN-8 binding a preset twice without distinct prefixes is refused', async () => {
    const message = 'the preset is already bound to connection a with the same operation prefix';
    for (const config of [
      twoShops('', '', '      - { operation: fixture.search }\n'),
      twoShops(', operation_prefix: x', ', operation_prefix: x', '      - { operation: x.search }\n'),
      twoShops(', operation_prefix: fixture', '', '      - { operation: fixture.search }\n'),
    ]) {
      expect(issues(await loadAliased(config))).toEqual([expect.objectContaining({ file: 'config.yaml', path: 'connections[1].preset', message })]);
    }
  });

  it('CONN-8 operation_prefix without preset is refused', async () => {
    const result = await load({
      'connections.yaml': CONNECTIONS.replace('auth: { scheme: bearer } }', 'auth: { scheme: bearer }, operation_prefix: shop }'),
    });
    expect(issues(result)).toEqual([expect.objectContaining({ file: 'connections.yaml', path: 'connections[0].operation_prefix', message: 'requires preset' })]);
  });

  it('POL-1 a grant naming the unprefixed ID of an aliased preset is an unknown operation', async () => {
    const result = await loadAliased(twoShops(', operation_prefix: shop_a', ', operation_prefix: shop_b', '      - { operation: fixture.search }\n'));
    expect(issues(result)).toEqual([expect.objectContaining({ file: 'config.yaml', path: 'roles[0].grants[0].operation', message: 'names an operation that is not defined' })]);
  });
});

describe('CONN-8 preset parameters bound per connection', () => {
  /** The fixture preset with two parameters used by fixture.search (operation index 0). */
  async function parameterized(): Promise<string> {
    const text = await presetWithoutUpdate();
    return text
      .replace('operations:\n', 'params:\n  scope: { type: string, default: brand, description: Attribute to filter on. }\n  limit: { type: number, default: 50 }\noperations:\n')
      .replace("        limit: { arg: per_page }\n      response: { items: '$', fields_from_arg: fields }", () =>
        "        limit: { arg: per_page }\n        filter_field: { $param: scope }\n      response: { items: '$', fields_from_arg: fields, max_items: { $param: limit } }",
      );
  }
  const oneShop = (extra = ''): string => FIXTURE_CONFIG.replace('    preset: fixture\n', `    preset: fixture\n${extra}`);
  const twoShops = (a: string, b: string): string => `version: 1
presets:
  - { id: fixture, package: "@mandate/code-fixture-preset" }
connections:
  - { id: a, adapter: openapi, base_url: https://a.example.test/api, credential_ref: items-token, preset: fixture, operation_prefix: shop_a${a} }
  - { id: b, adapter: openapi, base_url: https://b.example.test/api, credential_ref: items-token, preset: fixture, operation_prefix: shop_b${b} }
roles:
  - id: integration_admin
    grants: []
    manage_credentials: [items-token]
`;

  async function loadWith(config: string, preset?: string): Promise<LoadResult> {
    const dirs: string[] = [];
    try {
      return await loadCodeFixture(dirs, { preset: preset ?? (await parameterized()), config: { 'config.yaml': config } });
    } finally {
      await Promise.all(dirs.map((d) => rm(d, { recursive: true, force: true })));
    }
  }

  function searchMapping(result: LoadResult, id: string): unknown {
    if (!result.ok) throw new Error(result.issues.map(formatIssue).join('\n'));
    const binding = result.configuration.bindings.get(id);
    if (binding?.kind !== 'http') throw new Error(`${id} has no HTTP binding`);
    return binding.mapping;
  }

  it('CONN-8 without preset_params the bound operation carries the defaults', async () => {
    const result = await loadWith(oneShop());
    expect(searchMapping(result, 'fixture.search')).toMatchObject({ query: { filter_field: 'brand' }, response: { maxItems: 50 } });
    expect(result.ok && result.configuration.connectionSettings.get('items')?.presetParams).toEqual({ scope: 'brand', limit: 50 });
  });

  it('CONN-8 a connection binding a preset without parameters gets empty values; one without a preset gets none', async () => {
    const result = await loadWith(oneShop(), await presetWithoutUpdate());
    if (!result.ok) throw new Error(result.issues.map(formatIssue).join('\n'));
    expect(result.configuration.connectionSettings.get('items')?.presetParams).toEqual({});
    const plain = await load();
    expect(plain.ok && plain.configuration.connectionSettings.get('magento')?.presetParams).toBeUndefined();
  });

  it('CONN-8 two connections bind one preset with different parameters; nothing is shared between bindings', async () => {
    const result = await loadWith(twoShops(', preset_params: { scope: vendor, limit: 20 }', ''));
    expect(searchMapping(result, 'shop_a.search')).toMatchObject({ query: { filter_field: 'vendor' }, response: { maxItems: 20 } });
    expect(searchMapping(result, 'shop_b.search')).toMatchObject({ query: { filter_field: 'brand' }, response: { maxItems: 50 } });
    if (!result.ok) throw new Error('expected a configuration');
    expect(result.configuration.connectionSettings.get('a')?.presetParams).toEqual({ scope: 'vendor', limit: 20 });
    expect(result.configuration.connectionSettings.get('b')?.presetParams).toEqual({ scope: 'brand', limit: 50 });
  });

  it('CONN-8 a value of the wrong type is an issue at the connection, without echoing it', async () => {
    const found = issues(await loadWith(oneShop('    preset_params: { scope: 5 }\n')));
    expect(found).toEqual([expect.objectContaining({ file: 'config.yaml', path: 'connections[0].preset_params.scope', message: 'must be a string' })]);
  });

  it('CONN-8 an unknown parameter name, an object value and a nested list are issues at the connection', async () => {
    expect(issues(await loadWith(oneShop('    preset_params: { nope: x }\n')))).toEqual([
      expect.objectContaining({ file: 'config.yaml', path: 'connections[0].preset_params.nope', message: 'is not a parameter of the preset' }),
    ]);
    for (const value of ['{ a: 1 }', '[[a]]']) {
      const found = issues(await loadWith(oneShop(`    preset_params: { scope: ${value} }\n`)));
      expect(found).toEqual([expect.objectContaining({ file: 'config.yaml', path: 'connections[0].preset_params.scope' })]);
    }
  });

  it('CONN-8 a value that breaks the operation schema is reported at preset_params, naming the operation', async () => {
    const found = issues(await loadWith(oneShop('    preset_params: { limit: 1000 }\n')));
    expect(found).toEqual([
      expect.objectContaining({
        file: 'config.yaml',
        path: 'connections[0].preset_params',
        message: expect.stringContaining('operation fixture.search') as unknown,
      }),
    ]);
  });

  it('CONN-8 preset_params on a connection without preset is refused', async () => {
    const result = await load({
      'connections.yaml': CONNECTIONS.replace('auth: { scheme: bearer } }', 'auth: { scheme: bearer }, preset_params: { scope: x } }'),
    });
    expect(issues(result)).toEqual([expect.objectContaining({ file: 'connections.yaml', path: 'connections[0].preset_params', message: 'requires preset' })]);
  });

  it('CONN-8 an operation naming an undeclared parameter fails in the preset file', async () => {
    const preset = (await parameterized()).replace('filter_field: { $param: scope }', 'filter_field: { $param: x }');
    const found = issues(await loadWith(oneShop(), preset));
    expect(found).toEqual([expect.objectContaining({ file: FIXTURE_PRESET_FILE, path: 'operations', message: 'names undeclared preset parameters: x' })]);
  });

  it('CONN-8 a declaration whose default does not match its type fails in the preset file', async () => {
    const preset = (await parameterized()).replace('limit: { type: number, default: 50 }', 'limit: { type: number, default: "50" }');
    const found = issues(await loadWith(oneShop(), preset));
    expect(found).toEqual([expect.objectContaining({ file: FIXTURE_PRESET_FILE, path: 'params.limit.default' })]);
  });

  it('CONN-8 the preset test is substituted per binding', async () => {
    const preset = (await parameterized())
      .replace('params:\n', 'params:\n  probe_state: { type: string, default: open }\n')
      .replace('operations:\n', 'test: { operation: fixture.search, args: { page: 1, per_page: 1, fields: [id], state: { $param: probe_state } } }\noperations:\n');
    const result = await loadWith(twoShops(', preset_params: { probe_state: closed }', ''), preset);
    if (!result.ok) throw new Error(result.issues.map(formatIssue).join('\n'));
    expect(result.configuration.connectionTests.get('a')).toEqual({ operation: 'shop_a.search', args: { page: 1, per_page: 1, fields: ['id'], state: 'closed' } });
    expect(result.configuration.connectionTests.get('b')).toEqual({ operation: 'shop_b.search', args: { page: 1, per_page: 1, fields: ['id'], state: 'open' } });
  });

  it('CFG-4 two configurations differing only in a preset_params value have different hashes', async () => {
    const a = await loadWith(oneShop('    preset_params: { scope: vendor }\n'));
    const b = await loadWith(oneShop('    preset_params: { scope: maker }\n'));
    if (!a.ok || !b.ok) throw new Error('expected valid configurations');
    expect(a.configuration.hash).not.toBe(b.configuration.hash);
  });

  it('CFG-5 a secret-like key under preset_params is refused like anywhere in a connection', async () => {
    const found = issues(await loadWith(oneShop('    preset_params: { api_token: hunter2-value }\n')));
    expect(found).toContainEqual(expect.objectContaining({ file: 'config.yaml', path: 'connections[0].preset_params.api_token', message: SECRET_MESSAGE }));
    expect(found.map(formatIssue).join('\n')).not.toContain('hunter2-value');
  });
});

describe('AUTH-4 service_accounts', () => {
  const SUPPORT_ROLE = 'version: 1\nroles:\n  - { id: support_agent, grants: [] }\n';
  const accounts = (entries: string): string => `version: 1\nservice_accounts:\n${entries}`;
  const CI = '  - { client_id: mandate-sa-ci, role: support_agent, description: CI }\n';

  it('AUTH-4 a service account maps its client to one role', async () => {
    const result = await load({ 'support.yaml': SUPPORT_ROLE, 'sa.yaml': accounts(CI) });
    if (!result.ok) throw new Error(result.issues.map(formatIssue).join('\n'));
    expect(result.configuration.serviceAccounts.get('mandate-sa-ci')).toEqual({ role: 'support_agent', description: 'CI' });
    expect(result.configuration.policy.serviceAccounts).toEqual([{ clientId: 'mandate-sa-ci', role: 'support_agent' }]);
  });

  it('AUTH-4 without service_accounts the maps are empty', async () => {
    const result = await load();
    if (!result.ok) throw new Error(result.issues.map(formatIssue).join('\n'));
    expect(result.configuration.serviceAccounts.size).toBe(0);
    expect(result.configuration.policy.serviceAccounts).toEqual([]);
  });

  it.each([
    ['an unknown role', { 'sa.yaml': accounts('  - { client_id: mandate-sa-ci, role: ghost }\n') }, 'sa.yaml', 'service_accounts[0].role', 'names a role that is not defined'],
    [
      'a duplicate client_id across two files',
      { 'sa-a.yaml': accounts(CI), 'sa-b.yaml': accounts('  - { client_id: mandate-sa-ci, role: support_agent }\n') },
      'sa-b.yaml',
      'service_accounts[0].client_id',
      'duplicate client_id; first defined in sa-a.yaml at service_accounts[0]',
    ],
  ])('AUTH-4 rejects %s', async (_name, files, file, path, message) => {
    const found = issues(await load({ 'support.yaml': SUPPORT_ROLE, ...files }));
    expect(found).toEqual([expect.objectContaining({ file, path, message })]);
  });

  it.each([
    ['an empty client_id', '{ client_id: "", role: support_agent }', 'service_accounts[0].client_id'],
    ['a control character in client_id', '{ client_id: "a\\u0007b", role: support_agent }', 'service_accounts[0].client_id'],
    ['a 256-character client_id', `{ client_id: ${'a'.repeat(256)}, role: support_agent }`, 'service_accounts[0].client_id'],
    ['an extra key', '{ client_id: mandate-sa-ci, role: support_agent, roles: [x] }', 'service_accounts[0]'],
    ['role given as a list', '{ client_id: mandate-sa-ci, role: [support_agent] }', 'service_accounts[0].role'],
    ['a description over 500 characters', `{ client_id: mandate-sa-ci, role: support_agent, description: ${'d'.repeat(501)} }`, 'service_accounts[0].description'],
  ])('AUTH-4 rejects %s as a schema error', async (_name, entry, path) => {
    const found = issues(await load({ 'support.yaml': SUPPORT_ROLE, 'sa.yaml': accounts(`  - ${entry}\n`) }));
    // An empty client_id fails both the length and the format check: every issue is on that path.
    expect(found.length).toBeGreaterThan(0);
    expect(found.map((i) => [i.file, i.path])).toEqual(found.map(() => ['sa.yaml', path]));
  });
});

describe('SEC-10 rate_limits in the loaded configuration', () => {
  it('SEC-10 rate_limits defaults when absent', async () => {
    const dir = await loadConfigurationDirectory(VALID_DIR);
    if (!dir.ok) throw new Error('fixture invalid');
    expect(dir.configuration.rateLimits).toEqual(DEFAULT_RATE_LIMITS);
    expect(DEFAULT_RATE_LIMITS).toEqual({ mcpUserPerMinute: 300, mcpServiceAccountPerMinute: 600, unauthenticatedPerMinute: 60 });
  });

  it('SEC-10 rate_limits fills missing keys key by key and may be set in one document only', async () => {
    const set = await load({ 'a.yaml': 'version: 1\nrate_limits: { mcp_user_per_minute: 5 }\n' });
    if (!set.ok) throw new Error(JSON.stringify(set.issues));
    expect(set.configuration.rateLimits).toEqual({ ...DEFAULT_RATE_LIMITS, mcpUserPerMinute: 5 });
    const twice = issues(await load({ 'a.yaml': 'version: 1\nrate_limits: { mcp_user_per_minute: 5 }\n', 'b.yaml': 'version: 1\nrate_limits: { mcp_user_per_minute: 6 }\n' }));
    expect(twice).toEqual([expect.objectContaining({ path: 'rate_limits', message: 'may be set in one document only; first set in a.yaml' })]);
  });

  it('SEC-10 rate_limits refusal names file, path and reason', async () => {
    const found = issues(await load({ 'a.yaml': 'version: 1\nrate_limits: { mcp_user_per_minute: 0 }\n' }));
    expect(found).toEqual([expect.objectContaining({ file: 'a.yaml', path: 'rate_limits.mcp_user_per_minute' })]);
    expect(found.map((issue) => formatIssue(issue)).join('\n')).toContain('a.yaml');
  });

  it('SEC-10 service account override is optional and carried into the loaded map', async () => {
    const result = await load({ 'sa.yaml': 'version: 1\nservice_accounts:\n  - { client_id: sa-a, role: content_manager, rate_limit_per_minute: 7 }\n  - { client_id: sa-b, role: content_manager }\n' });
    if (!result.ok) throw new Error(JSON.stringify(result.issues));
    expect(result.configuration.serviceAccounts.get('sa-a')?.rateLimitPerMinute).toBe(7);
    expect(result.configuration.serviceAccounts.get('sa-b')?.rateLimitPerMinute).toBeUndefined();
    expect(result.configuration.serviceAccounts.get('sa-b')).not.toHaveProperty('rateLimitPerMinute');
  });
});
