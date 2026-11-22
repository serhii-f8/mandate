// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Mandate Authors
import { rm } from 'node:fs/promises';
import { afterEach, describe, expect, it } from 'vitest';
import { loadCodeFixture, presetWithoutUpdate } from '../test/code-fixture.js';
import type { ConfigIssue } from './issues.js';
import { loadConfigurationSources, type LoadedConfiguration, type LoadResult } from './load.js';
import type { HttpOperationBinding } from './registry.js';

const dirs: string[] = [];
afterEach(async () => {
  await Promise.all(dirs.splice(0).map((d) => rm(d, { recursive: true, force: true })));
});

const CONNECTIONS = `version: 1
connections:
  - { id: magento, adapter: openapi, base_url: https://shop.example.test/rest, credential_ref: magento-integration, auth: { scheme: bearer } }
  - { id: other, adapter: openapi, base_url: https://other.example.test/rest }
`;

const FIELD_ENUM = '[sku, brand, name, description, price, status]';
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
        changes: { type: object, properties: { name: { type: string }, description: { type: string } }, additionalProperties: false }
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
    approval: { required: never }
`;

function load(overrides: Record<string, string> = {}): Promise<LoadResult> {
  const files: Record<string, string> = { 'connections.yaml': CONNECTIONS, 'reads.yaml': READS, 'write.yaml': WRITE, 'roles.yaml': ROLES, ...overrides };
  return loadConfigurationSources(Object.entries(files).map(([file, text]) => ({ file, text })));
}

/** The HTTP binding of an operation; throws for an MCP binding or none. */
function httpBinding(config: LoadedConfiguration, id: string): HttpOperationBinding {
  const binding = config.bindings.get(id);
  if (binding?.kind !== 'http') throw new Error(`${id} has no HTTP binding`);
  return binding;
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
    ok(await load({ 'write.yaml': WRITE.replace('risk: write', 'risk: destructive'), 'roles.yaml': ROLES.replace('{ required: never }', '{ required: never, steps: [{ role: content_manager }] }') }));
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

  const CHANGES = 'changes: { type: object, properties: { name: { type: string }, description: { type: string } }, additionalProperties: false }';

  it('OPS-2 check 3: values_arg must declare its properties and additionalProperties false, so no key is silently dropped', async () => {
    await expectIssue((t) => t.replace(CHANGES, 'changes: { type: object }'), `${M}.values_arg`, 'changes');
    await expectIssue((t) => t.replace(CHANGES, 'changes: { type: object, additionalProperties: false }'), `${M}.values_arg`, 'changes');
    await expectIssue((t) => t.replace(CHANGES, 'changes: { type: object, properties: { name: { type: string } } }'), `${M}.values_arg`, 'changes');
    await expectIssue(
      (t) => t.replace(CHANGES, 'changes: { type: object, properties: { name: { type: string } }, additionalProperties: true }'),
      `${M}.values_arg`,
      'changes',
    );
  });

  it('OPS-2 check 3: ids_arg items are strings or integers', async () => {
    const SKUS = 'skus: { type: array, items: { type: string } }\n        name_like';
    await expectIssue((t) => t.replace(SKUS, 'skus: { type: array, items: { type: number } }\n        name_like'), `${M}.ids_arg`, 'skus');
    await expectIssue((t) => t.replace(SKUS, 'skus: { type: array }\n        name_like'), `${M}.ids_arg`, 'skus');
    await expectIssue((t) => t.replace(SKUS, 'skus: { type: array, items: { type: object } }\n        name_like'), `${M}.ids_arg`, 'skus');
    ok(await load({ 'write.yaml': WRITE.replace(SKUS, 'skus: { type: array, items: { type: integer } }\n        name_like') }));
  });

  it('OPS-2 read_before.ids_arg must be an array of strings', async () => {
    const READ_SKUS = 'skus: { type: array, items: { type: string }, maxItems: 100 }';
    const issue = await expectIssue((t) => t.replace(READ_SKUS, 'skus: { type: array, items: { type: integer }, maxItems: 100 }'), `${M}.read_before.ids_arg`, 'skus', 'reads.yaml');
    expect(issue).toMatchObject({ file: 'write.yaml', message: 'must be an array of strings: target IDs are passed as strings' });
    await expectIssue((t) => t.replace(READ_SKUS, "skus: { type: array, items: { type: [string, 'null'] }, maxItems: 100 }"), `${M}.read_before.ids_arg`, 'skus', 'reads.yaml');
    // Items without a type stay accepted, as do absent items.
    ok(await load({ 'reads.yaml': READS.replace(READ_SKUS, 'skus: { type: array, items: { enum: [sku-1, sku-2] }, maxItems: 100 }') }));
    ok(await load({ 'reads.yaml': READS.replace(READ_SKUS, 'skus: { type: array, maxItems: 100 }') }));
  });

  it('OPS-2 OPS-5 a code read with fields_arg and an ids array serves as read_before', async () => {
    const config = ok(await loadCodeFixture(dirs, { preset: await presetWithoutUpdate() }));
    const setTags = config.policy.operations.find((o) => o.id === 'fixture.set_tags');
    expect(setTags?.manifest?.readBefore).toMatchObject({ operation: 'fixture.get_many', idsArg: 'ids' });
    expect(config.bindings.get('fixture.get_many')?.kind).toBe('code');
    expect(config.bindings.get('fixture.set_tags')?.kind).toBe('code');
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
    await expectIssue((t) => t.replace('fields: [name, description]', 'fields: [name, description]\n      required_fields: [name, meta_title]'), `${M}.required_fields[1]`, 'meta_title');
    // Without an enum (selector op declares plain strings) nothing is checked.
    ok(await load({ 'reads.yaml': READS.replace(`items: { enum: ${FIELD_ENUM} }`, 'items: { type: string }'), 'write.yaml': WRITE.replace('id_field: sku', 'id_field: entity_code') }));
  });
});

describe('OPS-2 records_arg', () => {
  const ITEM = '{ type: object, properties: { sku: { type: string }, name: { type: string }, description: { type: string } }, required: [sku], additionalProperties: false }';
  const RECORDS_PROP = `records: { type: array, items: ${ITEM} }`;
  const CHANGES_PROP = 'changes: { type: object, properties: { name: { type: string }, description: { type: string } }, additionalProperties: false }';
  const RECORDS = WRITE.replace(CHANGES_PROP, RECORDS_PROP)
    .replace('required: [brand, changes]', 'required: [brand, records]')
    .replace('      ids_arg: skus\n      values_arg: changes\n', '      records_arg: records\n')
    .replace(/ {6}selector:\n(?: {8}.*\n)+/, '');
  const item = (t: string, replacement: string): string => t.replace(ITEM, replacement);
  const edit = (from: string, to: string) => (): string => RECORDS.replace(from, to);

  it('OPS-2 a records_arg manifest loads to recordsArg without valuesArg, and fields_arg defaults to it', async () => {
    const config = ok(await load({ 'write.yaml': RECORDS }));
    const op = config.policy.operations.find((o) => o.id === 'catalog.update_content');
    expect(op?.fieldsArg).toBe('records');
    expect(op?.manifest).toMatchObject({ idField: 'sku', recordsArg: 'records', fields: ['name', 'description'] });
    expect(op?.manifest).not.toHaveProperty('valuesArg');
    expect(op?.manifest).not.toHaveProperty('idsArg');
    ok(await load({ 'write.yaml': RECORDS.replace('    manifest:\n', '    fields_arg: records\n    manifest:\n') }));
  });

  it('OPS-2 exactly one of values_arg and records_arg', async () => {
    await expectIssue(edit('      records_arg: records\n', '      records_arg: records\n      values_arg: changes\n'), M, 'sku');
    await expectIssue(edit('      records_arg: records\n', ''), M, 'changes');
  });

  it('OPS-2 ids_arg and selector are not allowed beside records_arg', async () => {
    const withIds = await expectIssue(edit('      records_arg: records\n', '      records_arg: records\n      ids_arg: skus\n'), `${M}.ids_arg`, 'skus');
    expect(withIds.message).toBe('is not allowed with records_arg');
    const sel = '      selector:\n        operation: catalog.search_products\n        args: { brand: { arg: brand } }\n        page_arg: current_page\n        page_size_arg: page_size\n';
    const withSelector = await expectIssue(edit('      rollback:', `${sel}      rollback:`), `${M}.selector`, 'catalog');
    expect(withSelector.message).toBe('is not allowed with records_arg');
  });

  it('OPS-2 records_arg names a required top-level array property', async () => {
    await expectIssue(edit('records_arg: records', 'records_arg: brand'), `${M}.records_arg`, 'brand');
    await expectIssue(edit('records_arg: records', 'records_arg: missing_arg'), `${M}.records_arg`, 'missing_arg');
    await expectIssue(edit('required: [brand, records]', 'required: [brand]'), `${M}.records_arg`, 'records');
  });

  it('OPS-2 the items are a closed object schema', async () => {
    await expectIssue(() => item(RECORDS, '{ type: string }'), `${M}.records_arg`, 'records');
    await expectIssue(() => RECORDS.replace(RECORDS_PROP, 'records: { type: array }'), `${M}.records_arg`, 'records');
    await expectIssue(() => item(RECORDS, '{ type: object, properties: { sku: { type: string }, name: { type: string } }, required: [sku] }'), `${M}.records_arg`, 'records');
    await expectIssue(() => item(RECORDS, '{ type: object, additionalProperties: false, required: [sku] }'), `${M}.records_arg`, 'records');
  });

  it('OPS-2 an item property outside id_field and fields is refused', async () => {
    await expectIssue(
      () => item(RECORDS, '{ type: object, properties: { sku: { type: string }, name: { type: string }, price: { type: string } }, required: [sku], additionalProperties: false }'),
      `${M}.records_arg`,
      'price',
    );
  });

  it('OPS-2 id_field is a required item property of type string or integer', async () => {
    await expectIssue(() => item(RECORDS, '{ type: object, properties: { sku: { type: string }, name: { type: string } }, required: [name], additionalProperties: false }'), `${M}.records_arg`, 'sku');
    await expectIssue(() => item(RECORDS, '{ type: object, properties: { sku: { type: number }, name: { type: string } }, required: [sku], additionalProperties: false }'), `${M}.records_arg`, 'sku');
    await expectIssue(() => item(RECORDS, '{ type: object, properties: { name: { type: string } }, required: [sku], additionalProperties: false }'), `${M}.records_arg`, 'sku');
    ok(await load({ 'write.yaml': item(RECORDS, '{ type: object, properties: { sku: { type: integer }, name: { type: string } }, required: [sku], additionalProperties: false }') }));
  });

  it('OPS-2 fields_arg other than records_arg is refused', async () => {
    const issue = await expectIssue(edit("    manifest:\n", "    fields_arg: brand\n    manifest:\n"), 'operations[0].fields_arg', 'brand');
    expect(issue.message).toBe('must equal manifest.records_arg');
  });
});

describe('OPS-2 manifest action', () => {
  const ITEM = '{ type: object, properties: { sku: { type: string }, name: { type: string }, description: { type: string }, brand: { type: string } }, required: [sku], additionalProperties: false }';
  const CHANGES_PROP = 'changes: { type: object, properties: { name: { type: string }, description: { type: string } }, additionalProperties: false }';
  const NO_SELECTOR = / {6}selector:\n(?: {8}.*\n)+/;
  const HEADER = 'version: 1\noperations:\n';
  /** A create: records with their own values, the caller supplies the identifier. */
  const CREATE = WRITE.replace(CHANGES_PROP, `records: { type: array, items: ${ITEM} }`)
    .replace('required: [brand, changes]', 'required: [brand, records]')
    .replace('      ids_arg: skus\n      values_arg: changes\n      fields: [name, description]\n', '      action: create\n      records_arg: records\n      fields: [name, description, brand]\n')
    .replace(NO_SELECTOR, '')
    .replace('rollback: { strategy: replay_previous_state }', 'rollback: { strategy: none }');
  /** A delete: names its targets, takes no values. */
  const DELETE = WRITE.replace('risk: write', 'risk: destructive')
    .replace(`        ${CHANGES_PROP}\n`, '')
    .replace('required: [brand, changes]', 'required: [brand]')
    .replace('      values_arg: changes\n', '      action: delete\n')
    .replace('fields: [name, description]\n', 'fields: [name, description, brand]\n')
    .replace('rollback: { strategy: replay_previous_state }', 'rollback: { strategy: none }');
  /** Two operations in one file; the second is renamed so the role's grant keeps naming the first. */
  const both = (first: string, second: string): string => first + second.replace(HEADER, '').replace('id: catalog.update_content', 'id: catalog.delete_content');
  /** A destructive grant needs an approval step. */
  const DELETE_ROLES = ROLES.replace('approval: { required: never }', 'approval: { required: always, steps: [{ role: content_manager }] }');
  const at = (text: string, path: string): Promise<ConfigIssue> => expectAt(text, path);
  const loadDelete = (text: string): Promise<LoadResult> => load({ 'write.yaml': text, 'roles.yaml': DELETE_ROLES });

  async function expectAt(text: string, path: string): Promise<ConfigIssue> {
    const found = issues(await load({ 'write.yaml': text, 'roles.yaml': DELETE_ROLES }));
    const match = found.filter((i) => i.path === path);
    expect(match, JSON.stringify(found)).toHaveLength(1);
    const [issue] = match;
    if (issue === undefined) throw new Error('unreachable: length checked above');
    return issue;
  }

  it('OPS-2 a create with records_arg and rollback none loads with action create', async () => {
    const config = ok(await load({ 'write.yaml': CREATE }));
    const op = config.policy.operations.find((o) => o.id === 'catalog.update_content');
    expect(op?.manifest).toMatchObject({ action: 'create', recordsArg: 'records', fields: ['name', 'description', 'brand'] });
    expect(op?.manifest).not.toHaveProperty('valuesArg');
  });

  it('OPS-2 an update leaves action off the converted manifest', async () => {
    const config = ok(await load());
    expect(config.policy.operations.find((o) => o.id === 'catalog.update_content')?.manifest).not.toHaveProperty('action');
    const explicit = ok(await load({ 'write.yaml': WRITE.replace('      id_field: sku\n', '      action: update\n      id_field: sku\n') }));
    expect(explicit.policy.operations.find((o) => o.id === 'catalog.update_content')?.manifest).not.toHaveProperty('action');
  });

  it('OPS-2 a delete on a destructive operation with ids_arg loads with action delete and no values', async () => {
    const config = ok(await loadDelete(DELETE));
    const op = config.policy.operations.find((o) => o.id === 'catalog.update_content');
    expect(op?.manifest).toMatchObject({ action: 'delete', idsArg: 'skus' });
    expect(op?.manifest).not.toHaveProperty('valuesArg');
    expect(op?.manifest).not.toHaveProperty('recordsArg');
  });

  it('OPS-2 a create names a delete with the same id_field as its inverse, a delete a create covering its fields', async () => {
    const createInverse = CREATE.replace('rollback: { strategy: none }', 'rollback: { strategy: inverse_operation, operation: catalog.delete_content }');
    const deleteInverse = DELETE.replace('rollback: { strategy: none }', 'rollback: { strategy: inverse_operation, operation: catalog.update_content }');
    ok(await load({ 'write.yaml': both(createInverse, DELETE) }));
    ok(await load({ 'write.yaml': both(CREATE, deleteInverse) }));
    ok(await load({ 'write.yaml': both(createInverse, deleteInverse) }));
  });

  it('OPS-2 a create without records_arg is refused at action', async () => {
    const text = CREATE.replace('      records_arg: records\n', '      ids_arg: skus\n      values_arg: records\n');
    expect((await at(text, `${M}.action`)).message).toBe('action create needs records_arg');
  });

  it('OPS-2 a create with write.carry_fields is refused at write', async () => {
    const text = CREATE.replace('      rollback:', '      write: { carry_fields: [status] }\n      rollback:');
    expect((await at(text, `${M}.write`)).message).toBe('is not allowed with action create');
  });

  it('OPS-2 a create whose scope_args field is not one of fields is refused at scope_args.<arg>', async () => {
    const text = CREATE.replace('fields: [name, description, brand]', 'fields: [name, description]');
    expect((await at(text.replace(', brand: { type: string } }', ' }'), `${M}.scope_args.brand`)).message).toBe('must be one of fields for action create');
  });

  it('OPS-2 a delete with values_arg or records_arg is refused', async () => {
    const withValues = DELETE.replace('      action: delete\n', '      action: delete\n      values_arg: changes\n');
    expect((await at(withValues, `${M}.values_arg`)).message).toBe('is not allowed with action delete');
    const withRecords = DELETE.replace('      action: delete\n', '      action: delete\n      records_arg: records\n');
    expect((await at(withRecords, `${M}.records_arg`)).message).toBe('is not allowed with action delete');
  });

  it('OPS-2 a delete needs ids_arg or selector', async () => {
    const text = DELETE.replace('      ids_arg: skus\n', '').replace(NO_SELECTOR, '');
    expect((await at(text, M)).message).toBe('must declare ids_arg, selector or both');
    ok(await loadDelete(DELETE.replace('      ids_arg: skus\n', '')));
  });

  it('OPS-2 a delete on a write operation is refused at action', async () => {
    const text = DELETE.replace('risk: destructive', 'risk: write');
    expect((await at(text, `${M}.action`)).message).toBe('action delete needs risk destructive');
  });

  it('OPS-2 replay_previous_state is not available for create or delete', async () => {
    const replay = 'rollback: { strategy: replay_previous_state }';
    const c = await at(CREATE.replace('rollback: { strategy: none }', replay), `${M}.rollback.strategy`);
    expect(c.message).toBe('is not available for action create');
    const d = await at(DELETE.replace('rollback: { strategy: none }', replay), `${M}.rollback.strategy`);
    expect(d.message).toBe('is not available for action delete');
  });

  it('OPS-2 the inverse of a create must be an enabled delete operation of the same connection and id_field', async () => {
    const inverse = (op: string): string => CREATE.replace('rollback: { strategy: none }', `rollback: { strategy: inverse_operation, operation: ${op} }`);
    const path = `${M}.rollback.operation`;
    const message = 'must name an enabled delete operation of the same connection with the same id_field';
    // Another create, an update and a missing operation are not deletes.
    const other = WRITE.replace('id: catalog.update_content', 'id: catalog.other_update');
    expect((await at(both(inverse('catalog.other_update'), other), path)).message).toBe(message);
    expect((await at(both(inverse('catalog.other_update'), CREATE.replace('id: catalog.update_content', 'id: catalog.other_update')), path)).message).toBe(message);
    expect((await at(inverse('catalog.gone'), path)).message).toBe(message);
    // A delete with another id_field.
    const otherKey = DELETE.replace('id_field: sku', 'id_field: brand');
    expect((await at(both(inverse('catalog.delete_content'), otherKey), path)).message).toBe(message);
  });

  it('OPS-3 the inverse of an update must be an update operation', async () => {
    const updateInverse = WRITE.replace('rollback: { strategy: replay_previous_state }', 'rollback: { strategy: inverse_operation, operation: catalog.delete_content }');
    const path = `${M}.rollback.operation`;
    const message = 'must name an update operation';
    expect((await at(both(updateInverse, CREATE), path)).message).toBe(message);
    expect((await at(both(updateInverse, DELETE), path)).message).toBe(message);
    // Another update operation still loads.
    ok(await load({ 'write.yaml': both(updateInverse, WRITE) }));
  });

  it('OPS-2 the inverse of a delete must be a create whose fields cover its fields', async () => {
    const inverse = (text: string): string => DELETE.replace('rollback: { strategy: none }', 'rollback: { strategy: inverse_operation, operation: catalog.update_content }').replace('fields: [name, description, brand]', text);
    const message = 'must name an enabled create operation of the same connection whose manifest lists every field of this one';
    const text = both(CREATE, inverse('fields: [name, description, brand, status]'));
    expect((await at(text, 'operations[1].manifest.rollback.operation')).message).toBe(message);
    // An update is not a create.
    expect((await at(both(WRITE, inverse('fields: [name, description, brand]')), 'operations[1].manifest.rollback.operation')).message).toBe(message);
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

  // A second write operation on the same connection, to serve as the inverse.
  const withInverse = (inverseEdit: (t: string) => string) => {
    const [, body = ''] = WRITE.split('operations:\n');
    const second = inverseEdit(body.replace('catalog.update_content', 'catalog.revert_content').replace('{ strategy: replay_previous_state }', '{ strategy: none }'));
    return WRITE.replace('{ strategy: replay_previous_state }', '{ strategy: inverse_operation, operation: catalog.revert_content }') + second;
  };

  it('OPS-3 check 7: inverse_operation accepts a matching id_field and field list', async () => {
    ok(await load({ 'write.yaml': withInverse((t) => t) }));
  });

  it('OPS-3 check 7: inverse_operation needs the same id_field', async () => {
    const found = issues(await load({ 'write.yaml': withInverse((t) => t.replace('id_field: sku', 'id_field: brand')) }));
    expect(found).toEqual([expect.objectContaining({ path: `${M}.rollback.operation`, message: 'must name an operation with the same id_field' })]);
  });

  it('OPS-3 check 7: inverse_operation lists every field of the original', async () => {
    const found = issues(await load({ 'write.yaml': withInverse((t) => t.replace('fields: [name, description]', 'fields: [name]').replace(', description: { type: string }', '')) }));
    expect(found).toEqual([expect.objectContaining({ path: `${M}.rollback.operation`, message: 'must name an operation whose manifest lists every field of this one' })]);
  });

  it('OPS-3 check 7: inverse_operation names an enabled write operation on the same connection', async () => {
    const edit = (target: string) => (t: string) => t.replace('{ strategy: replay_previous_state }', `{ strategy: inverse_operation, operation: ${target} }`);
    await expectIssue(edit('catalog.get_products_by_sku'), `${M}.rollback.operation`, 'get_products_by_sku');
    await expectIssue(edit('catalog.missing_inverse'), `${M}.rollback.operation`, 'missing_inverse');
  });
});

describe('CS-6 change-set expiry setting', () => {
  it('CS-6 defaults expireAfterHours to 72', async () => {
    expect(ok(await load()).changesets).toEqual({ expireAfterHours: 72, failureThreshold: 0.5, itemsPerWorkflowRun: 2000, rollbackWindowHours: 168 });
  });

  it('CS-6 expire_after_hours accepts one minute and refuses less', async () => {
    const withHours = (h: string) => load({ 'changesets.yaml': `version: 1\nchangesets: { expire_after_hours: ${h} }\n` });
    expect(ok(await withHours(String(1 / 60))).changesets.expireAfterHours).toBe(1 / 60);
    for (const bad of ['0.01', '0']) {
      expect(issues(await withHours(bad)), bad).toEqual([expect.objectContaining({ path: 'changesets.expire_after_hours' })]);
    }
  });

  it('EXE-8 NFR-18 changesets.rollback_window_hours defaults to 168 and accepts 0', async () => {
    expect(ok(await load()).changesets.rollbackWindowHours).toBe(168);
    const withWindow = (h: string) => load({ 'changesets.yaml': `version: 1\nchangesets: { rollback_window_hours: ${h} }\n` });
    expect(ok(await withWindow('0')).changesets.rollbackWindowHours).toBe(0);
    for (const bad of ['2161', '-1']) {
      expect(issues(await withWindow(bad)), bad).toEqual([expect.objectContaining({ path: 'changesets.rollback_window_hours' })]);
    }
  });

  it('CS-6 reads changesets.expire_after_hours and checks its range', async () => {
    expect(ok(await load({ 'changesets.yaml': 'version: 1\nchangesets: { expire_after_hours: 24 }\n' })).changesets).toEqual({ expireAfterHours: 24, failureThreshold: 0.5, itemsPerWorkflowRun: 2000, rollbackWindowHours: 168 });
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

const BULK_BLOCK = `
      bulk:
        body:
          wrap: product
          nest: { path: custom_attributes, key: attribute_code, value: value, keep: [sku, name, status] }
        batch_id: bulk_uuid
        status:
          method: GET
          path: /V1/bulk/{batch_id}/detailed-status
          items: operations_list
          index: id
          state: status
          states: { ok: [1], retriable: [2], failed: [3, 5], open: [4] }`;
const withBulk = (t: string): string =>
  t.replace('upstream: { method: POST, path: /async/bulk/V1/products }', `upstream:\n      method: POST\n      path: /async/bulk/V1/products${BULK_BLOCK}`);
const withCarry = (t: string, fields = 'status'): string => t.replace('      rollback:', `      write: { carry_fields: [${fields}] }\n      rollback:`);
const U = 'operations[0].upstream';

describe('OPS-6 bulk binding configuration', () => {
  it('OPS-6 loads a bulk binding and converts it to the SDK type', async () => {
    const config = ok(await load({ 'write.yaml': withBulk(WRITE) }));
    expect(httpBinding(config, 'catalog.update_content').mapping.bulk).toEqual({
      body: { wrap: 'product', nest: { path: 'custom_attributes', key: 'attribute_code', value: 'value', keep: ['sku', 'name', 'status'] } },
      batchId: 'bulk_uuid',
      status: {
        method: 'GET',
        path: '/V1/bulk/{batch_id}/detailed-status',
        items: 'operations_list',
        index: 'id',
        state: 'status',
        states: { ok: [1], retriable: [2], failed: [3, 5], open: [4] },
      },
    });
  });
  it('OPS-6 a destructive operation with a manifest can have bulk', async () => {
    const destructive = withBulk(WRITE).replace('risk: write', 'risk: destructive');
    ok(await load({ 'write.yaml': destructive, 'roles.yaml': ROLES.replace('{ required: never }', '{ required: never, steps: [{ role: content_manager }] }') }));
  });
  it('EXE-4 idempotency is refused on a write operation with a manifest', async () => {
    const text = WRITE.replace('upstream: { method: POST, path: /async/bulk/V1/products }', 'upstream: { method: POST, path: /async/bulk/V1/products, idempotency: { header: Idempotency-Key } }');
    const found = issues(await load({ 'write.yaml': text }));
    expect(found).toEqual([
      expect.objectContaining({ path: 'operations[0].upstream.idempotency', message: 'is allowed only on write_opaque operations and destructive operations without a manifest' }),
    ]);
  });
  it('OPS-6 a write operation without bulk still loads (Phase 4 configuration stays valid)', async () => {
    expect(httpBinding(ok(await load()), 'catalog.update_content').mapping.bulk).toBeUndefined();
  });
  it('OPS-6 CFG-2 status path without {batch_id} is located', () =>
    expectIssue((t) => withBulk(t).replace('/V1/bulk/{batch_id}/detailed-status', '/V1/bulk/{uuid}/detailed-status'), `${U}.bulk.status.path`, 'uuid'));
  it('OPS-6 CFG-2 status path with an extra placeholder is located', () =>
    expectIssue((t) => withBulk(t).replace('/V1/bulk/{batch_id}/detailed-status', '/V1/{batch_id}/{more}'), `${U}.bulk.status.path`, 'more'));
  it('OPS-6 CFG-2 a state in two lists is located at its later occurrence', () =>
    expectIssue((t) => withBulk(t).replace('failed: [3, 5]', 'failed: [3, 1]'), `${U}.bulk.status.states.failed[1]`, '1'));
  it('OPS-6 states compare by type and value: 1 and "1" are different states', async () => {
    ok(await load({ 'write.yaml': withBulk(WRITE).replace('failed: [3, 5]', "failed: [3, '1']") }));
  });
  it.each([
    ['batch_id', 'bulk.batch_id'],
    ['items', 'bulk.status.items'],
    ['index', 'bulk.status.index'],
    ['state', 'bulk.status.state'],
  ])('OPS-6 CFG-2 an empty path segment in %s is refused', async (key, suffix) => {
    const edited = withBulk(WRITE).replace(new RegExp(`( ${key}): \\w+`), '$1: a..b');
    expect(edited).not.toBe(withBulk(WRITE));
    const found = issues(await load({ 'write.yaml': edited }));
    expect(found.some((i) => i.path === `${U}.${suffix}` && i.message.includes('empty path segments'))).toBe(true);
  });
  it('OPS-6 CFG-2 empty path segments in body.wrap and body.nest.path are refused', async () => {
    const found = issues(await load({ 'write.yaml': withBulk(WRITE).replace('wrap: product', 'wrap: a..b').replace('path: custom_attributes', 'path: a..b') }));
    const paths = found.filter((i) => i.message.includes('empty path segments')).map((i) => i.path);
    expect(paths).toEqual([`${U}.bulk.body.wrap`, `${U}.bulk.body.nest.path`]);
  });
  it('OPS-6 CFG-2 a GET binding with bulk is refused at upstream.method', () =>
    expectIssue((t) => withBulk(t).replace('method: POST', 'method: GET'), `${U}.method`, 'GET'));
  it('OPS-6 CFG-2 bulk on a read operation is refused at upstream.bulk', async () => {
    const reads = READS.replace(
      'upstream: { method: GET, path: /V1/plain, query: { skus: { arg: skus } } }',
      `upstream:\n      method: GET\n      path: /V1/plain${BULK_BLOCK}`,
    );
    const found = issues(await load({ 'reads.yaml': reads }));
    const hit = found.filter((i) => i.path === 'operations[3].upstream.bulk');
    expect(hit).toHaveLength(1);
    expect(hit[0]?.message).toBe('is allowed on write and destructive operations only');
  });
  it('OPS-6 CFG-2 body together with bulk is refused at upstream.body', () =>
    expectIssue((t) => withBulk(t).replace('      path: /async/bulk/V1/products\n', '      path: /async/bulk/V1/products\n      body: { arg: changes }\n'), `${U}.body`, 'changes'));
  it('OPS-6 CFG-2 an argument template in a bulk binding is refused at its path', () =>
    expectIssue((t) => withBulk(t).replace('      path: /async/bulk/V1/products\n', '      path: /async/bulk/V1/products\n      query: { brand: { arg: brand } }\n'), `${U}.query.brand`, 'brand'));
  it('OPS-6 CFG-2 unknown keys inside bulk are refused', async () => {
    const found = issues(await load({ 'write.yaml': withBulk(WRITE).replace('batch_id: bulk_uuid', 'batch_id: bulk_uuid\n        extra: 1') }));
    expect(found.length).toBeGreaterThan(0);
  });
});

describe('OPS-6 manifest write.carry_fields', () => {
  it('OPS-6 converts carry_fields to write.carryFields', async () => {
    const config = ok(await load({ 'write.yaml': withCarry(WRITE) }));
    expect(config.policy.operations.find((o) => o.id === 'catalog.update_content')?.manifest).toMatchObject({ write: { carryFields: ['status'] } });
  });
  it('OPS-6 CFG-2 a carry field the read operation cannot return is located', () =>
    expectIssue((t) => withCarry(t, 'colour'), `${M}.write.carry_fields[0]`, 'colour'));
  it('OPS-6 CFG-2 a carry field that is a diff field is located', async () => {
    const issue = await expectIssue((t) => withCarry(t, 'name'), `${M}.write.carry_fields[0]`, 'name');
    expect(issue.message).toBe('must not be one of fields');
  });
  it('OPS-6 an empty carry_fields list is refused by the schema', async () => {
    const found = issues(await load({ 'write.yaml': withCarry(WRITE, '') }));
    expect(found.some((i) => i.path === `${M}.write.carry_fields`)).toBe(true);
  });
});

describe('CFG-2 POL-5 approval steps for write grants', () => {
  const roles = (approval?: string): string => ROLES.replace('    approval: { required: never }\n', approval === undefined ? '' : `    approval: ${approval}\n`);
  const needs = expect.stringMatching(/^needs at least one step/) as string;

  it('POL-5 a write grant whose approval is required by default needs steps', async () => {
    const none = issues(await load({ 'roles.yaml': roles() }));
    expect(none).toContainEqual(expect.objectContaining({ path: 'roles[0].approval', message: needs }));
    const always = issues(await load({ 'roles.yaml': roles('{ required: always }') }));
    expect(always).toContainEqual(expect.objectContaining({ path: 'roles[0].approval.steps', message: needs }));
    ok(await load({ 'roles.yaml': roles('{ required: never }') }));
  });

  it('POL-5 a destructive grant needs steps even with required: never', async () => {
    const found = issues(await load({ 'write.yaml': WRITE.replace('risk: write', 'risk: destructive'), 'roles.yaml': roles('{ required: never }') }));
    expect(found).toContainEqual(expect.objectContaining({ path: 'roles[0].approval.steps', message: needs }));
  });
});

describe('AUD-4 manifest sensitive_fields', () => {
  const withSensitive = (t: string, fields: string): string => t.replace('      rollback:', `      sensitive_fields: [${fields}]\n      rollback:`);
  it('AUD-4 sensitive_fields entries must be manifest fields', async () => {
    const issue = await expectIssue((t) => withSensitive(t, 'colour'), `${M}.sensitive_fields[0]`, 'colour');
    expect(issue.message).toBe('must be one of fields');
  });
  it('AUD-4 sensitiveFields is the union of the manifests sensitive_fields', async () => {
    const plain = ok(await load());
    expect(plain.sensitiveFields.size).toBe(0);
    const config = ok(await load({ 'write.yaml': withSensitive(WRITE, 'description') }));
    expect([...config.sensitiveFields]).toEqual(['description']);
  });
});

describe('CS-3 manifest checks', () => {
  const withChecks = (t: string, checks: string): string => t.replace('      rollback:', `      checks:\n${checks}      rollback:`);
  const check = (require: string, code = 'locked'): string => `        - { code: ${code}, require: [${require}] }\n`;
  const C = `${M}.checks`;

  it('CS-3 converts checks to the core type; a manifest without checks has none', async () => {
    const text = withChecks(
      WRITE,
      '        - code: locked\n' +
        '          title: Note is locked\n' +
        '          require:\n' +
        '            - { equals: [{ record: status }, { value: null }] }\n' +
        '            - { present: { after: name } }\n' +
        '            - { absent: { before: description } }\n' +
        '        - { code: brand_known, require: [{ in: { arg: brand }, values: [acme, 1, true] }, { equals: [{ after: name }, { record: name }] }] }\n',
    );
    const config = ok(await load({ 'write.yaml': text }));
    expect(config.policy.operations.find((o) => o.id === 'catalog.update_content')?.manifest?.checks).toEqual([
      {
        code: 'locked',
        title: 'Note is locked',
        require: [{ equals: [{ record: 'status' }, { value: null }] }, { present: { after: 'name' } }, { absent: { before: 'description' } }],
      },
      { code: 'brand_known', require: [{ in: { arg: 'brand' }, values: ['acme', 1, true] }, { equals: [{ after: 'name' }, { record: 'name' }] }] },
    ]);
    const plain = ok(await load());
    expect(plain.policy.operations.find((o) => o.id === 'catalog.update_content')?.manifest).not.toHaveProperty('checks');
  });

  it('CS-3 at most 20 checks', async () => {
    const many = (n: number): string => Array.from({ length: n }, (_, i) => check('{ present: { after: name } }', `c${String(i)}`)).join('');
    ok(await load({ 'write.yaml': withChecks(WRITE, many(20)) }));
    await expectIssue((t) => withChecks(t, many(21)), C, 'c20');
  });

  it('CS-3 a code matches ^[a-z][a-z0-9_]{0,62}$', async () => {
    ok(await load({ 'write.yaml': withChecks(WRITE, check('{ present: { after: name } }', `a${'b'.repeat(62)}`)) }));
    for (const code of ['Locked', '1locked', 'lock-ed', `a${'b'.repeat(63)}`]) {
      await expectIssue((t) => withChecks(t, check('{ present: { after: name } }', code)), `${C}[0].code`, code);
    }
  });

  it('CS-3 a code is not a built-in reason', async () => {
    for (const code of ['not_found', 'out_of_scope', 'missing_data', 'no_change', 'already_exists', 'requester']) {
      const issue = await expectIssue((t) => withChecks(t, check('{ present: { after: name } }', code)), `${C}[0].code`, code);
      expect(issue.message).toBe('must not be a built-in exclusion reason');
    }
  });

  it('CS-3 a code is not an Object.prototype member name', async () => {
    // Of the member names only `constructor` matches the pattern; `valueOf` and the like fail it.
    const issue = await expectIssue((t) => withChecks(t, check('{ present: { after: name } }', 'constructor')), `${C}[0].code`, 'constructor');
    expect(issue.message).toBe('must not be a reserved name');
    await expectIssue((t) => withChecks(t, check('{ present: { after: name } }', 'valueOf')), `${C}[0].code`, 'valueOf');
  });

  it('CS-3 codes are unique', async () => {
    const issue = await expectIssue((t) => withChecks(t, check('{ present: { after: name } }') + check('{ absent: { after: name } }')), `${C}[1].code`, 'locked');
    expect(issue.message).toBe('must be unique among the checks');
  });

  it('CS-3 a title has 1 to 120 characters', async () => {
    const titled = (title: string): string => `        - { code: locked, title: "${title}", require: [{ present: { after: name } }] }\n`;
    ok(await load({ 'write.yaml': withChecks(WRITE, titled('t'.repeat(120))) }));
    await expectIssue((t) => withChecks(t, titled('')), `${C}[0].title`, 'locked');
    await expectIssue((t) => withChecks(t, titled('t'.repeat(121))), `${C}[0].title`, 'ttt');
  });

  it('CS-3 require has 1 to 10 predicates', async () => {
    const preds = (n: number): string => Array.from({ length: n }, () => '{ present: { after: name } }').join(', ');
    ok(await load({ 'write.yaml': withChecks(WRITE, check(preds(10))) }));
    await expectIssue((t) => withChecks(t, check('')), `${C}[0].require`, 'locked');
    await expectIssue((t) => withChecks(t, check(preds(11))), `${C}[0].require`, 'locked');
  });

  it('CS-3 in comes with 1 to 100 literal values', async () => {
    const values = (n: number): string => Array.from({ length: n }, (_, i) => String(i)).join(', ');
    ok(await load({ 'write.yaml': withChecks(WRITE, check(`{ in: { record: status }, values: [${values(100)}] }`)) }));
    await expectIssue((t) => withChecks(t, check('{ in: { record: status }, values: [] }')), `${C}[0].require[0].values`, 'status');
    await expectIssue((t) => withChecks(t, check(`{ in: { record: status }, values: [${values(101)}] }`)), `${C}[0].require[0]`, 'status');
    await expectIssue((t) => withChecks(t, check('{ in: { record: status }, values: [null] }')), `${C}[0].require[0]`, 'status');
    await expectIssue((t) => withChecks(t, check('{ in: { record: status } }')), `${C}[0].require[0]`, 'status');
    await expectIssue((t) => withChecks(t, check('{ present: { record: status }, values: [1] }')), `${C}[0].require[0]`, 'status');
  });

  it('CS-3 a predicate object has exactly one predicate key', async () => {
    await expectIssue((t) => withChecks(t, check('{ present: { after: name }, absent: { after: description } }')), `${C}[0].require[0]`, 'name');
    await expectIssue((t) => withChecks(t, check('{ matches: { after: name } }')), `${C}[0].require[0]`, 'matches');
    await expectIssue((t) => withChecks(t, check('{}')), `${C}[0].require[0]`, 'locked');
  });

  it('CS-3 a record field must be one the read operation can return', async () => {
    const issue = await expectIssue((t) => withChecks(t, check('{ present: { record: colour } }')), `${C}[0].require[0].present.record`, 'colour');
    expect(issue.message).toBe('is not a field operation catalog.get_products_by_sku can return');
    await expectIssue((t) => withChecks(t, check('{ equals: [{ after: name }, { record: colour }] }')), `${C}[0].require[0].equals[1].record`, 'colour');
    await expectIssue((t) => withChecks(t, check('{ in: { record: colour }, values: [1] }')), `${C}[0].require[0].in.record`, 'colour');
    // Without an enum on the read's field list nothing is checked.
    ok(await load({ 'reads.yaml': READS.replace(`items: { enum: ${FIELD_ENUM} }`, 'items: { type: string }'), 'write.yaml': withChecks(WRITE, check('{ present: { record: colour } }')) }));
  });

  it('CS-3 after and before name one of fields', async () => {
    const after = await expectIssue((t) => withChecks(t, check('{ present: { after: price } }')), `${C}[0].require[0].present.after`, 'price');
    expect(after.message).toBe('must be one of fields');
    await expectIssue((t) => withChecks(t, check('{ absent: { before: price } }')), `${C}[0].require[0].absent.before`, 'price');
  });

  it('CS-3 an arg names a property of input_schema', async () => {
    const issue = await expectIssue((t) => withChecks(t, check('{ equals: [{ arg: store }, { value: 1 }] }')), `${C}[0].require[0].equals[0].arg`, 'store');
    expect(issue.message).toBe('is not a property of input_schema');
    ok(await load({ 'write.yaml': withChecks(WRITE, check('{ equals: [{ arg: brand }, { value: acme }] }')) }));
  });

  it('CS-3 OPS-7 lookup references, found and not_found name a declared lookup', async () => {
    const ref = await expectIssue((t) => withChecks(t, check('{ present: { lookup: erp, field: cost } }')), `${C}[0].require[0].present.lookup`, 'erp');
    expect(ref.message).toBe('is not a declared lookup');
    await expectIssue((t) => withChecks(t, check('{ found: erp }')), `${C}[0].require[0].found`, 'erp');
    await expectIssue((t) => withChecks(t, check('{ not_found: erp }')), `${C}[0].require[0].not_found`, 'erp');
  });
});
