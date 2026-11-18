import { cp, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { READ_RESULT_TEXT } from '@aiops/core';
import { startFakeUpstream, startTestIssuer, type FakeUpstream, type StartedPostgres, type TestIssuer } from '@aiops/testing';
import { auditRows, connectClient, startApi, startDatabase, tokenFor, vaultOf, type RunningApi } from './helpers.js';

const CHANGESET_CONFIG = fileURLToPath(new URL('./fixtures/changeset-config', import.meta.url));
const UNKNOWN_ID = '99999999-9999-4999-8999-999999999999';

let postgres: StartedPostgres;
let databaseUrl: string;
let issuer: TestIssuer;
let upstream: FakeUpstream;
let api: RunningApi;
let configDir: string;
let alice: string;
let bob: string;

interface ToolResult {
  isError?: boolean;
  content: { type: string; text: string }[];
  structuredContent?: Record<string, unknown>;
}

const SKUS = ['acme-1', 'acme-2', 'acme-3', 'acme-4', 'acme-5'];

beforeAll(async () => {
  ({ postgres, databaseUrl } = await startDatabase());
  issuer = await startTestIssuer();
  upstream = await startFakeUpstream();
  configDir = await mkdtemp(join(tmpdir(), 'aiops-changeset-tools-e2e-'));
  await cp(CHANGESET_CONFIG, configDir, { recursive: true });
  const connections = join(configDir, 'connections.yaml');
  await writeFile(connections, (await readFile(connections, 'utf8')).replaceAll('__UPSTREAM_URL__', upstream.url));
  api = await startApi(databaseUrl, { issuer, configDir });
  await vaultOf(api).put({ ref: 'shop-token', scheme: 'bearer', secret: { token: 'e2e-only-upstream-token-tools' }, actor: 'e2e-setup' });
  alice = await tokenFor(issuer, api, 'alice-id', ['content']);
  bob = await tokenFor(issuer, api, 'bob-id', []);
  upstream.route('GET', '/rest/V1/products', (req) => {
    const skus = (req.query.get('skus') ?? '').split(',');
    const items = skus.map((sku) => ({ sku, brand: 'acme', name: `Old ${sku}`, description: 'd' }));
    return { status: 200, body: { items, total_count: items.length } };
  });
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

async function sql(text: string, params: unknown[] = []): Promise<void> {
  const client = new pg.Client({ connectionString: databaseUrl });
  await client.connect();
  try {
    await client.query(text, params);
  } finally {
    await client.end();
  }
}

async function prepare(): Promise<string> {
  const { result } = await call(alice, 'shop.update_content', { brand: 'acme', skus: SKUS, changes: { name: 'New name' } });
  return (result.structuredContent?.changeset as { id: string }).id;
}

const text = (r: ToolResult): string => r.content[0]?.text ?? '';

describe('MCP-8 built-in change-set tools', () => {
  it('MCP-8 list_my_operations returns the caller granted operations with scope and fields', async () => {
    const { result, correlationId } = await call(alice, 'list_my_operations', {});
    expect(result.isError).toBeUndefined();
    expect(text(result)).toBe('You can use 1 operation(s): shop.update_content (write).');
    expect(result.structuredContent).toEqual({
      operations: [
        {
          tool: 'shop.update_content',
          operation: 'shop.update_content',
          title: 'Update product content',
          risk: 'write',
          description: 'Change product names and descriptions.',
          grants: [{ scope: { brand: ['acme', 'globex'] }, denyFields: [] }],
        },
      ],
    });
    const rows = await auditRows(databaseUrl, 'correlation_id = $1', [correlationId]);
    expect(rows.map((r) => r.action)).toEqual(['policy.decision', 'tool.call']);
    expect(rows[0]?.details).toMatchObject({ rule: 'builtin' });
    expect((await call(bob, 'list_my_operations', {})).result.structuredContent).toEqual({ operations: [] });
  });

  it('MCP-8 tools/list shows the built-in tools to every authenticated user', async () => {
    const client = await connectClient({ era: 'modern', baseUrls: [api.url], token: bob });
    try {
      const names = (await client.listTools()).tools.map((t) => t.name);
      expect(names).toEqual(expect.arrayContaining(['ping', 'list_my_operations', 'get_changeset', 'cancel_changeset']));
    } finally {
      await client.close();
    }
  });

  it('MCP-8 cancel_changeset is announced as not read-only; the reading built-ins stay read-only', async () => {
    const client = await connectClient({ era: 'modern', baseUrls: [api.url], token: bob });
    try {
      const hints = Object.fromEntries((await client.listTools()).tools.map((t) => [t.name, t.annotations?.readOnlyHint]));
      expect(hints).toMatchObject({ ping: true, list_my_operations: true, get_changeset: true, cancel_changeset: false });
    } finally {
      await client.close();
    }
  });

  it('MCP-8 get_changeset gives the header and pages with a cursor, and filters by status', async () => {
    const id = await prepare();
    const first = await call(alice, 'get_changeset', { changeset_id: id, page_size: 3 });
    expect(first.result.isError).toBeUndefined();
    expect(text(first.result)).toBe(
      `Change-set ${id} (shop.update_content) is prepared: 5 change(s), 0 excluded. Showing 3 item(s); more with cursor. ${READ_RESULT_TEXT.dataNote} ` +
        `Open: ${api.url}/app/changesets/${id}`,
    );
    const s1 = first.result.structuredContent as { changeset: { status: string; hash: string }; items: { targetId: string }[]; nextCursor?: string };
    expect(s1.changeset).toMatchObject({ id, status: 'prepared', operation: 'shop.update_content' });
    expect(s1.changeset.hash).toMatch(/^sha256:/);
    expect(s1.items.map((i) => i.targetId)).toEqual(SKUS.slice(0, 3));
    expect(JSON.parse(first.result.content[1]?.text ?? '')).toEqual(first.result.structuredContent);

    const second = await call(alice, 'get_changeset', { changeset_id: id, page_size: 3, cursor: s1.nextCursor });
    const s2 = second.result.structuredContent as { items: { targetId: string }[]; nextCursor?: string };
    expect(s2.items.map((i) => i.targetId)).toEqual(SKUS.slice(3));
    expect(s2.nextCursor).toBeUndefined();
    expect(text(second.result)).not.toContain('more with cursor');

    const filtered = await call(alice, 'get_changeset', { changeset_id: id, status: 'written' });
    expect((filtered.result.structuredContent as { items: unknown[] }).items).toEqual([]);

    const rows = await auditRows(databaseUrl, "correlation_id = $1 and action = 'tool.call'", [first.correlationId]);
    expect(rows[0]?.details).toMatchObject({ changesetId: id });
  });

  it('MCP-8 an invalid cursor is a validation-style error that does not echo it', async () => {
    const id = await prepare();
    const { result } = await call(alice, 'get_changeset', { changeset_id: id, cursor: 'not*a*cursor' });
    expect(result.isError).toBe(true);
    expect(text(result)).toBe('Input validation error: Invalid arguments for tool get_changeset: cursor is not valid');
  });

  it('MCP-8 SEC-1 another user and an unknown ID get the same not-found answer', async () => {
    const id = await prepare();
    for (const [token, target] of [[bob, id], [alice, UNKNOWN_ID]] as const) {
      for (const tool of ['get_changeset', 'cancel_changeset']) {
        const { result } = await call(token, tool, { changeset_id: target });
        expect(result.isError).toBe(true);
        expect(text(result)).toBe(`Change-set ${target} was not found.`);
      }
    }
    const { result } = await call(alice, 'get_changeset', { changeset_id: id });
    expect(result.structuredContent?.changeset).toMatchObject({ status: 'prepared' });
  });

  it('CS-6 an expired change-set reads as expired and is audited with actor system', async () => {
    const id = await prepare();
    // expires_at is immutable through the application; the test database owner switches the guard off for one update.
    await sql('alter table change_set disable trigger user');
    try {
      await sql("update change_set set expires_at = now() - interval '1 minute' where id = $1", [id]);
    } finally {
      await sql('alter table change_set enable trigger user');
    }
    const { result, correlationId } = await call(alice, 'get_changeset', { changeset_id: id });
    expect(result.structuredContent?.changeset).toMatchObject({ status: 'expired' });
    const rows = await auditRows(databaseUrl, "correlation_id = $1 and action = 'changeset.transition'", [correlationId]);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ actor: 'system', details: { from: 'prepared', to: 'expired' } });
    const cancel = await call(alice, 'cancel_changeset', { changeset_id: id });
    expect(cancel.result.isError).toBe(true);
    expect(text(cancel.result)).toBe(`Change-set ${id} cannot be cancelled in status expired.`);
  });

  it('MCP-8 CS-6 cancel_changeset cancels once, audited with the caller as actor', async () => {
    const id = await prepare();
    const { result, correlationId } = await call(alice, 'cancel_changeset', { changeset_id: id });
    expect(result.isError).toBeUndefined();
    expect(text(result)).toBe(`Change-set ${id} was cancelled.`);
    const rows = await auditRows(databaseUrl, 'correlation_id = $1', [correlationId]);
    expect(rows.map((r) => r.action)).toEqual(['policy.decision', 'changeset.transition', 'tool.call']);
    expect(rows[1]).toMatchObject({ actor: 'alice-id', details: { from: 'prepared', to: 'cancelled' } });
    expect(rows[2]?.details).toMatchObject({ changesetId: id });
    const again = await call(alice, 'cancel_changeset', { changeset_id: id });
    expect(again.result.isError).toBe(true);
    expect(text(again.result)).toBe(`Change-set ${id} cannot be cancelled in status cancelled.`);
  });

  it('MCP-8 SEC-1 CS-6 a foreign caller cannot expire or cancel an overdue change-set: same answer as an unknown ID, no transition written', async () => {
    const id = await prepare();
    await sql('alter table change_set disable trigger user');
    try {
      await sql("update change_set set expires_at = now() - interval '1 minute' where id = $1", [id]);
    } finally {
      await sql('alter table change_set enable trigger user');
    }
    for (const tool of ['get_changeset', 'cancel_changeset']) {
      const foreign = (await call(bob, tool, { changeset_id: id })).result;
      const unknown = (await call(bob, tool, { changeset_id: UNKNOWN_ID })).result;
      expect(foreign.isError).toBe(true);
      expect(foreign.isError).toBe(unknown.isError);
      expect(foreign.structuredContent).toEqual(unknown.structuredContent);
      expect(text(foreign)).toBe(`Change-set ${id} was not found.`);
      expect(text(unknown)).toBe(`Change-set ${UNKNOWN_ID} was not found.`);
    }
    // Only the preparation transitions exist; neither bob nor the system touched it.
    const transitions = await auditRows(databaseUrl, "action = 'changeset.transition' and changeset_id = $1", [id]);
    expect(transitions.map((r) => r.details.to)).toEqual(['preparing', 'prepared']);
    const client = new pg.Client({ connectionString: databaseUrl });
    await client.connect();
    try {
      expect((await client.query<{ status: string }>('select status from change_set where id = $1', [id])).rows[0]?.status).toBe('prepared');
    } finally {
      await client.end();
    }
  });
});
