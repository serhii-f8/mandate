import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';
import { configDocumentSchema, schemaIssues } from './schema.js';

export const FULL_EXAMPLE = `
version: 1
connections:
  - id: magento
    adapter: openapi
    base_url: https://shop.example.test/rest
    credential_ref: magento-integration
    preset: magento2-catalog
operations:
  - id: catalog.search_products
    connection: magento
    risk: read
    title: Search products
    description: Search the catalog by brand.
    upstream: { method: GET, path: /V1/products }
    input_schema:
      type: object
      properties: { brand: { type: string }, fields: { type: array, items: { type: string } } }
      required: [brand, fields]
      additionalProperties: false
    fields_arg: fields
roles:
  - id: content_manager
    description: Edits product content.
    grants:
      - operation: catalog.search_products
        id: own-brands
        scope: { brand: [acme, globex] }
        deny_fields: [cost]
        allow_fields: [name, description, cost]
    limits: { records_per_operation: 500, records_per_day: 5000, calls_per_minute: 60, concurrent_executions: 2 }
    approval: { required: above_threshold, record_threshold: 50, approver_role: content_lead, allow_widget: false }
  - id: content_lead
    grants: []
role_mapping:
  - group: content
    roles: [content_manager]
presets:
  - id: magento2-catalog
    package: "@aiops/preset-magento2-catalog"
    version: "^0.1.0"
notifications:
  - id: ops-email
    kind: email
    to: [ops@example.test]
  - id: ops-chat
    kind: webhook
    url_credential_ref: ops-chat-webhook
`;

function issuesOf(yaml: string) {
  return schemaIssues(configDocumentSchema.safeParse(parse(yaml)));
}

describe('CFG-1 configuration document schema', () => {
  it('accepts the full example', () => {
    const result = configDocumentSchema.safeParse(parse(FULL_EXAMPLE));
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.roles?.[0]?.grants[0]?.deny_fields).toEqual(['cost']);
      expect(result.data.roles?.[0]?.approval?.allow_widget).toBe(false);
    }
  });

  it('accepts a document with only a version', () => {
    expect(issuesOf('version: 1')).toEqual([]);
  });

  it('rejects an unknown key and names it', () => {
    const issues = issuesOf('version: 1\nconnections:\n  - { id: m, adapter: openapi, base_url: https://x.test, credential_ref: c, passwrd: x }\n');
    expect(issues).toHaveLength(1);
    expect(issues[0]?.path).toEqual(['connections', 0]);
    expect(issues[0]?.message).toContain('passwrd');
  });

  it('rejects an unsupported version', () => {
    expect(issuesOf('version: 2')[0]?.path).toEqual(['version']);
  });

  it('requires a version', () => {
    expect(issuesOf('roles: []')[0]).toMatchObject({ path: ['version'], message: 'is required' });
  });

  it('reports a bad enum value without echoing it', () => {
    const issues = issuesOf(
      'version: 1\noperations:\n  - { id: a.b, connection: m, risk: maybe-later, description: d, upstream: {}, input_schema: { type: object } }\n',
    );
    expect(issues[0]?.path).toEqual(['operations', 0, 'risk']);
    expect(issues[0]?.message).not.toContain('maybe-later');
  });

  it('requires base_url for openapi and mcp_url for mcp connections', () => {
    expect(issuesOf('version: 1\nconnections:\n  - { id: m, adapter: openapi, credential_ref: c }\n')[0]?.path).toEqual(['connections', 0, 'base_url']);
    expect(issuesOf('version: 1\nconnections:\n  - { id: m, adapter: mcp, mcp_url: https://x.test/mcp, credential_ref: c }\n')).toEqual([]);
  });

  it('rejects an operation ID that is not a valid tool name', () => {
    expect(
      issuesOf('version: 1\noperations:\n  - { id: Bad Name, connection: m, risk: read, description: d, upstream: {}, input_schema: { type: object } }\n')[0]
        ?.path,
    ).toEqual(['operations', 0, 'id']);
  });
});
