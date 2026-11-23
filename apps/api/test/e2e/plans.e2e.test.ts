// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Mandate Authors
/**
 * Plans end to end over the real MCP transport (CS-9, EXE-13, MCP-10, SEC-1), against PostgreSQL with the
 * in-memory executor. Identities (`approval-config`): alice (group `content`) prepares and orders the
 * change-sets; dave (`content-leads`) approves them in the widget; bob (`content`) is another requester.
 */
import { cp, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startFakeUpstream, startTestIssuer, type FakeUpstream, type StartedPostgres, type TestIssuer } from '@mandate/testing';
import { auditRows, connectClient, startApi, startDatabase, text, tokenFor, vaultOf, type RunningApi } from './helpers.js';

const APPROVAL_CONFIG = fileURLToPath(new URL('./fixtures/approval-config', import.meta.url));

let postgres: StartedPostgres;
let databaseUrl: string;
let issuer: TestIssuer;
let upstream: FakeUpstream;
let api: RunningApi;
let configDir: string;
let alice: string;
let bob: string;
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
  configDir = await mkdtemp(join(tmpdir(), 'mandate-plans-e2e-'));
  await cp(APPROVAL_CONFIG, configDir, { recursive: true });
  const connections = join(configDir, 'connections.yaml');
  await writeFile(connections, (await readFile(connections, 'utf8')).replaceAll('__UPSTREAM_URL__', upstream.url));
  upstream.route('GET', '/rest/V1/products', (req) => {
    const skus = (req.query.get('skus') ?? '').split(',');
    const items = skus.map((sku) => ({ sku, brand: 'acme', name: `Old ${sku}`, description: 'd' }));
    return { status: 200, body: { items, total_count: items.length } };
  });
  api = await startApi(databaseUrl, { issuer, configDir });
  await vaultOf(api).put({ ref: 'shop-token', scheme: 'bearer', secret: { token: 'e2e-only-upstream-token-plans' }, actor: 'e2e-setup' });
  alice = await tokenFor(issuer, api, 'alice-id', ['content']);
  bob = await tokenFor(issuer, api, 'bob-id', ['content']);
  dave = await tokenFor(issuer, api, 'dave-id', ['content-leads']);
});

afterAll(async () => {
  await api.close();
  await upstream.close();
  await issuer.close();
  await postgres.stop();
  await rm(configDir, { recursive: true });
});

async function call(token: string, name: string, args: Record<string, unknown>): Promise<{ result: ToolResult; correlationId: string }> {
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

const structured = (result: ToolResult): Record<string, unknown> => result.structuredContent ?? {};

/** Prepares a content change for `skus` as `token`; two records need approval under `approval-config`. */
async function prepare(token: string, skus: string[]): Promise<Prepared> {
  const { result } = await call(token, 'shop.update_content', { brand: 'acme', skus, changes: { name: 'New name' } });
  expect(result.isError).toBeUndefined();
  const changeset = structured(result).changeset as { id: string; hash: string; status: string };
  expect(changeset.status).toBe('prepared');
  return { id: changeset.id, hash: changeset.hash };
}

async function statusOf(token: string, id: string): Promise<string> {
  const { result } = await call(token, 'get_changeset', { changeset_id: id });
  return String((structured(result).changeset as { status?: string } | undefined)?.status);
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

/** The stored execution request's identity (POL-6): whose request the execution is. */
async function executionRequestOf(id: string): Promise<{ actor: string | null; groups: string[] | null }> {
  const client = new pg.Client({ connectionString: databaseUrl });
  await client.connect();
  try {
    const rows = (await client.query<{ actor: string | null; groups: string[] | null }>(
      'select execution_actor as actor, execution_groups as groups from change_set where id = $1',
      [id],
    )).rows;
    return rows[0] ?? { actor: null, groups: null };
  } finally {
    await client.end();
  }
}

const approve = (c: Prepared) => call(dave, 'decide_changeset', { changeset_id: c.id, decision: 'approve', hash: c.hash, count: 2 });

describe('CS-9 EXE-13 a plan over the real MCP transport', () => {
  it('MCP-10 create_plan is listed to every caller as a tool that changes state', async () => {
    for (const token of [alice, dave]) {
      const client = await connectClient({ era: 'modern', baseUrls: [api.url], token });
      try {
        const tool = (await client.listTools()).tools.find((t) => t.name === 'create_plan');
        expect(tool?.annotations?.readOnlyHint).toBe(false);
        expect(tool?.inputSchema.required).toEqual(['title', 'changesets']);
      } finally {
        await client.close();
      }
    }
  });

  it('CS-9 EXE-13 step 2 approved first is refused plan_blocked until step 1 completed, then started by the platform', async () => {
    const first = await prepare(alice, ['acme-1', 'acme-2']);
    const second = await prepare(alice, ['acme-3', 'acme-4']);
    const created = await call(alice, 'create_plan', { title: 'Spring launch', changesets: [first.id, second.id] });
    expect(created.result.isError).toBeUndefined();
    const plan = structured(created.result).plan as { id: string; title: string; steps: unknown[] };
    expect(plan).toEqual({
      id: plan.id,
      title: 'Spring launch',
      steps: [
        { step: 1, id: first.id, operation: 'shop.update_content', status: 'prepared' },
        { step: 2, id: second.id, operation: 'shop.update_content', status: 'prepared' },
      ],
    });
    // AUD-1: one plan.created row with the plan ID and the number of steps, never the title (SEC-3).
    const createdRows = await auditRows(databaseUrl, "action = 'plan.created' and correlation_id = $1", [created.correlationId]);
    expect(createdRows.map((r) => ({ actor: r.actor, details: r.details }))).toEqual([{ actor: 'alice-id', details: { planId: plan.id, steps: 2 } }]);
    expect(JSON.stringify(await auditRows(databaseUrl, 'correlation_id = $1', [created.correlationId]))).not.toContain('Spring launch');

    for (const c of [first, second]) {
      expect((await call(alice, 'submit_for_approval', { changeset_id: c.id, hash: c.hash })).result.isError).toBeUndefined();
    }
    // Step 2 approved first: the approval's start is refused, and the step waits as approved.
    const early = await approve(second);
    expect(early.result.isError).toBeUndefined();
    expect(text(early.result)).toBe(
      `Decision recorded for change-set ${second.id}: approved. The step is approved and will start when the step before it in its plan completes.`,
    );
    expect(await statusOf(alice, second.id)).toBe('approved');

    const blocked = await call(alice, 'submit_for_approval', { changeset_id: second.id, hash: second.hash });
    expect(blocked.result.isError).toBe(true);
    expect(text(blocked.result)).toBe(
      `Change-set ${second.id} cannot start yet: the step before it in its plan has not completed (now: pending_approval). Open: ${api.url}/app/changesets/${second.id}`,
    );
    const blockedRow = (await auditRows(databaseUrl, "action = 'tool.call' and correlation_id = $1", [blocked.correlationId]))[0];
    expect(blockedRow?.details).toMatchObject({ errorCode: 'plan_blocked' });
    expect(await statusOf(alice, second.id)).toBe('approved');

    // get_changeset of step 2 shows the plan with step 1's status.
    const read = await call(alice, 'get_changeset', { changeset_id: second.id });
    expect(structured(read.result).plan).toEqual({
      id: plan.id,
      title: 'Spring launch',
      step: 2,
      of: 2,
      steps: [
        { step: 1, id: first.id, operation: 'shop.update_content', status: 'pending_approval' },
        { step: 2, id: second.id, operation: 'shop.update_content', status: 'approved' },
      ],
      startLine: 'Runs after step 1 completes (now: pending_approval)',
    });

    // Step 1 approved and completed: the platform starts the approved step 2 by itself, with no further call.
    const approvedFirst = await approve(first);
    expect(text(approvedFirst.result)).toBe(`Decision recorded for change-set ${first.id}: approved. Execution started.`);
    expect(await waitForStatus(alice, first.id, 'completed')).toBe('completed');
    expect(await waitForStatus(alice, second.id, 'completed')).toBe('completed');
    // EXE-13: the start's `executing` transition is the system's, under step 1's execution correlation ID ...
    const startedRows = await auditRows(databaseUrl, "action = 'changeset.transition' and changeset_id = $1 and details->>'to' = 'executing'", [second.id]);
    expect(startedRows.map((r) => ({ actor: r.actor, correlationId: r.correlation_id, from: r.details.from }))).toEqual([
      { actor: 'system', correlationId: approvedFirst.correlationId, from: 'approved' },
    ]);
    // ... and the execution request is the requester's stored submission identity (POL-6).
    expect(await executionRequestOf(second.id)).toEqual({ actor: 'alice-id', groups: ['content'] });
  });

  it('MCP-10 SEC-1 another user\'s change-set in create_plan reads as not found and nothing is written', async () => {
    const own = await prepare(bob, ['acme-5', 'acme-6']);
    const alices = await prepare(alice, ['acme-7', 'acme-8']);
    const refused = await call(bob, 'create_plan', { title: 'Mine', changesets: [own.id, alices.id] });
    expect(refused.result).toMatchObject({
      isError: true,
      content: [{ type: 'text', text: `Change-set ${alices.id} was not found.` }],
      structuredContent: { reason: 'not_found', changesetId: alices.id },
    });
    expect(JSON.stringify(refused.result)).not.toContain('shop.update_content');
    expect(await auditRows(databaseUrl, "action = 'plan.created' and correlation_id = $1", [refused.correlationId])).toEqual([]);
    const read = await call(alice, 'get_changeset', { changeset_id: alices.id });
    expect(structured(read.result)).not.toHaveProperty('plan');
  });

  it('MCP-10 MCP-3 a malformed ID or a control character in the title is refused before anything runs', async () => {
    for (const args of [
      { title: 'Launch', changesets: ['not-a-uuid', '11111111-1111-4111-8111-111111111111'] },
      { title: 'Launch\u0007', changesets: ['11111111-1111-4111-8111-111111111111', '22222222-2222-4222-8222-222222222222'] },
    ]) {
      const { result } = await call(alice, 'create_plan', args);
      expect(result.isError).toBe(true);
      expect(text(result)).toMatch(/^Input validation error: Invalid arguments for tool create_plan: /);
    }
  });
});
