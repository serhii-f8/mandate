import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';
import { configDocumentSchema, schemaIssues } from './schema.js';
import { changesetsSchema } from './manifest.js';

export const FULL_EXAMPLE = `
version: 1
connections:
  - id: magento
    adapter: openapi
    base_url: https://shop.example.test/rest
    credential_ref: magento-integration
    preset: magento2-catalog
    auth: { scheme: oauth_client_credentials, token_url: https://idp.example.test/token, scopes: [catalog] }
    openapi: { spec: specs/shop.json, include: [catalogProductRepositoryV1GetListGet, "GET /V1/orders"] }
    timeout_ms: 5000
    retry: { max_attempts: 2, initial_backoff_ms: 100 }
    max_concurrency: 2
    allow_private_network: true
    test: { operation: catalog.search_products, args: { brand: acme, fields: [sku] } }
operations:
  - id: catalog.search_products
    connection: magento
    risk: read
    title: Search products
    description: Search the catalog by brand.
    upstream:
      method: GET
      path: /V1/products
      query:
        "searchCriteria[filter_groups][0][filters][0][field]": brand
        "searchCriteria[filter_groups][0][filters][0][value]": { arg: brand }
        "searchCriteria[pageSize]": { arg: page_size, default: 20 }
      response:
        items: items
        total: total_count
        flatten: { path: custom_attributes, key: attribute_code, value: value }
        fields_from_arg: fields
        max_items: 100
    input_schema:
      type: object
      properties: { brand: { type: string }, page_size: { type: integer }, fields: { type: array, items: { type: string } } }
      required: [brand, fields]
      additionalProperties: false
    fields_arg: fields
overrides:
  - { operation: catalog.search_products, tool_name: catalog.find_products, title: Find products, description: Find products., enabled: true }
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
    approval: { required: above_threshold, record_threshold: 50, steps: [{ role: content_lead }], allow_widget: false }
  - id: content_lead
    grants: []
    manage_credentials: [magento-integration]
role_mapping:
  - group: content
    roles: [content_manager]
presets:
  - id: magento2-catalog
    package: "@aiops/preset-magento2-catalog"
    version: "0.1.0"
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

describe('EXE-5 EXE-9 changesets execution settings', () => {
  it('EXE-5 changesets.failure_threshold accepts (0, 1] and defaults to 0.5', () => {
    expect(changesetsSchema.parse({}).failure_threshold).toBe(0.5);
    expect(changesetsSchema.parse({ failure_threshold: 1 }).failure_threshold).toBe(1);
    expect(changesetsSchema.parse({ failure_threshold: 0.2 }).failure_threshold).toBe(0.2);
    expect(changesetsSchema.safeParse({ failure_threshold: 0 }).success).toBe(false);
    expect(changesetsSchema.safeParse({ failure_threshold: 1.01 }).success).toBe(false);
  });

  it('EXE-9 changesets.items_per_workflow_run is an integer of at least 100, default 2000', () => {
    expect(changesetsSchema.parse({}).items_per_workflow_run).toBe(2000);
    expect(changesetsSchema.parse({ items_per_workflow_run: 150 }).items_per_workflow_run).toBe(150);
    expect(changesetsSchema.safeParse({ items_per_workflow_run: 99 }).success).toBe(false);
    expect(changesetsSchema.safeParse({ items_per_workflow_run: 150.5 }).success).toBe(false);
  });
});

describe('APR-3 AUTH-6 approval schema', () => {
  const role = (approval: string) => `version: 1\nroles:\n  - { id: r, grants: [], approval: ${approval} }\n`;
  it('APR-3 steps take 1..5 entries', () => {
    expect(issuesOf(role('{ steps: [] }'))).not.toEqual([]);
    const six = Array.from({ length: 6 }, () => '{ role: a }').join(', ');
    expect(issuesOf(role(`{ steps: [${six}] }`))).not.toEqual([]);
    expect(issuesOf(role('{ steps: [{ role: a }] }'))).toEqual([]);
    const five = Array.from({ length: 5 }, () => '{ role: a }').join(', ');
    expect(issuesOf(role(`{ steps: [${five}] }`))).toEqual([]);
  });

  it('AUTH-6 step_up_max_age_seconds 30..3600 integer', () => {
    for (const bad of ['29', '3601', '30.5']) expect(issuesOf(role(`{ step_up_max_age_seconds: ${bad} }`)), bad).not.toEqual([]);
    expect(issuesOf(role('{ step_up_max_age_seconds: 30 }'))).toEqual([]);
    expect(issuesOf(role('{ step_up_max_age_seconds: 3600 }'))).toEqual([]);
  });
});

describe('NFR-18 AUD-7 audit settings', () => {
  const parseDoc = (audit: unknown) => configDocumentSchema.safeParse({ version: 1, audit });
  it('NFR-18 AUD-7 audit.retention_days is an integer of at least 1; unknown audit keys are refused', () => {
    expect(parseDoc({ retention_days: 0 }).success).toBe(false);
    expect(parseDoc({ retention_days: 1.5 }).success).toBe(false);
    expect(parseDoc({ keep: 1 }).success).toBe(false);
    expect(parseDoc({ retention_days: 30 }).success).toBe(true);
    expect(parseDoc({}).success).toBe(true);
  });
});
