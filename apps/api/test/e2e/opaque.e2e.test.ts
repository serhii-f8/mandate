/**
 * Opaque operations end to end over the real MCP transport (CS-1, MCP-1, MCP-6, POL-5).
 *
 * Identities (`opaque-config`): alice (group `content`) holds `content_manager`, whose approval rule
 * is `above_threshold` with `record_threshold: 25`; the approval step is `content_lead`.
 */
import { cp, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { startFakeUpstream, startTestIssuer, type FakeUpstream, type StartedPostgres, type TestIssuer } from '@aiops/testing';
import { connectClient, startApi, startDatabase, tokenFor, vaultOf, type RunningApi } from './helpers.js';

const OPAQUE_CONFIG = fileURLToPath(new URL('./fixtures/opaque-config', import.meta.url));

let postgres: StartedPostgres;
let databaseUrl: string;
let issuer: TestIssuer;
let upstream: FakeUpstream;
let api: RunningApi;
let configDir: string;
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
  api = await startApi(databaseUrl, { issuer, configDir });
  await vaultOf(api).put({ ref: 'shop-token', scheme: 'bearer', secret: { token: 'e2e-only-upstream-token-opaque' }, actor: 'e2e-setup' });
  alice = await tokenFor(issuer, api, 'alice-id', ['content']);
});

afterAll(async () => {
  await api.close();
  await upstream.close();
  await issuer.close();
  await postgres.stop();
  await rm(configDir, { recursive: true });
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
