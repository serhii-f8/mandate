/**
 * A loaded configuration for worker tests: one connection, the read operation
 * `catalog.get_products`, the write operation `catalog.update_content` with a manifest
 * (batch size 2), and the role `editor` granted to the group `editors`.
 */
import { loadConfigurationSources, type LoadedConfiguration } from '@aiops/config';

export const WRITE_OPERATION = 'catalog.update_content';
export const READ_OPERATION = 'catalog.get_products';
export const EDITOR_GROUP = 'editors';

const SOURCES: Readonly<Record<string, string>> = {
  'connections.yaml': `version: 1
connections:
  - { id: magento, adapter: openapi, base_url: https://shop.example.test/rest, credential_ref: magento-integration, auth: { scheme: bearer } }
`,
  'operations.yaml': `version: 1
changesets: { expire_after_hours: 10, failure_threshold: 0.5, items_per_workflow_run: 100 }
operations:
  - id: catalog.get_products
    connection: magento
    risk: read
    description: Products by SKU.
    upstream: { method: GET, path: /V1/products, query: { skus: { arg: skus, join: ',' }, brand: { arg: brand } }, response: { items: items, fields_from_arg: fields } }
    input_schema:
      type: object
      properties: { skus: { type: array, items: { type: string } }, brand: { type: string }, fields: { type: array, items: { type: string } } }
      required: [skus, fields]
    fields_arg: fields
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
        changes: { type: object, properties: { name: { type: string }, description: { type: string } }, additionalProperties: false }
      required: [brand, changes]
    manifest:
      id_field: sku
      ids_arg: skus
      values_arg: changes
      fields: [name, description]
      scope_args: { brand: brand }
      read_before:
        operation: catalog.get_products
        ids_arg: skus
        args: { brand: { arg: brand } }
      batch_size: 2
      rollback: { strategy: replay_previous_state }
`,
  'roles.yaml': `version: 1
roles:
  - id: editor
    grants:
      - operation: catalog.update_content
        scope: { brand: [acme] }
role_mapping:
  - group: editors
    roles: [editor]
`,
};

export async function testConfiguration(): Promise<LoadedConfiguration> {
  const loaded = await loadConfigurationSources(Object.entries(SOURCES).map(([file, text]) => ({ file, text })));
  if (!loaded.ok) throw new Error(`test configuration invalid: ${JSON.stringify(loaded.issues)}`);
  return loaded.configuration;
}
