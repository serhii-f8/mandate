// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Mandate Authors
/**
 * Service accounts end to end over the real MCP transport (AUTH-4, AUTH-1, APR-1, POL-8, AUD-2).
 *
 * Identities (`approval-config` plus `service-accounts.yaml`):
 * - the client `mandate-sa-ci`, a configured service account with role `integration`: it may update
 *   content of brand acme, always with one `content_lead` approval. Its tokens are client-credentials
 *   tokens (`client_id` equals `azp`, no `sid`).
 * - dave: group `content-leads`, the human approver.
 */
import { cp, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startFakeUpstream, startTestIssuer, type FakeUpstream, type StartedPostgres, type TestIssuer } from '@mandate/testing';
import { auditRows, connectClient, modernRequest, rawPost, startApi, startDatabase, text, tokenFor, vaultOf, type RunningApi } from './helpers.js';

const APPROVAL_CONFIG = fileURLToPath(new URL('./fixtures/approval-config', import.meta.url));
const SERVICE_CLIENT = 'mandate-sa-ci';
const SERVICE_SUBJECT = `service:${SERVICE_CLIENT}`;

const SERVICE_ACCOUNTS_YAML = `version: 1
roles:
  - id: integration
    grants:
      - { operation: shop.update_content, id: acme-content, scope: { brand: [acme] } }
    approval: { required: always, steps: [{ role: content_lead }], allow_widget: true }
service_accounts:
  - { client_id: ${SERVICE_CLIENT}, role: integration }
`;

/** The approver tools, never listed to a service caller (APR-8). */
const DECISION_TOOLS = ['review_changeset', 'decide_changeset'];

let postgres: StartedPostgres;
let databaseUrl: string;
let issuer: TestIssuer;
let upstream: FakeUpstream;
let api: RunningApi;
let configDir: string;
let service: string;
let dave: string;

interface ToolResult {
  isError?: boolean;
  content: { type: string; text: string }[];
  structuredContent?: Record<string, unknown>;
}

beforeAll(async () => {
  ({ postgres, databaseUrl } = await startDatabase());
  issuer = await startTestIssuer();
  upstream = await startFakeUpstream();
  configDir = await mkdtemp(join(tmpdir(), 'mandate-service-accounts-e2e-'));
  await cp(APPROVAL_CONFIG, configDir, { recursive: true });
  const connections = join(configDir, 'connections.yaml');
  await writeFile(connections, (await readFile(connections, 'utf8')).replaceAll('__UPSTREAM_URL__', upstream.url));
  await writeFile(join(configDir, 'service-accounts.yaml'), SERVICE_ACCOUNTS_YAML);
  upstream.route('GET', '/rest/V1/products', (req) => {
    const skus = (req.query.get('skus') ?? '').split(',');
    const items = skus.map((sku) => ({ sku, brand: 'acme', name: `Old ${sku}`, description: 'd' }));
    return { status: 200, body: { items, total_count: items.length } };
  });
  api = await startApi(databaseUrl, { issuer, configDir });
  await vaultOf(api).put({ ref: 'shop-token', scheme: 'bearer', secret: { token: 'e2e-only-upstream-token-service-accounts' }, actor: 'e2e-setup' });
  service = await issuer.token({ sub: 'sa-user-id', azp: SERVICE_CLIENT, client_id: SERVICE_CLIENT, aud: api.resource });
  dave = await tokenFor(issuer, api, 'dave-id', ['content-leads']);
});

afterAll(async () => {
  await api.close();
  await upstream.close();
  await issuer.close();
  await postgres.stop();
  await rm(configDir, { recursive: true });
});

async function call(token: string, name: string, args: Record<string, unknown>): Promise<ToolResult> {
  const client = await connectClient({ era: 'modern', baseUrls: [api.url], token });
  try {
    return (await client.callTool({ name, arguments: args })) as unknown as ToolResult;
  } finally {
    await client.close();
  }
}

async function toolNames(token: string): Promise<string[]> {
  const client = await connectClient({ era: 'modern', baseUrls: [api.url], token });
  try {
    return (await client.listTools()).tools.map((t) => t.name);
  } finally {
    await client.close();
  }
}

async function statusOf(token: string, id: string): Promise<string> {
  const read = await call(token, 'get_changeset', { changeset_id: id });
  return String((read.structuredContent?.changeset as { status?: string } | undefined)?.status);
}

async function requesterOf(id: string): Promise<string | undefined> {
  const client = new pg.Client({ connectionString: databaseUrl });
  await client.connect();
  try {
    const { rows } = await client.query<{ requester: string }>('select requester from change_set where id = $1', [id]);
    return rows[0]?.requester;
  } finally {
    await client.end();
  }
}

describe('AUTH-4 service accounts end to end', () => {
  it('AUTH-4 the service account lists exactly its role tools and no decision tools', async () => {
    const names = await toolNames(service);
    expect(names).toContain('shop.update_content');
    for (const other of ['shop.retire_content', 'shop.get_products', 'shop.search_products']) expect(names).not.toContain(other);
    for (const decision of DECISION_TOOLS) expect(names).not.toContain(decision);
    // Control: dave, a human with the step role, sees the decision tool on the same server.
    expect(await toolNames(dave)).toContain('decide_changeset');
  });

  it('AUTH-4 POL-8 AUD-2 a call outside the grant is denied and audited with actor service:mandate-sa-ci', async () => {
    const { body, headers } = modernRequest('tools/call', {
      name: 'shop.retire_content',
      arguments: { brand: 'acme', skus: ['acme-1'], changes: { name: 'Gone' } },
    });
    const response = await rawPost(api.url, body, { ...headers, authorization: `Bearer ${service}` });
    const json = (await response.json()) as { error?: { code: number; message: string } };
    expect(json.error?.message).toContain('Tool shop.retire_content not found');
    const rows = await auditRows(databaseUrl, 'correlation_id = $1', [response.headers.get('x-correlation-id')]);
    expect(rows).toEqual([
      expect.objectContaining({
        action: 'policy.decision',
        decision: 'deny',
        actor: SERVICE_SUBJECT,
        client_id: SERVICE_CLIENT,
        subject: 'shop.retire_content',
      }),
    ]);
  });

  it('AUTH-4 APR-1 a write by the service account waits for a human, and dave approves it', async () => {
    const prepared = await call(service, 'shop.update_content', { brand: 'acme', skus: ['acme-1'], changes: { name: 'New name' } });
    expect(prepared.isError).toBeUndefined();
    const changeset = prepared.structuredContent?.changeset as { id: string; hash: string; status: string };
    expect(changeset.status).toBe('prepared');
    expect(await requesterOf(changeset.id)).toBe(SERVICE_SUBJECT);

    // One record, below any threshold: `required: always` still routes it to a human (APR-1).
    const submitted = await call(service, 'submit_for_approval', { changeset_id: changeset.id, hash: changeset.hash });
    expect(submitted.isError).toBeUndefined();
    expect(submitted.structuredContent).toMatchObject({ changesetId: changeset.id, status: 'pending_approval' });
    expect(await statusOf(service, changeset.id)).toBe('pending_approval');

    const decided = await call(dave, 'decide_changeset', { changeset_id: changeset.id, decision: 'approve', hash: changeset.hash, count: 1 });
    expect(decided.isError).toBeUndefined();
    expect(text(decided)).toContain(`Decision recorded for change-set ${changeset.id}: approved.`);
    expect(await statusOf(dave, changeset.id)).not.toBe('pending_approval');
    const decisions = await auditRows(databaseUrl, "action = 'approval.decision' and subject = $1", [changeset.id]);
    expect(decisions.map((r) => ({ actor: r.actor, outcome: r.outcome }))).toEqual([{ actor: 'dave-id', outcome: 'ok' }]);
  });

  it('AUTH-4 AUTH-1 a configured client with a sid is refused 401 and audited auth.rejected service_account_mismatch', async () => {
    const token = await issuer.token({ sub: 'sa-user-id', azp: SERVICE_CLIENT, client_id: SERVICE_CLIENT, sid: 'browser-session-1', aud: api.resource });
    const { body, headers } = modernRequest('tools/list');
    const response = await rawPost(api.url, body, { ...headers, authorization: `Bearer ${token}` });
    expect(response.status).toBe(401);
    const rows = await auditRows(databaseUrl, 'correlation_id = $1', [response.headers.get('x-correlation-id')]);
    expect(rows).toEqual([
      expect.objectContaining({ action: 'auth.rejected', actor: 'unknown', outcome: 'denied', details: { reason: 'service_account_mismatch' } }),
    ]);
  });
});
