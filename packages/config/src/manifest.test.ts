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
