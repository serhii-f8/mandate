// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Mandate Authors
import { describe, expect, it } from 'vitest';
import { loadConfigurationSources, type LoadedConfiguration } from '@mandate/config';
import { hashStoredItems, type ApprovalRecord, type ChangeSetRecord } from '@mandate/core';
import { InMemoryAuditLog } from '@mandate/testing';
import { createExecutionGuard } from './guard.js';

const FILES = {
  'connections.yaml': `version: 1
connections:
  - { id: magento, adapter: openapi, base_url: https://shop.example.test/rest, credential_ref: magento-integration, auth: { scheme: bearer } }
`,
  'operations.yaml': `version: 1
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
`,
};

async function configuration(editorApproval: string): Promise<LoadedConfiguration> {
  const roles = `version: 1
roles:
  - id: editor
    grants:
      - { operation: catalog.update }
    approval: ${editorApproval}
  - id: content_lead
    grants: []
  - id: pricing_owner
    grants: []
role_mapping:
  - { group: content, roles: [editor] }
`;
  const loaded = await loadConfigurationSources(Object.entries({ ...FILES, 'roles.yaml': roles }).map(([file, text]) => ({ file, text })));
  if (!loaded.ok) throw new Error(JSON.stringify(loaded.issues));
  return loaded.configuration;
}

const A = await configuration('{ required: always, steps: [{ role: content_lead }] }');
const B = await configuration('{ required: always, steps: [{ role: content_lead }], field_rules: [{ fields: [price], required: always, steps: [{ role: pricing_owner }] }] }');

const NOW = new Date('2026-11-22T10:00:00.000Z');
const noItems = { itemsPage: () => Promise.resolve([]) };

async function record(args: Record<string, unknown>): Promise<ChangeSetRecord> {
  const base = { id: 'cs-1', operation: 'catalog.update', args };
  return {
    ...base,
    connection: 'magento',
    requester: 'alice',
    hash: await hashStoredItems(noItems, base),
    status: 'approved',
    stats: { total: 0, included: 1, excluded: {}, written: 0, skipped: 0, failed: 0 },
    configHash: 'h',
    correlationId: 'c',
    createdAt: NOW,
    expiresAt: NOW,
    approvalRound: 1,
    executionRequest: { actor: 'alice', groups: ['content'], correlationId: 'c', startedAt: NOW },
  };
}

function approvedBy(role: string, hash: string): ApprovalRecord {
  return { id: 'ap-1', changesetId: 'cs-1', round: 1, step: 1, role, approver: 'dave', decision: 'approved', hash, itemCount: 1, channel: 'page', correlationId: 'c', ts: NOW };
}

describe('POL-5 POL-6 execution guard routes approval per touched field', () => {
  it('POL-5 an approval by content_lead holds under configuration A and fails under B once price is touched', async () => {
    const changeset = await record({ skus: ['a'], changes: { name: 'N', price: '9' } });
    const hash = changeset.hash ?? '';
    const repository = { ...noItems, approvals: () => Promise.resolve([approvedBy('content_lead', hash)]) };
    const guardFor = createExecutionGuard({ repository, audit: new InMemoryAuditLog(), newId: () => 'id' });
    expect(await guardFor(A).check(changeset)).toEqual({ ok: true });
    expect(await guardFor(B).check(changeset)).toEqual({ ok: false, outcome: 'approval_missing' });
  });

  it('POL-5 a change-set that does not touch price keeps the role steps under B', async () => {
    const changeset = await record({ skus: ['a'], changes: { name: 'N' } });
    const repository = { ...noItems, approvals: () => Promise.resolve([approvedBy('content_lead', changeset.hash ?? '')]) };
    const guardFor = createExecutionGuard({ repository, audit: new InMemoryAuditLog(), newId: () => 'id' });
    expect(await guardFor(B).check(changeset)).toEqual({ ok: true });
  });
});
