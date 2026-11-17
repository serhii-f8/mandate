import { describe, expect, it } from 'vitest';
import type { ConfigIssue } from './issues.js';
import { loadConfigurationSources, type LoadedConfiguration, type LoadResult } from './load.js';

const CONNECTIONS = `version: 1
connections:
  - { id: magento, adapter: openapi, base_url: https://shop.example.test/rest, credential_ref: magento-integration, auth: { scheme: bearer } }
  - { id: other, adapter: openapi, base_url: https://other.example.test/rest }
`;

const FIELD_ENUM = '[sku, brand, name, description, price]';
const READS = `version: 1
operations:
  - id: catalog.get_products_by_sku
    connection: magento
    risk: read
    description: Products by SKU.
    upstream: { method: GET, path: /V1/products, query: { skus: { arg: skus, join: ',' }, brand: { arg: brand }, fields: { arg: fields, join: ',' } }, response: { items: items, fields_from_arg: fields } }
    input_schema:
      type: object
      properties:
        skus: { type: array, items: { type: string }, maxItems: 100 }
        brand: { type: string }
        fields: { type: array, items: { enum: ${FIELD_ENUM} } }
      required: [skus, fields]
    fields_arg: fields
  - id: catalog.search_products
    connection: magento
    risk: read
    description: Search.
    upstream: { method: GET, path: /V1/products/search, query: { brand: { arg: brand }, name_like: { arg: name_like }, current_page: { arg: current_page }, page_size: { arg: page_size }, fields: { arg: fields, join: ',' } }, response: { items: items, fields_from_arg: fields } }
    input_schema:
      type: object
      properties:
        brand: { type: string }
        name_like: { type: string }
        current_page: { type: integer }
        page_size: { type: integer }
        fields: { type: array, items: { type: string } }
      required: [fields]
    fields_arg: fields
  - id: other.get_items
    connection: other
    risk: read
    description: Other.
    upstream: { method: GET, path: /items, query: { fields: { arg: fields, join: ',' } }, response: { items: items, fields_from_arg: fields } }
    input_schema:
      type: object
      properties: { skus: { type: array, items: { type: string } }, brand: { type: string }, fields: { type: array, items: { type: string } } }
      required: [fields]
    fields_arg: fields
  - id: catalog.get_no_fields
    connection: magento
    risk: read
    description: No field list.
    upstream: { method: GET, path: /V1/plain, query: { skus: { arg: skus } } }
    input_schema:
      type: object
      properties: { skus: { type: array, items: { type: string } }, brand: { type: string } }
`;

const WRITE = `version: 1
operations:
  - id: catalog.update_content
    connection: magento
    risk: write
    description: Update content.
    upstream: { method: POST, path: /async/bulk/V1/products }
    input_schema:
      type: object
      properties:
        brand: { type: string }
        skus: { type: array, items: { type: string } }
        name_like: { type: string }
        changes: { type: object, properties: { name: { type: string }, description: { type: string } } }
      required: [brand, changes]
    manifest:
      id_field: sku
      ids_arg: skus
      values_arg: changes
      fields: [name, description]
      scope_args: { brand: brand }
      read_before:
        operation: catalog.get_products_by_sku
        ids_arg: skus
        args: { brand: { arg: brand } }
      selector:
        operation: catalog.search_products
        args: { brand: { arg: brand }, name_like: { arg: name_like } }
        page_arg: current_page
        page_size_arg: page_size
      rollback: { strategy: replay_previous_state }
`;

const ROLES = `version: 1
roles:
  - id: content_manager
    grants:
      - { operation: catalog.update_content, scope: { brand: [acme] } }
`;

function load(overrides: Record<string, string> = {}): Promise<LoadResult> {
  const files: Record<string, string> = { 'connections.yaml': CONNECTIONS, 'reads.yaml': READS, 'write.yaml': WRITE, 'roles.yaml': ROLES, ...overrides };
  return loadConfigurationSources(Object.entries(files).map(([file, text]) => ({ file, text })));
}

function ok(result: LoadResult): LoadedConfiguration {
  if (!result.ok) throw new Error(JSON.stringify(result.issues, null, 2));
  return result.configuration;
}

function issues(result: LoadResult): readonly ConfigIssue[] {
  if (result.ok) throw new Error('expected issues');
  return result.issues;
}

/** Loads with the write file edited and expects exactly one issue at `path` whose message does not quote `value`. */
async function expectIssue(edit: (text: string) => string, path: string, value: string, file = 'write.yaml'): Promise<ConfigIssue> {
  const text = edit(file === 'write.yaml' ? WRITE : file === 'reads.yaml' ? READS : ROLES);
  expect(text).not.toBe(file === 'write.yaml' ? WRITE : file === 'reads.yaml' ? READS : ROLES);
  const found = issues(await load({ [file]: text }));
  const match = found.filter((i) => i.path === path);
  expect(match, JSON.stringify(found)).toHaveLength(1);
  const [issue] = match;
  if (issue === undefined) throw new Error('unreachable: length checked above');
  expect(issue.message).not.toContain(value);
  expect(issue.line).toBeTypeOf('number');
  return issue;
}

const M = 'operations[0].manifest';

describe('OPS-2 manifest configuration', () => {
  it('OPS-2 loads a valid manifest with defaults, converted to the core type', async () => {
    const config = ok(await load());
    const op = config.policy.operations.find((o) => o.id === 'catalog.update_content');
    expect(op?.fieldsArg).toBe('changes');
    expect(op?.manifest).toEqual({
      idField: 'sku',
      idsArg: 'skus',
      valuesArg: 'changes',
      fields: ['name', 'description'],
      requiredFields: [],
      scopeArgs: { brand: 'brand' },
      readBefore: { operation: 'catalog.get_products_by_sku', idsArg: 'skus', args: { brand: { arg: 'brand' } } },
      selector: {
        operation: 'catalog.search_products',
        args: { brand: { arg: 'brand' }, name_like: { arg: 'name_like' } },
        pageArg: 'current_page',
        pageSizeArg: 'page_size',
        pageSize: 100,
      },
      batchSize: 100,
      maxTargets: 10000,
      rollback: { strategy: 'replay_previous_state' },
    });
  });

  it('OPS-2 does not apply the ADR 0023 projection and upstream-scope rules to a manifest operation', async () => {
    // The write operation has no response.fields_from_arg and its upstream sends no brand,
    // yet its grant constrains brand: the reads and the item check enforce the scope.
    const config = ok(await load());
    expect(config.policy.roles[0]?.grants[0]?.scope).toEqual({ brand: ['acme'] });
  });

  it('OPS-2 accepts an explicit fields_arg equal to values_arg and rejects another one', async () => {
    ok(await load({ 'write.yaml': WRITE.replace('    manifest:\n', '    fields_arg: changes\n    manifest:\n') }));
    await expectIssue((t) => t.replace('    manifest:\n', '    fields_arg: brand\n    manifest:\n'), 'operations[0].fields_arg', 'brand');
  });

  it('OPS-2 still requires the field-list argument to be a required property', async () => {
    await expectIssue((t) => t.replace('required: [brand, changes]', 'required: [brand]'), `${M}.values_arg`, 'changes');
  });

  it('OPS-2 rejects a manifest with neither ids_arg nor selector', async () => {
    const text = WRITE.replace('      ids_arg: skus\n      values_arg', '      values_arg').replace(/ {6}selector:\n(?: {8}.*\n)+/, '');
    await expectIssue(() => text, M, 'skus');
  });

  it('OPS-2 check 1: a write operation requires a manifest', async () => {
    await expectIssue((t) => t.replace(/ {4}manifest:\n[\s\S]*$/, ''), M, 'catalog.update_content');
  });

  it('OPS-2 check 1: read and write_opaque operations must not have a manifest; destructive may', async () => {
    await expectIssue((t) => t.replace('risk: write', 'risk: write_opaque'), M, 'catalog');
    ok(await load({ 'write.yaml': WRITE.replace('risk: write', 'risk: destructive') }));
    const readWithManifest = READS.replace(
      '    fields_arg: fields\n  - id: catalog.search_products',
      `    fields_arg: fields\n    manifest: { id_field: sku, ids_arg: skus, values_arg: fields, fields: [name], read_before: { operation: catalog.search_products, ids_arg: skus }, rollback: { strategy: none } }\n  - id: catalog.search_products`,
    );
    await expectIssue(() => readWithManifest, 'operations[0].manifest', 'catalog', 'reads.yaml');
  });

  it('OPS-2 check 2: read_before and selector name enabled read operations on the same connection with fields_arg', async () => {
    await expectIssue((t) => t.replace('operation: catalog.get_products_by_sku', 'operation: catalog.nope'), `${M}.read_before.operation`, 'catalog.nope');
    await expectIssue((t) => t.replace('operation: catalog.get_products_by_sku', 'operation: other.get_items'), `${M}.read_before.operation`, 'other');
    await expectIssue((t) => t.replace('operation: catalog.get_products_by_sku', 'operation: catalog.get_no_fields'), `${M}.read_before.operation`, 'get_no_fields');
    await expectIssue((t) => t.replace('operation: catalog.search_products', 'operation: catalog.update_content'), `${M}.selector.operation`, 'update_content');
    const disabled = issues(
      await load({ 'overrides.yaml': 'version: 1\noverrides:\n  - { operation: catalog.get_products_by_sku, enabled: false }\n' }),
    );
    expect(disabled).toEqual([expect.objectContaining({ file: 'write.yaml', path: `${M}.read_before.operation`, message: 'must name an enabled read operation' })]);
  });

  it('OPS-2 check 2: a manifest on a disabled operation is not cross-checked', async () => {
    ok(
      await load({
        'write.yaml': WRITE.replace('operation: catalog.get_products_by_sku', 'operation: catalog.nope'),
        'roles.yaml': 'version: 1\nroles: []\n',
        'overrides.yaml': 'version: 1\noverrides:\n  - { operation: catalog.update_content, enabled: false }\n',
      }),
    );
  });

  it('OPS-2 check 3: ids_arg is an array property, values_arg an object property within fields, read ids_arg an array with enough maxItems', async () => {
    await expectIssue((t) => t.replace('      ids_arg: skus\n      values_arg', '      ids_arg: brand\n      values_arg'), `${M}.ids_arg`, 'brand');
    await expectIssue((t) => t.replace('      ids_arg: skus\n      values_arg', '      ids_arg: missing_arg\n      values_arg'), `${M}.ids_arg`, 'missing_arg');
    await expectIssue((t) => t.replace('values_arg: changes', 'values_arg: brand'), `${M}.values_arg`, 'brand');
    await expectIssue((t) => t.replace('fields: [name, description]', 'fields: [name]'), `${M}.values_arg`, 'description');
    await expectIssue((t) => t.replace('        ids_arg: skus\n        args', '        ids_arg: brand\n        args'), `${M}.read_before.ids_arg`, 'brand');
    // The edit is in the reads file; the issue is reported in the write file.
    const found = issues(await load({ 'reads.yaml': READS.replace('maxItems: 100', 'maxItems: 50') }));
    expect(found).toEqual([expect.objectContaining({ file: 'write.yaml', path: `${M}.batch_size` })]);
    expect(found[0]?.message).not.toMatch(/50|100/);
    ok(await load({ 'write.yaml': WRITE.replace('rollback:', 'batch_size: 50\n      rollback:'), 'reads.yaml': READS.replace('maxItems: 100', 'maxItems: 50') }));
  });

  it('OPS-2 check 3: an undeclared values_arg properties list is not checked against fields', async () => {
    ok(await load({ 'write.yaml': WRITE.replace('changes: { type: object, properties: { name: { type: string }, description: { type: string } } }', 'changes: { type: object }') }));
  });

  it('OPS-2 check 4: scope_args keys are write arguments referenced by the reads, and cover every grant scope argument', async () => {
    await expectIssue((t) => t.replace('scope_args: { brand: brand }', 'scope_args: { brand: brand, store: price }'), `${M}.scope_args.store`, 'price');
    await expectIssue((t) => t.replace("        args: { brand: { arg: brand } }\n", '        args: {}\n'), `${M}.read_before.args`, 'acme');
    await expectIssue((t) => t.replace('args: { brand: { arg: brand }, name_like: { arg: name_like } }', 'args: { name_like: { arg: name_like } }'), `${M}.selector.args`, 'acme');
    const grant = await expectIssue((t) => t.replace('scope_args: { brand: brand }', 'scope_args: {}'), 'roles[0].grants[0].scope.brand', 'acme');
    expect(grant.file).toBe('roles.yaml');
  });

  it('OPS-2 check 5: read args are write arguments, keys are read arguments, page arguments belong to the selector', async () => {
    await expectIssue((t) => t.replace("        args: { brand: { arg: brand } }\n", "        args: { brand: { arg: brand }, store: { arg: store_ref } }\n"), `${M}.read_before.args.store.arg`, 'store_ref');
    await expectIssue((t) => t.replace("        args: { brand: { arg: brand } }\n", "        args: { brand: { arg: brand }, unknown_key: 1 }\n"), `${M}.read_before.args.unknown_key`, 'unknown_key');
    await expectIssue((t) => t.replace('page_arg: current_page', 'page_arg: page_number'), `${M}.selector.page_arg`, 'page_number');
    await expectIssue((t) => t.replace('page_size_arg: page_size', 'page_size_arg: limit_x'), `${M}.selector.page_size_arg`, 'limit_x');
  });

  it('OPS-2 check 6: id_field, fields and scope record fields are in the read fields_arg enum', async () => {
    await expectIssue((t) => t.replace('id_field: sku', 'id_field: entity_code'), `${M}.id_field`, 'entity_code');
    await expectIssue((t) => t.replace('fields: [name, description]', 'fields: [name, description, meta_title]'), `${M}.fields[2]`, 'meta_title');
    await expectIssue((t) => t.replace('scope_args: { brand: brand }', 'scope_args: { brand: manufacturer }'), `${M}.scope_args.brand`, 'manufacturer');
    // Without an enum (selector op declares plain strings) nothing is checked.
    ok(await load({ 'reads.yaml': READS.replace(`items: { enum: ${FIELD_ENUM} }`, 'items: { type: string }'), 'write.yaml': WRITE.replace('id_field: sku', 'id_field: entity_code') }));
  });
});

describe('OPS-3 rollback strategy', () => {
  it('OPS-3 requires a rollback strategy', async () => {
    const issue = await expectIssue((t) => t.replace('      rollback: { strategy: replay_previous_state }\n', ''), `${M}.rollback`, 'replay');
    expect(issue.message).toBe('is required');
  });

  it('OPS-3 accepts none and an inverse write operation', async () => {
    const config = ok(await load({ 'write.yaml': WRITE.replace('strategy: replay_previous_state', 'strategy: none') }));
    expect(config.policy.operations.find((o) => o.id === 'catalog.update_content')?.manifest?.rollback).toEqual({ strategy: 'none' });
    const inverse = ok(await load({ 'write.yaml': WRITE.replace('{ strategy: replay_previous_state }', '{ strategy: inverse_operation, operation: catalog.update_content }') }));
    expect(inverse.policy.operations.find((o) => o.id === 'catalog.update_content')?.manifest?.rollback).toEqual({ strategy: 'inverse_operation', operation: 'catalog.update_content' });
  });

  it('OPS-3 check 7: inverse_operation names an enabled write operation on the same connection', async () => {
    const edit = (target: string) => (t: string) => t.replace('{ strategy: replay_previous_state }', `{ strategy: inverse_operation, operation: ${target} }`);
    await expectIssue(edit('catalog.get_products_by_sku'), `${M}.rollback.operation`, 'get_products_by_sku');
    await expectIssue(edit('catalog.missing_inverse'), `${M}.rollback.operation`, 'missing_inverse');
  });
});

describe('CS-6 change-set expiry setting', () => {
  it('CS-6 defaults expireAfterHours to 72', async () => {
    expect(ok(await load()).changesets).toEqual({ expireAfterHours: 72 });
  });

  it('CS-6 reads changesets.expire_after_hours and checks its range', async () => {
    expect(ok(await load({ 'changesets.yaml': 'version: 1\nchangesets: { expire_after_hours: 24 }\n' })).changesets).toEqual({ expireAfterHours: 24 });
    const found = issues(await load({ 'changesets.yaml': 'version: 1\nchangesets: { expire_after_hours: 5000 }\n' }));
    expect(found).toEqual([expect.objectContaining({ file: 'changesets.yaml', path: 'changesets.expire_after_hours' })]);
    expect(found[0]?.message).not.toContain('5000');
  });

  it('CS-6 rejects changesets declared in two documents', async () => {
    const found = issues(
      await load({
        'changesets.yaml': 'version: 1\nchangesets: { expire_after_hours: 24 }\n',
        'more.yaml': 'version: 1\nchangesets: { expire_after_hours: 48 }\n',
      }),
    );
    expect(found).toEqual([expect.objectContaining({ file: 'more.yaml', path: 'changesets' })]);
    expect(found[0]?.message).toContain('changesets.yaml');
    expect(found[0]?.message).not.toContain('48');
  });
});
