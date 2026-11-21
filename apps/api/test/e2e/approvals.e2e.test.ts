// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The AI Operations Layer Authors
/**
 * Approvals end to end over the real MCP transport (MCP-8, APR-1, APR-2, APR-8, POL-5, POL-6, SEC-1).
 *
 * Identities (`approval-config`, whose widget approver roles are `{content_lead}`):
 * - alice: group `content` only, the requester. She holds no widget step role, so `decide_changeset`
 *   is not listed to her.
 * - erin: groups `content` and `content-leads`, a requester who also holds the step role; she proves
 *   APR-2 on her own change-set. (Alice cannot play this part: with `content-leads` she would see the tool.)
 * - dave: group `content-leads`, the approver who decides in the widget.
 */
import { cp, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startFakeUpstream, startTestIssuer, type FakeUpstream, type StartedPostgres, type TestIssuer } from '@aiops/testing';
import { auditRows, connectClient, startApi, startDatabase, text, tokenFor, vaultOf, type RunningApi } from './helpers.js';

const APPROVAL_CONFIG = fileURLToPath(new URL('./fixtures/approval-config', import.meta.url));
const UNKNOWN_ID = '99999999-9999-4999-8999-999999999999';
const UNKNOWN_HASH = `sha256:${'0'.repeat(64)}`;

let postgres: StartedPostgres;
let databaseUrl: string;
let issuer: TestIssuer;
let upstream: FakeUpstream;
let api: RunningApi;
let configDir: string;
let alice: string;
let erin: string;
let dave: string;

interface ToolResult {
  isError?: boolean;
  content: { type: string; text: string }[];
  structuredContent?: Record<string, unknown>;
}

interface Prepared {
  id: string;
  hash: string;
}

beforeAll(async () => {
  ({ postgres, databaseUrl } = await startDatabase());
  issuer = await startTestIssuer();
  upstream = await startFakeUpstream();
  configDir = await mkdtemp(join(tmpdir(), 'aiops-approvals-e2e-'));
  await cp(APPROVAL_CONFIG, configDir, { recursive: true });
  const connections = join(configDir, 'connections.yaml');
  await writeFile(connections, (await readFile(connections, 'utf8')).replaceAll('__UPSTREAM_URL__', upstream.url));
  upstream.route('GET', '/rest/V1/products', (req) => {
    const skus = (req.query.get('skus') ?? '').split(',');
    const items = skus.map((sku) => ({ sku, brand: 'acme', name: `Old ${sku}`, description: 'd' }));
    return { status: 200, body: { items, total_count: items.length } };
  });
  api = await startApi(databaseUrl, { issuer, configDir });
  await vaultOf(api).put({ ref: 'shop-token', scheme: 'bearer', secret: { token: 'e2e-only-upstream-token-approvals' }, actor: 'e2e-setup' });
  alice = await tokenFor(issuer, api, 'alice-id', ['content']);
  erin = await tokenFor(issuer, api, 'erin-id', ['content', 'content-leads']);
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

const structured = (result: ToolResult): Record<string, unknown> => result.structuredContent ?? {};

/** Prepares a content change for `skus` as `token` and returns its ID and hash. */
async function prepare(token: string, skus: string[], operation = 'shop.update_content'): Promise<Prepared> {
  const result = await call(token, operation, { brand: 'acme', skus, changes: { name: 'New name' } });
  expect(result.isError).toBeUndefined();
  const changeset = structured(result).changeset as { id: string; hash: string; status: string };
  expect(changeset.status).toBe('prepared');
  return { id: changeset.id, hash: changeset.hash };
}

async function submit(token: string, { id, hash }: Prepared): Promise<ToolResult> {
  return call(token, 'submit_for_approval', { changeset_id: id, hash });
}

async function statusOf(token: string, id: string): Promise<string> {
  const read = await call(token, 'get_changeset', { changeset_id: id });
  return String((structured(read).changeset as { status?: string } | undefined)?.status);
}

/** Polls `get_changeset` until the change-set reaches `want` or 10 s pass; returns the last status. */
async function waitForStatus(token: string, id: string, want: string): Promise<string> {
  let status = await statusOf(token, id);
  for (const deadline = Date.now() + 10_000; status !== want && Date.now() < deadline; ) {
    await sleep(100);
    status = await statusOf(token, id);
  }
  return status;
}

/** The stored execution request (POL-6) of change-set `id`. */
async function executionRequest(id: string): Promise<{ execution_actor: string | null; execution_groups: string[] | null } | undefined> {
  const client = new pg.Client({ connectionString: databaseUrl });
  await client.connect();
  try {
    const { rows } = await client.query<{ execution_actor: string | null; execution_groups: string[] | null }>(
      'select execution_actor, execution_groups from change_set where id = $1',
      [id],
    );
    return rows[0];
  } finally {
    await client.end();
  }
}

const awaitsText = (id: string, n: number): string =>
  `Change-set ${id} (${String(n)} changes) awaits approval by role content_lead (step 1 of 1). Approvers decide on ${api.url}/app/changesets/${id}.`;

describe('MCP-8 APR-1 APR-8 approvals end to end', () => {
  it('MCP-8 a change-set above the threshold is submitted for approval with the fixed text', async () => {
    const prepared = await prepare(alice, ['acme-1', 'acme-2']);
    const result = await submit(alice, prepared);
    expect(result.isError).toBeUndefined();
    expect(text(result)).toBe(awaitsText(prepared.id, 2));
    expect(result.structuredContent).toEqual({
      changesetId: prepared.id,
      status: 'pending_approval',
      total: 2,
      approval: { step: 1, steps: ['content_lead'], url: `${api.url}/app/changesets/${prepared.id}` },
      pageUrl: `${api.url}/app/changesets/${prepared.id}`,
    });
    expect(await statusOf(alice, prepared.id)).toBe('pending_approval');
  });

  it('MCP-8 one at the threshold executes directly', async () => {
    const prepared = await prepare(alice, ['acme-1']);
    const result = await submit(alice, prepared);
    expect(result.isError).toBeUndefined();
    expect(text(result)).toBe(`Execution of 1 changes started. Call get_changeset with this ID to follow it. Open: ${api.url}/app/changesets/${prepared.id}`);
    expect(await waitForStatus(alice, prepared.id, 'completed')).toBe('completed');
  });

  it('APR-8 tools/list shows decide_changeset with _meta.ui.visibility ["app"] to dave and not to alice', async () => {
    const daveClient = await connectClient({ era: 'modern', baseUrls: [api.url], token: dave });
    const aliceClient = await connectClient({ era: 'modern', baseUrls: [api.url], token: alice });
    try {
      const decide = (await daveClient.listTools()).tools.find((t) => t.name === 'decide_changeset');
      expect(decide).toBeDefined();
      // Over the wire: the SDK publishes the tool's `_meta`, so MCP Apps hosts keep it away from the model.
      expect((decide?._meta as { ui?: { visibility?: unknown } } | undefined)?.ui?.visibility).toEqual(['app']);
      expect((await aliceClient.listTools()).tools.map((t) => t.name)).not.toContain('decide_changeset');
    } finally {
      await daveClient.close();
      await aliceClient.close();
    }
  });

  it('APR-2 alice in content and content-leads cannot decide her own change-set: separation_of_duties', async () => {
    // erin stands for "alice in content and content-leads" (D5, see the header).
    const prepared = await prepare(erin, ['acme-1', 'acme-2']);
    expect(text(await submit(erin, prepared))).toBe(awaitsText(prepared.id, 2));
    const result = await call(erin, 'decide_changeset', { changeset_id: prepared.id, decision: 'approve', hash: prepared.hash, count: 2 });
    expect(result.isError).toBe(true);
    expect(text(result)).toBe('You cannot decide this step: you requested the change-set or decided an earlier step.');
    expect(await statusOf(erin, prepared.id)).toBe('pending_approval');
    const rows = await auditRows(databaseUrl, "action = 'approval.decision' and subject = $1", [prepared.id]);
    expect(rows.map((r) => ({ actor: r.actor, outcome: r.outcome, reason: r.details.reason }))).toEqual([
      { actor: 'erin-id', outcome: 'denied', reason: 'separation_of_duties' },
    ]);
  });

  it('APR-1 POL-6 dave approves in the widget, execution runs as alice', async () => {
    const prepared = await prepare(alice, ['acme-1', 'acme-2']);
    expect(text(await submit(alice, prepared))).toBe(awaitsText(prepared.id, 2));
    const result = await call(dave, 'decide_changeset', { changeset_id: prepared.id, decision: 'approve', hash: prepared.hash, count: 2 });
    expect(result.isError).toBeUndefined();
    expect(text(result)).toBe(`Decision recorded for change-set ${prepared.id}: approved. Execution started.`);
    expect(await waitForStatus(alice, prepared.id, 'completed')).toBe('completed');

    const decisions = await auditRows(databaseUrl, "action = 'approval.decision' and subject = $1", [prepared.id]);
    expect(decisions.map((r) => ({ actor: r.actor, outcome: r.outcome, decision: r.details.decision, channel: r.details.channel }))).toEqual([
      { actor: 'dave-id', outcome: 'ok', decision: 'approve', channel: 'widget' },
    ]);
    // POL-6: the execution request is the requester's submitted identity; the audit names the approver who started it.
    expect(await executionRequest(prepared.id)).toEqual({ execution_actor: 'alice-id', execution_groups: ['content'] });
    const transitions = await auditRows(databaseUrl, "action = 'changeset.transition' and changeset_id = $1 and details->>'to' = 'executing'", [prepared.id]);
    expect(transitions.map((r) => r.actor)).toEqual(['dave-id']);
  });

  it('POL-5 APR-8 a destructive change-set needs approval and is refused in the widget', async () => {
    // One record, at the threshold: a write would execute directly, a destructive one needs approval (POL-5).
    const prepared = await prepare(alice, ['acme-1'], 'shop.retire_content');
    expect(text(await submit(alice, prepared))).toBe(awaitsText(prepared.id, 1));
    const result = await call(dave, 'decide_changeset', { changeset_id: prepared.id, decision: 'approve', hash: prepared.hash, count: 1 });
    expect(result.isError).toBe(true);
    expect(text(result)).toBe('This change-set must be decided on the approval page.');
    expect(await statusOf(alice, prepared.id)).toBe('pending_approval');
    const rows = await auditRows(databaseUrl, "action = 'approval.decision' and subject = $1", [prepared.id]);
    expect(rows.map((r) => ({ actor: r.actor, outcome: r.outcome, reason: r.details.reason }))).toEqual([
      { actor: 'dave-id', outcome: 'denied', reason: 'widget_not_allowed' },
    ]);
  });

  it('SEC-1 an unknown change-set ID answers not_found to dave', async () => {
    const result = await call(dave, 'decide_changeset', { changeset_id: UNKNOWN_ID, decision: 'approve', hash: UNKNOWN_HASH, count: 1 });
    expect(result.isError).toBe(true);
    expect(text(result)).toBe(`Change-set ${UNKNOWN_ID} was not found.`);
    const rows = await auditRows(databaseUrl, "action = 'approval.decision' and subject = $1", [UNKNOWN_ID]);
    expect(rows.map((r) => ({ actor: r.actor, outcome: r.outcome, reason: r.details.reason }))).toEqual([
      { actor: 'dave-id', outcome: 'denied', reason: 'not_found' },
    ]);
  });
});
