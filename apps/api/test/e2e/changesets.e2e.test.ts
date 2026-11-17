import { cp, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Writable } from 'node:stream';
import { setTimeout as sleep } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { ConfigurationHolder } from '@aiops/config';
import { CHANGESET_TEXT, READ_RESULT_TEXT } from '@aiops/core';
import { startFakeUpstream, startTestIssuer, type FakeUpstream, type RecordedRequest, type StartedPostgres, type TestIssuer } from '@aiops/testing';
import { createLogger } from '../../src/logger.js';
import { CONFIGURATION } from '../../src/tokens.js';
import { auditRows, connectClient, reloadConfiguration, startApi, startDatabase, tokenFor, vaultOf, type RunningApi } from './helpers.js';

const CHANGESET_CONFIG = fileURLToPath(new URL('./fixtures/changeset-config', import.meta.url));
/** Obviously fake. */
const UPSTREAM_TOKEN = 'e2e-only-upstream-token-changesets';
const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/;

let postgres: StartedPostgres;
let databaseUrl: string;
let issuer: TestIssuer;
let upstream: FakeUpstream;
let api: RunningApi;
let configDir: string;
let alice: string;
const logLines: string[] = [];

interface ToolResult {
  isError?: boolean;
  content: { type: string; text: string }[];
  structuredContent?: Record<string, unknown>;
}

interface Product {
  sku: string;
  brand: string;
  name: string;
  description: string;
}

const PRODUCTS: readonly Product[] = [
  { sku: 'acme-1', brand: 'acme', name: 'Anvil', description: 'Heavy anvil' },
  { sku: 'acme-2', brand: 'acme', name: 'Rocket', description: 'Fast rocket' },
  { sku: 'acme-3', brand: 'acme', name: 'New name', description: 'Already renamed' },
  { sku: 'globex-1', brand: 'globex', name: 'Globe', description: 'Round globe' },
  { sku: 'globex-long', brand: 'globex', name: 'Long', description: `${'L'.repeat(4999)}!` },
];

/** Whether the fake upstream applies the brand filter; some tests make it ignore it. */
let honourBrand = true;
let productsDelayMs = 0;

function matching(req: RecordedRequest): Product[] {
  const brand = req.query.get('brand');
  return PRODUCTS.filter((p) => !honourBrand || brand === null || p.brand === brand);
}

function serveProducts(): void {
  upstream.route('GET', '/rest/V1/products', (req) => {
    const skus = (req.query.get('skus') ?? '').split(',');
    const items = matching(req).filter((p) => skus.includes(p.sku));
    return { status: 200, body: { items, total_count: items.length }, delayMs: productsDelayMs };
  });
  upstream.route('GET', '/rest/V1/products/search', (req) => {
    const size = Number(req.query.get('page_size') ?? '100');
    const page = Number(req.query.get('page') ?? '1');
    const all = matching(req);
    return { status: 200, body: { items: all.slice((page - 1) * size, page * size), total_count: all.length } };
  });
}

beforeAll(async () => {
  ({ postgres, databaseUrl } = await startDatabase());
  issuer = await startTestIssuer();
  upstream = await startFakeUpstream();
  configDir = await mkdtemp(join(tmpdir(), 'aiops-changeset-e2e-'));
  await cp(CHANGESET_CONFIG, configDir, { recursive: true });
  const connections = join(configDir, 'connections.yaml');
  await writeFile(connections, (await readFile(connections, 'utf8')).replaceAll('__UPSTREAM_URL__', upstream.url));
  const stream = new Writable({
    write(chunk: Buffer, _encoding, done) {
      logLines.push(chunk.toString('utf8'));
      done();
    },
  });
  api = await startApi(databaseUrl, { issuer, configDir, logger: createLogger('debug', stream) });
  await vaultOf(api).put({ ref: 'shop-token', scheme: 'bearer', secret: { token: UPSTREAM_TOKEN }, actor: 'e2e-setup' });
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
  honourBrand = true;
  productsDelayMs = 0;
  serveProducts();
});

async function call(name: string, args: Record<string, unknown>): Promise<{ result: ToolResult; correlationId: string }> {
  let correlationId = '';
  const client = await connectClient({
    era: 'modern',
    baseUrls: [api.url],
    token: alice,
    onResponse: (r) => {
      correlationId = r.headers.get('x-correlation-id') ?? correlationId;
    },
  });
  try {
    const result = (await client.callTool({ name, arguments: args })) as unknown as ToolResult;
    return { result, correlationId };
  } finally {
    await client.close();
  }
}

async function query<T extends pg.QueryResultRow>(sql: string, params: unknown[] = []): Promise<T[]> {
  const client = new pg.Client({ connectionString: databaseUrl });
  await client.connect();
  try {
    return (await client.query<T>(sql, params)).rows;
  } finally {
    await client.end();
  }
}

interface ChangeSetRow {
  id: string;
  status: string;
  hash: string | null;
  config_hash: string;
  error_code: string | null;
  correlation_id: string;
  created_at: Date;
  expires_at: Date;
  stats: { total: number; included: number; excluded: Record<string, number> };
}

interface ItemRow {
  target_id: string;
  status: string;
  reason: string | null;
  before: unknown;
  after: unknown;
}

const changeSet = async (id: string): Promise<ChangeSetRow | undefined> => (await query<ChangeSetRow>('select * from change_set where id = $1', [id]))[0];
const items = (id: string): Promise<ItemRow[]> =>
  query<ItemRow>('select target_id, status, reason, before, after from change_item where changeset_id = $1 order by target_id', [id]);
const changesetId = (result: ToolResult): string => ((result.structuredContent?.changeset as { id?: string } | undefined)?.id ?? '');

describe('CS-1 CS-2 CS-4 write calls prepare change-sets', () => {
  it('CS-1 CS-2 MCP-4 explicit SKUs prepare a change-set from upstream state, with only GET requests upstream', async () => {
    const { result, correlationId } = await call('shop.update_content', { brand: 'acme', skus: ['acme-2', 'acme-1', 'acme-9'], changes: { name: 'New name' } });
    expect(result.isError).toBeUndefined();
    const id = changesetId(result);
    expect(id).toMatch(UUID);
    const row = await changeSet(id);
    expect(row?.status).toBe('prepared');
    expect(row?.correlation_id).toBe(correlationId);
    expect(row?.hash).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(result.content[0]?.text).toBe(
      `shop.update_content prepared change-set ${id}: 2 change(s) to apply, 1 excluded (not_found 1). ${CHANGESET_TEXT.nothingWritten} ` +
        `Hash ${row?.hash ?? ''}; expires ${row?.expires_at.toISOString() ?? ''}. ${CHANGESET_TEXT.seeAll} ${READ_RESULT_TEXT.dataNote}`,
    );
    expect(JSON.parse(result.content[1]?.text ?? '')).toEqual(result.structuredContent);
    expect(result.structuredContent).toMatchObject({ changeset: { id, operation: 'shop.update_content', status: 'prepared', hash: row?.hash } });

    expect(await items(id)).toEqual([
      { target_id: 'acme-1', status: 'pending', reason: null, before: { name: 'Anvil' }, after: { name: 'New name' } },
      { target_id: 'acme-2', status: 'pending', reason: null, before: { name: 'Rocket' }, after: { name: 'New name' } },
      { target_id: 'acme-9', status: 'excluded', reason: 'not_found', before: null, after: null },
    ]);
    expect(upstream.requests.length).toBeGreaterThan(0);
    expect(upstream.requests.every((r) => r.method === 'GET')).toBe(true);
    expect(upstream.requests[0]?.query.get('skus')).toBe('acme-1,acme-2,acme-9');
    expect(upstream.requests[0]?.query.get('brand')).toBe('acme');
  });

  it('CS-2 a before value longer than the read path clips is stored exactly', async () => {
    const { result } = await call('shop.update_content', { brand: 'globex', skus: ['globex-long'], changes: { description: 'Short' } });
    const id = changesetId(result);
    expect((await changeSet(id))?.status).toBe('prepared');
    const [item] = await items(id);
    expect(item?.before).toEqual({ description: `${'L'.repeat(4999)}!` });
  });

  it('MCP-4 tools/list announces the write tool as not read-only', async () => {
    const client = await connectClient({ era: 'modern', baseUrls: [api.url], token: alice });
    try {
      const tool = (await client.listTools()).tools.find((t) => t.name === 'shop.update_content');
      expect(tool?.annotations).toMatchObject({ readOnlyHint: false, destructiveHint: false });
    } finally {
      await client.close();
    }
  });

  it('CS-4 a second identical call gives the same hash under a different ID', async () => {
    const args = { brand: 'acme', skus: ['acme-1', 'acme-3'], changes: { name: 'New name' } };
    const first = await call('shop.update_content', args);
    const second = await call('shop.update_content', args);
    const [a, b] = [changesetId(first.result), changesetId(second.result)];
    expect(a).not.toBe(b);
    const [rowA, rowB] = [await changeSet(a), await changeSet(b)];
    expect(rowA?.hash).toMatch(/^sha256:/);
    expect(rowA?.hash).toBe(rowB?.hash);
    expect(rowA?.stats.excluded).toEqual({ no_change: 1 });
  });

  it('CS-2 SEC-1 records of another brand returned by an upstream that ignores the filter end out_of_scope with no values', async () => {
    honourBrand = false;
    const { result } = await call('shop.update_content', { brand: 'acme', skus: ['acme-1', 'globex-1'], changes: { description: 'Updated' } });
    const id = changesetId(result);
    expect((await changeSet(id))?.status).toBe('prepared');
    expect(await items(id)).toEqual([
      { target_id: 'acme-1', status: 'pending', reason: null, before: { description: 'Heavy anvil' }, after: { description: 'Updated' } },
      { target_id: 'globex-1', status: 'excluded', reason: 'out_of_scope', before: null, after: null },
    ]);
    expect(JSON.stringify(await items(id))).not.toContain('Round globe');
    expect(result.content[0]?.text).toContain('1 change(s) to apply, 1 excluded (out_of_scope 1)');
  });

  it('POL-2 a brand outside the scope is denied by policy and no change-set is created', async () => {
    const before = await query<{ n: string }>('select count(*)::text as n from change_set');
    const { result } = await call('shop.update_content', { brand: 'initech', skus: ['acme-1'], changes: { name: 'X' } });
    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toBe("Denied by policy: argument 'brand' is outside your scope (rule role:content_manager/grant:own-brands/scope:brand)");
    expect(await query<{ n: string }>('select count(*)::text as n from change_set')).toEqual(before);
    expect(upstream.requests).toEqual([]);
  });

  it('OPS-4 without SKUs the selector resolves the targets page by page', async () => {
    const { result } = await call('shop.update_content', { brand: 'acme', changes: { description: 'Bulk text' } });
    const id = changesetId(result);
    expect((await changeSet(id))?.status).toBe('prepared');
    expect((await items(id)).map((i) => [i.target_id, i.status])).toEqual([
      ['acme-1', 'pending'],
      ['acme-2', 'pending'],
      ['acme-3', 'pending'],
    ]);
    const search = upstream.requests.find((r) => r.path === '/rest/V1/products/search');
    expect(search?.query.get('page')).toBe('1');
    expect(search?.query.get('page_size')).toBe('100');
    expect(search?.query.get('brand')).toBe('acme');
    expect(upstream.requests.every((r) => r.method === 'GET')).toBe(true);
  });

  it('CS-1 SEC-3 an upstream 404 answers with a fixed error naming the status and the change-set ID, and marks it failed', async () => {
    upstream.route('GET', '/rest/V1/products', () => ({ status: 404, body: { error: 'database exploded at row Anvil' } }));
    const { result, correlationId } = await call('shop.update_content', { brand: 'acme', skus: ['acme-1'], changes: { name: 'New name' } });
    expect(result.isError).toBe(true);
    const text = result.content[0]?.text ?? '';
    const id = UUID.exec(text)?.[0] ?? '';
    expect(text).toBe(`shop.update_content failed: the upstream system answered HTTP 404 (change-set ${id}).`);
    expect(result.structuredContent).toEqual({ changeset: { id, status: 'failed', errorCode: 'http_status' } });
    expect(JSON.stringify(result)).not.toContain('exploded');
    const row = await changeSet(id);
    expect(row?.status).toBe('failed');
    expect(row?.error_code).toBe('http_status');
    const [audit] = await auditRows(databaseUrl, "correlation_id = $1 and action = 'tool.call'", [correlationId]);
    expect(audit?.outcome).toBe('error');
    expect(audit?.details).toMatchObject({ operation: 'shop.update_content', connection: 'shop', changesetId: id, errorCode: 'http_status', upstreamStatus: 404 });
    expect(JSON.stringify(audit)).not.toContain('exploded');
  });

  it('AUD-1 tool.call and changeset.transition rows share the correlation ID; log lines carry method GET and no values', async () => {
    const { result, correlationId } = await call('shop.update_content', { brand: 'acme', skus: ['acme-1', 'acme-2'], changes: { name: 'Shiny name' } });
    const id = changesetId(result);
    const rows = await auditRows(databaseUrl, 'correlation_id = $1', [correlationId]);
    expect(rows.map((r) => [r.action, r.details.to ?? null])).toEqual([
      ['policy.decision', null],
      ['changeset.transition', 'preparing'],
      ['changeset.transition', 'prepared'],
      ['tool.call', null],
    ]);
    const toolCall = rows.at(-1);
    expect(toolCall?.details).toMatchObject({ operation: 'shop.update_content', connection: 'shop', changesetId: id, included: 2, excluded: 0 });
    for (const r of rows) expect(JSON.stringify(r)).not.toContain('Shiny');

    const lines = logLines.filter((l) => l.includes(correlationId));
    const upstreamLines = lines.map((l) => JSON.parse(l) as Record<string, unknown>).filter((l) => l.msg === 'upstream call completed');
    expect(upstreamLines).toHaveLength(1);
    expect(upstreamLines[0]).toMatchObject({ operation: 'shop.get_products', connection: 'shop', method: 'GET', status: 200 });
    for (const line of lines) {
      expect(line).toContain('"method":"GET"');
      for (const value of ['Shiny', 'Anvil', 'Rocket', 'acme-1', UPSTREAM_TOKEN]) expect(line).not.toContain(value);
    }
  });

  it('SEC-1 a configuration reload while the reader is in flight does not change the config hash or expiry of the change-set', async () => {
    const holder = api.app.get<ConfigurationHolder>(CONFIGURATION);
    const hashBefore = holder.current.hash;
    const operations = join(configDir, 'operations.yaml');
    const original = await readFile(operations, 'utf8');
    productsDelayMs = 1500;
    try {
      const pending = call('shop.update_content', { brand: 'acme', skus: ['acme-1'], changes: { name: 'New name' } });
      for (let i = 0; i < 100 && upstream.requests.length === 0; i++) await sleep(20);
      expect(upstream.requests).toHaveLength(1);
      await writeFile(operations, original.replace('expire_after_hours: 72', 'expire_after_hours: 24'));
      expect(await reloadConfiguration(api)).toEqual({ ok: true });
      expect(holder.current.hash).not.toBe(hashBefore);

      const { result } = await pending;
      const row = await changeSet(changesetId(result));
      expect(row?.status).toBe('prepared');
      expect(row?.config_hash).toBe(hashBefore);
      expect((row?.expires_at.getTime() ?? 0) - (row?.created_at.getTime() ?? 0)).toBe(72 * 3_600_000);
    } finally {
      await writeFile(operations, original);
      await reloadConfiguration(api);
    }
  });
});
