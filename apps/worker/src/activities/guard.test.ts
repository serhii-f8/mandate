// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Mandate Authors
import { describe, expect, it } from 'vitest';
import { loadConfigurationSources, type LoadedConfiguration } from '@mandate/config';
import { hashStoredItems, type ApprovalRecord, type ChangeSetRecord, type HashVersion } from '@mandate/core';
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

async function configuration(editorApproval: string, grants = '      - { operation: catalog.update }'): Promise<LoadedConfiguration> {
  const roles = `version: 1
roles:
  - id: editor
    grants:
${grants}
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

const ROLE_RULE = '{ required: always, steps: [{ role: content_lead }] }';
const GRANT_RULE = 'approval: { required: always, steps: [{ role: pricing_owner }] }';
/** The update grant is the second one and has no ID: its rule reference is role:editor/grant:1. */
const BY_INDEX = await configuration(ROLE_RULE, `      - { operation: catalog.get_products }\n      - { operation: catalog.update, ${GRANT_RULE} }`);
const BY_ID = await configuration(ROLE_RULE, `      - { operation: catalog.update, id: prices, ${GRANT_RULE} }`);

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

  it('POL-5 unreadable touched fields under field rules fail the approval check, however many approvals exist', async () => {
    const changeset = await record({ skus: ['a'], changes: 'price' });
    const hash = changeset.hash ?? '';
    const repository = { ...noItems, approvals: () => Promise.resolve([approvedBy('content_lead', hash), approvedBy('pricing_owner', hash)]) };
    const guardFor = createExecutionGuard({ repository, audit: new InMemoryAuditLog(), newId: () => 'id' });
    expect(await guardFor(B).check(changeset)).toEqual({ ok: false, outcome: 'approval_missing' });
    expect(await guardFor(A).check(changeset)).toEqual({ ok: true });
  });
});

describe('CS-4 POL-6 execution guard recomputes the hash with the stored version', () => {
  const approvedRepository = (hash: string) => ({ ...noItems, approvals: () => Promise.resolve([approvedBy('content_lead', hash)]) });

  it('CS-4 a version 2 change-set verifies against its version 2 hash', async () => {
    const base = await record({ skus: ['a'], changes: { name: 'N' } });
    const sealed = { ...base, hashVersion: 2 as const, action: 'update' as const };
    const v2 = { ...sealed, hash: await hashStoredItems(noItems, sealed) };
    expect(v2.hash).not.toBe(base.hash);
    const guardFor = createExecutionGuard({ repository: approvedRepository(v2.hash), audit: new InMemoryAuditLog(), newId: () => 'id' });
    expect(await guardFor(A).check(v2)).toEqual({ ok: true });
    // The version 1 hash no longer matches a change-set stored as version 2.
    expect(await guardFor(A).check({ ...v2, hash: base.hash ?? '' })).toEqual({ ok: false, outcome: 'hash_mismatch' });
  });

  it('CS-4 an unknown hash version is answered hash_mismatch', async () => {
    const base = await record({ skus: ['a'], changes: { name: 'N' } });
    // A row from a newer release: the type does not admit 3, the database column does.
    const newer = { ...base, hashVersion: 3 as HashVersion };
    const guardFor = createExecutionGuard({ repository: approvedRepository(base.hash ?? ''), audit: new InMemoryAuditLog(), newId: () => 'id' });
    expect(await guardFor(A).check(newer)).toEqual({ ok: false, outcome: 'hash_mismatch' });
  });
});

describe('POL-5 POL-6 execution guard routes approval per grant', () => {
  it('POL-5 the grant approval decides the steps, keyed by grant index and by grant ID through the policy engine', async () => {
    const changeset = await record({ skus: ['a'], changes: { name: 'N' } });
    const hash = changeset.hash ?? '';
    for (const configuration of [BY_INDEX, BY_ID]) {
      const guardWith = (role: string) =>
        createExecutionGuard({ repository: { ...noItems, approvals: () => Promise.resolve([approvedBy(role, hash)]) }, audit: new InMemoryAuditLog(), newId: () => 'id' })(configuration);
      expect(await guardWith('content_lead').check(changeset)).toEqual({ ok: false, outcome: 'approval_missing' });
      expect(await guardWith('pricing_owner').check(changeset)).toEqual({ ok: true });
    }
  });
});
