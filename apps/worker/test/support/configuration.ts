// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Mandate Authors
/**
 * A loaded configuration for worker tests: one connection, the read operation
 * `catalog.get_products`, the write operation `catalog.update_content` with a manifest
 * (batch size 2), the role `editor` granted to the group `editors` (no approval), the role
 * `approving_editor` granted to `approving-editors` (approval always, one `reviewer` step) and
 * the role `reviewer` granted to `reviewers` (no grants). The opaque operation `catalog.notify_team`
 * (`write_opaque`, one `POST /V1/notes`) is granted to `editor` and `approving_editor`.
 */
import { loadConfigurationSources, type LoadedConfiguration } from '@mandate/config';

export const WRITE_OPERATION = 'catalog.update_content';
export const READ_OPERATION = 'catalog.get_products';
/** A `write_opaque` operation: one call, no manifest (design phase 9 §2). */
export const OPAQUE_OPERATION = 'catalog.notify_team';
export const EDITOR_GROUP = 'editors';
export const APPROVING_GROUP = 'approving-editors';
export const REVIEWER_GROUP = 'reviewers';

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
  - id: catalog.notify_team
    connection: magento
    risk: write_opaque
    description: Send a note to the catalog team.
    upstream: { method: POST, path: /V1/notes, body: { arg: note } }
    input_schema:
      type: object
      properties: { note: { type: string } }
      required: [note]
`,
  'roles.yaml': `version: 1
roles:
  - id: editor
    grants:
      - operation: catalog.update_content
        scope: { brand: [acme] }
      - operation: catalog.notify_team
    approval: { required: never }
  - id: approving_editor
    grants:
      - operation: catalog.update_content
        scope: { brand: [acme] }
      - operation: catalog.notify_team
    approval: { required: always, steps: [{ role: reviewer }] }
  - id: reviewer
    grants: []
role_mapping:
  - group: editors
    roles: [editor]
  - group: approving-editors
    roles: [approving_editor]
  - group: reviewers
    roles: [reviewer]
`,
};

export async function testConfiguration(): Promise<LoadedConfiguration> {
  const loaded = await loadConfigurationSources(Object.entries(SOURCES).map(([file, text]) => ({ file, text })));
  if (!loaded.ok) throw new Error(`test configuration invalid: ${JSON.stringify(loaded.issues)}`);
  return loaded.configuration;
}
