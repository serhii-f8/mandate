import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDb, PostgresChangeSetRepository, type Database } from '@aiops/db';
import { startTestIssuer, type StartedPostgres, type TestIssuer } from '@aiops/testing';
import { seedPrepared, type Seeded } from './approval-seed.js';
import { auditRows, connectClient, startApi, startDatabase, tokenFor, type RunningApi } from './helpers.js';
import { RecordingStarter } from './recording-starter.js';

const CONFIG = fileURLToPath(new URL('./fixtures/approvals-pages-config', import.meta.url));
const UNKNOWN_ID = '99999999-9999-4999-8999-999999999999';

interface ToolResult {
  isError?: boolean;
  content: { type: string; text: string }[];
  structuredContent?: Record<string, unknown>;
}

let postgres: StartedPostgres;
let databaseUrl: string;
let issuer: TestIssuer;
let api: RunningApi;
let seedDb: Database;
let repo: PostgresChangeSetRepository;
let starter: RecordingStarter;
let alice: string;
let bob: string;

beforeAll(async () => {
  ({ postgres, databaseUrl } = await startDatabase());
  issuer = await startTestIssuer();
  seedDb = createDb(databaseUrl, { onError: () => undefined });
  repo = new PostgresChangeSetRepository(seedDb.db);
  starter = new RecordingStarter();
  api = await startApi(databaseUrl, { issuer, configDir: CONFIG, starter });
  alice = await tokenFor(issuer, api, 'alice-id', ['content']);
  bob = await tokenFor(issuer, api, 'bob-id', ['support']);
});

afterAll(async () => {
  await api.close();
  await seedDb.close();
  await issuer.close();
  await postgres.stop();
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

/** 3 included items (SKU-0001..0003) plus SKU-0004 excluded as `not_found`. */
const seed = (): Promise<Seeded> => seedPrepared(repo, { requester: 'alice-id', items: 3, excluded: 1 });

const exclude = (token: string, s: { id: string; hash: string }, args: { exclude?: string[]; include?: string[] }) =>
  call(token, 'exclude_changeset_items', { changeset_id: s.id, hash: s.hash, ...args });

interface Derived {
  readonly id: string;
  readonly hash: string;
  readonly derivedFrom: unknown;
}

function derivedOf(result: ToolResult): Derived {
  expect(result.isError).toBeUndefined();
  const structured = result.structuredContent ?? {};
  const changeset = structured.changeset as { id: string; hash: string };
  return { id: changeset.id, hash: changeset.hash, derivedFrom: structured.derivedFrom };
}

describe('CS-5 MCP-8 exclude_changeset_items end to end', () => {
  it('CS-5 excluding one item yields a new change-set and hash; the source is unchanged', async () => {
    const source = await seed();
    const { result } = await exclude(alice, source, { exclude: ['SKU-0001'] });
    const derived = derivedOf(result);
    expect(derived.id).not.toBe(source.id);
    expect(derived.hash).not.toBe(source.hash);
    expect(derived.hash).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(derived.derivedFrom).toBe(source.id);
    expect(await repo.get(source.id)).toMatchObject({ status: 'prepared', hash: source.hash });
    expect(await repo.get(derived.id)).toMatchObject({ status: 'prepared', hash: derived.hash, derivedFrom: source.id, stats: { included: 2 } });
    expect(starter.started).toContain(derived.id);
    expect(result.content[1]?.text).toBe(JSON.stringify(result.structuredContent));
  });

  it('CS-5 the derived change-set can be submitted and the source still can too', async () => {
    const source = await seed();
    const derived = derivedOf((await exclude(alice, source, { exclude: ['SKU-0002'] })).result);
    const { result } = await call(alice, 'submit_for_approval', { changeset_id: derived.id, hash: derived.hash });
    expect(result.isError).toBeUndefined();
    expect(result.structuredContent).toMatchObject({ changesetId: derived.id, status: 'executing' });
    expect((await repo.get(source.id))?.status).toBe('prepared');
  });

  it('CS-5 deriving from a derived change-set and including back gives the source hash under a new ID', async () => {
    const source = await seed();
    const first = derivedOf((await exclude(alice, source, { exclude: ['SKU-0001'] })).result);
    const second = derivedOf((await exclude(alice, first, { include: ['SKU-0001'] })).result);
    expect(second.id).not.toBe(source.id);
    expect(second.id).not.toBe(first.id);
    expect(second.hash).toBe(source.hash);
    expect(second.derivedFrom).toBe(first.id);
    expect((await repo.get(first.id))?.status).toBe('prepared');
  });

  it('CS-5 refusals: stale hash, nothing left, unknown items, foreign change-set as not found', async () => {
    const source = await seed();
    const stale = await exclude(alice, { id: source.id, hash: `sha256:${'0'.repeat(64)}` }, { exclude: ['SKU-0001'] });
    expect(stale.result).toMatchObject({ isError: true, content: [{ type: 'text', text: 'The change-set changed; review it again.' }] });
    const nothing = await exclude(alice, source, { exclude: ['SKU-0001', 'SKU-0002', 'SKU-0003'] });
    expect(nothing.result).toMatchObject({ isError: true, content: [{ type: 'text', text: 'Excluding these items would leave nothing to change.' }] });
    const unknown = await exclude(alice, source, { exclude: ['SKU-0004', 'SKU-9999'] });
    expect(unknown.result).toMatchObject({
      isError: true,
      content: [{ type: 'text', text: '2 of the named items cannot be changed: exclude only included items, include only items you excluded.' }],
    });
    const foreign = await exclude(bob, source, { exclude: ['SKU-0001'] });
    const missing = await exclude(bob, { id: UNKNOWN_ID, hash: source.hash }, { exclude: ['SKU-0001'] });
    expect(foreign.result.isError).toBe(true);
    expect(foreign.result.content).toEqual([{ type: 'text', text: `Change-set ${source.id} was not found.` }]);
    expect(missing.result.content).toEqual([{ type: 'text', text: `Change-set ${UNKNOWN_ID} was not found.` }]);
    expect(await repo.get(source.id)).toMatchObject({ status: 'prepared', hash: source.hash });
  });

  it('AUD-1 the tool.call row of an exclusion records the new id and counts only', async () => {
    const source = await seed();
    const { result, correlationId } = await exclude(alice, source, { exclude: ['SKU-0001'] });
    const derived = derivedOf(result);
    const rows = await auditRows(databaseUrl, 'correlation_id = $1', [correlationId]);
    const toolCall = rows.filter((r) => r.action === 'tool.call');
    expect(toolCall).toHaveLength(1);
    expect(toolCall[0]?.outcome).toBe('ok');
    expect(toolCall[0]?.details).toMatchObject({ changesetId: derived.id, derivedFrom: source.id, excludeCount: 1, includeCount: 0 });
    for (const row of rows) {
      expect(JSON.stringify(row)).not.toContain('SKU-0001');
      expect(JSON.stringify(row)).not.toContain(derived.hash);
    }
  });

  it('MCP-8 exclude_changeset_items is listed for every authenticated caller', async () => {
    for (const token of [alice, bob]) {
      const client = await connectClient({ era: 'modern', baseUrls: [api.url], token });
      try {
        const tool = (await client.listTools()).tools.find((t) => t.name === 'exclude_changeset_items');
        expect(tool?.annotations?.readOnlyHint).toBe(false);
      } finally {
        await client.close();
      }
    }
  });
});
