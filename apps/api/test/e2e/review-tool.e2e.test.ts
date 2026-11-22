// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Mandate Authors
/**
 * `review_changeset` end to end over the real MCP transport (APR-5, APR-8, APR-2, NFR-8, MCP-6, UI-6, SEC-1).
 *
 * Identities (`approval-config`, whose only approval step role is `content_lead`):
 * - alice: group `content` only, the requester; she holds no step role, so the tool is not hers.
 * - erin: groups `content` and `content-leads`, a requester who also holds the step role (APR-2).
 * - dave: group `content-leads`, the approver.
 */
import { cp, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startFakeUpstream, startTestIssuer, type FakeUpstream, type StartedPostgres, type TestIssuer } from '@mandate/testing';
import { auditRows, connectClient, modernRequest, rawPost, startApi, startDatabase, tokenFor, vaultOf, type RunningApi } from './helpers.js';

const APPROVAL_CONFIG = fileURLToPath(new URL('./fixtures/approval-config', import.meta.url));

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

interface Review {
  changesetId: string;
  detail: { id: string; status: string; hash: string; stats: { included: number }; viewer: { canDecide: boolean; reason: string | null } };
  items: { targetId: string }[];
  nextCursor?: string;
  sample: { seed: string; items: { targetId: string }[] };
  pageUrl?: string;
}

interface Prepared {
  id: string;
  hash: string;
}

beforeAll(async () => {
  ({ postgres, databaseUrl } = await startDatabase());
  issuer = await startTestIssuer();
  upstream = await startFakeUpstream();
  configDir = await mkdtemp(join(tmpdir(), 'mandate-review-e2e-'));
  await cp(APPROVAL_CONFIG, configDir, { recursive: true });
  const connections = join(configDir, 'connections.yaml');
  await writeFile(connections, (await readFile(connections, 'utf8')).replaceAll('__UPSTREAM_URL__', upstream.url));
  upstream.route('GET', '/rest/V1/products', (req) => {
    const skus = (req.query.get('skus') ?? '').split(',');
    const items = skus.map((sku) => ({ sku, brand: 'acme', name: `Old ${sku}`, description: 'd' }));
    return { status: 200, body: { items, total_count: items.length } };
  });
  api = await startApi(databaseUrl, { issuer, configDir });
  await vaultOf(api).put({ ref: 'shop-token', scheme: 'bearer', secret: { token: 'e2e-only-upstream-token-review' }, actor: 'e2e-setup' });
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

async function callWith(token: string, name: string, args: Record<string, unknown>): Promise<{ result: ToolResult; correlationId: string }> {
  let correlationId = '';
  const client = await connectClient({
    era: 'modern',
    baseUrls: [api.url],
    token,
    onResponse: (r) => {
      correlationId = r.headers.get('x-correlation-id') ?? correlationId;
    },
  });
  try {
    return { result: (await client.callTool({ name, arguments: args })) as unknown as ToolResult, correlationId };
  } finally {
    await client.close();
  }
}

const call = async (token: string, name: string, args: Record<string, unknown>): Promise<ToolResult> => (await callWith(token, name, args)).result;
const first = (r: ToolResult): string => r.content[0]?.text ?? '';
const review = (r: ToolResult): Review => r.structuredContent as unknown as Review;

async function prepare(token: string, skus: string[], operation = 'shop.update_content'): Promise<Prepared> {
  const result = await call(token, operation, { brand: 'acme', skus, changes: { name: 'New name' } });
  expect(result.isError).toBeUndefined();
  const changeset = result.structuredContent?.changeset as { id: string; hash: string; status: string };
  expect(changeset.status).toBe('prepared');
  return { id: changeset.id, hash: changeset.hash };
}

/** Prepares and submits; the fixture's threshold of 1 sends two or more records to approval. */
async function pending(token: string, skus: string[], operation?: string): Promise<Prepared> {
  const prepared = await prepare(token, skus, operation);
  const submitted = await call(token, 'submit_for_approval', { changeset_id: prepared.id, hash: prepared.hash });
  expect(submitted.structuredContent?.status).toBe('pending_approval');
  return prepared;
}

async function statusOf(token: string, id: string): Promise<string> {
  const read = await call(token, 'get_changeset', { changeset_id: id });
  return String((read.structuredContent?.changeset as { status?: string } | undefined)?.status);
}

/** Polls until the change-set leaves `from` or 10 s pass. */
async function waitUntilNot(token: string, id: string, from: string): Promise<string> {
  let status = await statusOf(token, id);
  for (const deadline = Date.now() + 10_000; status === from && Date.now() < deadline; ) {
    await sleep(100);
    status = await statusOf(token, id);
  }
  return status;
}

const awaits = (id: string, n: number, hash: string, tail: string): string =>
  `Change-set ${id} (shop.update_content) awaits content_lead: ${String(n)} change(s), hash ${hash}. ${tail} Open: ${api.url}/app/changesets/${id}`;

describe('APR-8 review_changeset end to end', () => {
  it('APR-8 dave reviews a pending widget-enabled change-set: canDecide true, then decide_changeset approves it with channel widget', async () => {
    const prepared = await pending(alice, ['acme-1', 'acme-2']);
    const result = await call(dave, 'review_changeset', { changeset_id: prepared.id });
    expect(result.isError).toBeUndefined();
    expect(first(result)).toBe(awaits(prepared.id, 2, prepared.hash, 'You can decide it here or on the page.'));
    const r = review(result);
    expect(r.detail.viewer).toEqual({ canDecide: true, reason: null, fresh: true, stepUpSatisfied: true, canStart: false, canSubmit: false, canExclude: false });
    // The widget decides with what the review showed.
    const decided = await call(dave, 'decide_changeset', { changeset_id: r.detail.id, decision: 'approve', hash: r.detail.hash, count: r.detail.stats.included });
    expect(decided.isError).toBeUndefined();
    const rows = await auditRows(databaseUrl, "action = 'approval.decision' and subject = $1", [prepared.id]);
    expect(rows.map((x) => ({ actor: x.actor, outcome: x.outcome, channel: x.details.channel }))).toEqual([{ actor: 'dave-id', outcome: 'ok', channel: 'widget' }]);
  });

  it('APR-8 a destructive change-set: canDecide false, reason widget_not_allowed, decide_changeset refused', async () => {
    // Destructive needs approval even at one record (POL-5), and its plan never allows the widget.
    const prepared = await pending(alice, ['acme-1'], 'shop.retire_content');
    const result = await call(dave, 'review_changeset', { changeset_id: prepared.id });
    expect(result.isError).toBeUndefined();
    expect(first(result)).toBe(
      `Change-set ${prepared.id} (shop.retire_content) awaits content_lead: 1 change(s), hash ${prepared.hash}. This change-set must be decided on the approval page. Open: ${api.url}/app/changesets/${prepared.id}`,
    );
    expect(review(result).detail.viewer).toMatchObject({ canDecide: false, reason: 'widget_not_allowed' });
    const decided = await call(dave, 'decide_changeset', { changeset_id: prepared.id, decision: 'approve', hash: prepared.hash, count: 1 });
    expect(decided.isError).toBe(true);
    expect(await statusOf(alice, prepared.id)).toBe('pending_approval');
  });

  it('APR-2 erin reviewing her own change-set sees separation_of_duties', async () => {
    const prepared = await pending(erin, ['acme-1', 'acme-2']);
    const result = await call(erin, 'review_changeset', { changeset_id: prepared.id });
    expect(result.isError).toBeUndefined();
    expect(first(result)).toBe(awaits(prepared.id, 2, prepared.hash, 'You cannot decide this step: you requested the change-set or decided an earlier step.'));
    expect(review(result).detail.viewer).toMatchObject({ canDecide: false, reason: 'separation_of_duties' });
  });

  it('NFR-8 APR-5 paging and the sample seed over HTTP', async () => {
    const skus = Array.from({ length: 55 }, (_, i) => `acme-${String(i + 1).padStart(3, '0')}`);
    const prepared = await pending(alice, skus);
    const page1 = review(await call(dave, 'review_changeset', { changeset_id: prepared.id, sample_seed: 'seed-0001' }));
    expect(page1.items).toHaveLength(50);
    expect(page1.nextCursor).toBeDefined();
    expect(page1.sample.seed).toBe('seed-0001');
    expect(page1.sample.items).toHaveLength(10);
    const page2 = review(await call(dave, 'review_changeset', { changeset_id: prepared.id, cursor: page1.nextCursor, sample_seed: 'seed-0001' }));
    expect(page2.items.map((i) => i.targetId)).toEqual(skus.slice(50));
    expect(page2.nextCursor).toBeUndefined();
    expect(page2.sample).toEqual(page1.sample);
    const fresh = review(await call(dave, 'review_changeset', { changeset_id: prepared.id }));
    expect(fresh.sample.seed).toMatch(/^[0-9a-f]{32}$/);
    const tampered = await call(dave, 'review_changeset', { changeset_id: prepared.id, cursor: 'not*base64' });
    expect(tampered.isError).toBe(true);
    expect(first(tampered)).toBe('Input validation error: Invalid arguments for tool review_changeset: cursor is not valid');
  });

  it('MCP-6 the review text ends with the page link and structuredContent.pageUrl is set', async () => {
    const prepared = await pending(alice, ['acme-1', 'acme-2']);
    const result = await call(dave, 'review_changeset', { changeset_id: prepared.id });
    const url = `${api.url}/app/changesets/${prepared.id}`;
    expect(first(result).endsWith(` Open: ${url}`)).toBe(true);
    expect(first(result).split(url)).toHaveLength(2);
    expect(review(result).pageUrl).toBe(url);
    expect(result.content[1]?.text).toBe(JSON.stringify(result.structuredContent));
  });

  it('CS-6 APR-8 after the step was decided, review answers not_pending without error', async () => {
    const prepared = await pending(alice, ['acme-1', 'acme-2']);
    expect((await call(dave, 'decide_changeset', { changeset_id: prepared.id, decision: 'approve', hash: prepared.hash, count: 2 })).isError).toBeUndefined();
    // The one-step plan is complete: the change-set has left pending_approval.
    expect(await waitUntilNot(alice, prepared.id, 'pending_approval')).not.toBe('pending_approval');
    const result = await call(dave, 'review_changeset', { changeset_id: prepared.id });
    expect(result.isError).toBeUndefined();
    const r = review(result);
    expect(r.detail.viewer).toMatchObject({ canDecide: false, reason: 'not_pending' });
    expect(first(result)).toMatch(new RegExp(`^Change-set ${prepared.id} \\(shop\\.update_content\\) is [a-z_]+: 2 change\\(s\\), hash ${prepared.hash}\\. Change-set ${prepared.id} is not awaiting approval\\. Open: `));
  });

  it('UI-6 SEC-1 a widget-style call is authorized and audited like a model call', async () => {
    const prepared = await pending(alice, ['acme-1', 'acme-2']);
    const { result, correlationId } = await callWith(dave, 'review_changeset', { changeset_id: prepared.id, sample_seed: 'widget-1' });
    expect(result.isError).toBeUndefined();
    const rows = await auditRows(databaseUrl, 'correlation_id = $1', [correlationId]);
    expect(rows.map((r) => r.action)).toEqual(['policy.decision', 'tool.call']);
    expect(rows[0]).toMatchObject({ actor: 'dave-id', decision: 'allow', subject: 'review_changeset', details: { rule: 'builtin' } });
    expect(rows[1]?.details).toMatchObject({ changesetId: prepared.id, canDecide: true });
    // SEC-3: the audit row holds no item value and no link.
    expect(JSON.stringify(rows[1]?.details)).not.toContain('New name');

    const { body, headers } = modernRequest('tools/call', { name: 'review_changeset', arguments: { changeset_id: prepared.id } });
    const response = await rawPost(api.url, body, { ...headers, authorization: `Bearer ${alice}` });
    const json = (await response.json()) as { error?: { code: number; message: string } };
    expect(json.error?.code).toBe(-32602);
    expect(json.error?.message).toContain('Tool review_changeset not found');
  });
});
