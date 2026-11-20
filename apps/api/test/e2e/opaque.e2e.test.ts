/**
 * Opaque operations end to end over the real MCP transport (CS-1, MCP-1, MCP-6, POL-5).
 *
 * Identities (`opaque-config`): alice (group `content`) holds `content_manager`, whose approval rule
 * is `above_threshold` with `record_threshold: 25`; the approval step is `content_lead`.
 */
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { pageLogin, startFakeUpstream, startTestIssuer, type FakeUpstream, type StartedPostgres, type TestIssuer } from '@aiops/testing';
import { connectClient, startApi, startDatabase, tokenFor, vaultOf, type RunningApi } from './helpers.js';

const OPAQUE_CONFIG = fileURLToPath(new URL('./fixtures/opaque-config', import.meta.url));

let postgres: StartedPostgres;
let databaseUrl: string;
let issuer: TestIssuer;
let upstream: FakeUpstream;
let api: RunningApi;
let configDir: string;
let webDir: string;
let alice: string;

interface ToolResult {
  isError?: boolean;
  content: { type: string; text: string }[];
  structuredContent?: Record<string, unknown>;
}

interface PreparedChangeset {
  id: string;
  hash: string;
  status: string;
  stats: { total: number; included: number };
}

beforeAll(async () => {
  ({ postgres, databaseUrl } = await startDatabase());
  issuer = await startTestIssuer();
  upstream = await startFakeUpstream();
  configDir = await mkdtemp(join(tmpdir(), 'aiops-opaque-e2e-'));
  await cp(OPAQUE_CONFIG, configDir, { recursive: true });
  const connections = join(configDir, 'connections.yaml');
  await writeFile(connections, (await readFile(connections, 'utf8')).replaceAll('__UPSTREAM_URL__', upstream.url));
  webDir = await mkdtemp(join(tmpdir(), 'aiops-opaque-web-'));
  await mkdir(join(webDir, 'assets'));
  await writeFile(join(webDir, 'index.html'), '<!doctype html><title>Approvals</title><div id="root"></div>');
  api = await startApi(databaseUrl, { issuer, configDir, webDir });
  await vaultOf(api).put({ ref: 'shop-token', scheme: 'bearer', secret: { token: 'e2e-only-upstream-token-opaque' }, actor: 'e2e-setup' });
  alice = await tokenFor(issuer, api, 'alice-id', ['content']);
});

afterAll(async () => {
  await api.close();
  await upstream.close();
  await issuer.close();
  await postgres.stop();
  await rm(configDir, { recursive: true });
  await rm(webDir, { recursive: true });
});

beforeEach(() => {
  upstream.requests.length = 0;
});

async function call(token: string, name: string, args: Record<string, unknown>): Promise<ToolResult> {
  const client = await connectClient({ era: 'modern', baseUrls: [api.url], token });
  try {
    return (await client.callTool({ name, arguments: args })) as unknown as ToolResult;
  } finally {
    await client.close();
  }
}

async function query<T extends pg.QueryResultRow>(sql: string, params: unknown[]): Promise<T[]> {
  const client = new pg.Client({ connectionString: databaseUrl });
  await client.connect();
  try {
    return (await client.query<T>(sql, params)).rows;
  } finally {
    await client.end();
  }
}

/** Calls `shop.post_note` as alice and returns the prepared change-set of the answer. */
async function postNote(note: string): Promise<{ result: ToolResult; changeset: PreparedChangeset }> {
  const result = await call(alice, 'shop.post_note', { note });
  expect(result.isError).toBeUndefined();
  const changeset = result.structuredContent?.changeset as PreparedChangeset;
  expect(changeset.status).toBe('prepared');
  return { result, changeset };
}

describe('CS-1 MCP-1 opaque operations prepare a change-set', () => {
  it('CS-1 MCP-1 an opaque call prepares one item with the raw arguments and sends nothing', async () => {
    const { changeset } = await postNote('Restock the anvils');
    expect(changeset.stats).toMatchObject({ total: 1, included: 1 });
    const items = await query<{ target_id: string; status: string; before: unknown; after: unknown }>(
      'select target_id, status, before, after from change_item where changeset_id = $1',
      [changeset.id],
    );
    expect(items).toEqual([{ target_id: 'call', status: 'pending', before: null, after: { note: 'Restock the anvils' } }]);
    expect(upstream.requests).toEqual([]);
  });

  it('POL-5 an opaque change-set under above_threshold 25 still requires approval', async () => {
    const { changeset } = await postNote('One record, far under the threshold');
    const submitted = await call(alice, 'submit_for_approval', { changeset_id: changeset.id, hash: changeset.hash });
    expect(submitted.isError).toBeUndefined();
    expect(submitted.structuredContent).toMatchObject({
      changesetId: changeset.id,
      status: 'pending_approval',
      approval: { step: 1, steps: ['content_lead'] },
    });
    const [row] = await query<{ status: string; approval_plan: { reason: string; steps: string[]; threshold?: number } }>(
      'select status, approval_plan from change_set where id = $1',
      [changeset.id],
    );
    expect(row?.status).toBe('pending_approval');
    expect(row?.approval_plan.reason).toBe('opaque');
    expect(row?.approval_plan.steps).toEqual(['content_lead']);
    expect(row?.approval_plan).not.toHaveProperty('threshold');
    expect(upstream.requests).toEqual([]);
  });

  it('MCP-6 the prepared result carries the page link', async () => {
    const { result, changeset } = await postNote('Link me');
    const url = `${api.url}/app/changesets/${changeset.id}`;
    expect(result.structuredContent?.pageUrl).toBe(url);
    expect(result.content[0]?.text).toContain(`Open: ${url}`);
  });
});

interface Page {
  readonly cookie: string;
  readonly csrfToken: string;
}

/** A page session of alice, the requester of every change-set here. */
async function alicePage(): Promise<Page> {
  issuer.setLoginUser({ sub: 'alice-id', username: 'alice', groups: ['content'] });
  const { cookie, csrfToken } = await pageLogin(api.url, 'alice', 'unused');
  return { cookie, csrfToken };
}

async function pageGet(page: Page, path: string): Promise<Response> {
  return fetch(`${api.url}${path}`, { headers: { cookie: page.cookie } });
}

describe('APR-5 UI-3 CS-5 EXE-8 MCP-8 opaque change-set detail and refusals', () => {
  it('APR-5 the page detail has kind opaque and the stored args, not the client text', async () => {
    const { result, changeset } = await postNote('Raw note for the page');
    const answered = result.structuredContent?.changeset as { kind?: string; args?: unknown };
    expect(answered.kind).toBe('opaque');
    expect(answered.args).toEqual({ note: 'Raw note for the page' });
    // The summary text carries counts only (SEC-5).
    expect(result.content[0]?.text).not.toContain('Raw note for the page');

    const detail = await pageGet(await alicePage(), `/api/v1/changesets/${changeset.id}`);
    expect(detail.status).toBe(200);
    const body = (await detail.json()) as { kind: string; request: { args: unknown }; viewer: { canExclude: boolean; canSubmit: boolean } };
    expect(body.kind).toBe('opaque');
    expect(body.request.args).toEqual({ note: 'Raw note for the page' });
    expect(body.viewer).toMatchObject({ canExclude: false, canSubmit: true });

    const got = await call(alice, 'get_changeset', { changeset_id: changeset.id });
    expect(got.structuredContent?.changeset).toMatchObject({ kind: 'opaque', args: { note: 'Raw note for the page' } });
  });

  it('CS-5 exclusion is refused on the tool and on the page with not_excludable', async () => {
    const { changeset } = await postNote('Nothing to exclude');
    const tool = await call(alice, 'exclude_changeset_items', { changeset_id: changeset.id, hash: changeset.hash, exclude: ['call'] });
    expect(tool.isError).toBe(true);
    expect(tool.content[0]?.text).toContain(`Change-set ${changeset.id} is a single upstream call; it has no items to exclude.`);

    const page = await alicePage();
    const response = await fetch(`${api.url}/api/v1/changesets/${changeset.id}/exclusions`, {
      method: 'POST',
      headers: { cookie: page.cookie, origin: new URL(api.url).origin, 'x-csrf-token': page.csrfToken, 'content-type': 'application/json' },
      body: JSON.stringify({ hash: changeset.hash, exclude: ['call'] }),
    });
    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({ error: 'not_excludable' });
    const [row] = await query<{ n: string }>('select count(*)::text as n from change_set where derived_from = $1', [changeset.id]);
    expect(row?.n).toBe('0');
  });

  it('EXE-8 MCP-8 rollback_changeset refuses an executed opaque change-set: not_rollbackable / strategy_none', async () => {
    const { changeset } = await postNote('Executed, then asked to roll back');
    // Stands in for a finished run: the eligibility check reads the status first, then the strategy.
    await query('update change_set set status = $2 where id = $1', [changeset.id, 'completed']);
    const refused = await call(alice, 'rollback_changeset', { changeset_id: changeset.id, hash: changeset.hash });
    expect(refused.isError).toBe(true);
    expect(refused.structuredContent).toMatchObject({ changesetId: changeset.id, rollback: { available: false, reason: 'strategy_none' } });
    expect(refused.content[0]?.text).toContain(`The operation of change-set ${changeset.id} does not allow rollback.`);
  });

  it('UI-3 export of an opaque change-set has one row', async () => {
    const { changeset } = await postNote('Exported call');
    const response = await pageGet(await alicePage(), `/api/v1/changesets/${changeset.id}/export?format=csv`);
    expect(response.status).toBe(200);
    const lines = (await response.text()).split('\r\n').slice(0, -1);
    expect(lines).toHaveLength(1 + 1);
    expect(lines[1]).toContain('"call"');
  });
});
