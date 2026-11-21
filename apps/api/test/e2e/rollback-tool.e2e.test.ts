// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The AI Operations Layer Authors
/**
 * `rollback_changeset` and the rollback block of `get_changeset` end to end over the real MCP
 * transport, against PostgreSQL with the in-memory executor (MCP-8, UI-4, SEC-1, MCP-6, AUD-1).
 * Change-sets are seeded as executed; the tool only checks and links to the page.
 */
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDb, PostgresChangeSetRepository, type Database } from '@aiops/db';
import { startTestIssuer, type StartedPostgres, type TestIssuer } from '@aiops/testing';
import { seedExecuted } from './approval-seed.js';
import { auditRows, connectClient, startApi, startDatabase, tokenFor, type RunningApi } from './helpers.js';

const CONFIG = fileURLToPath(new URL('./fixtures/approvals-pages-config', import.meta.url));
const DAY = 86_400_000;

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
let alice: string;
let bob: string;

beforeAll(async () => {
  ({ postgres, databaseUrl } = await startDatabase());
  issuer = await startTestIssuer();
  seedDb = createDb(databaseUrl, { onError: () => undefined });
  repo = new PostgresChangeSetRepository(seedDb.db);
  api = await startApi(databaseUrl, { issuer, configDir: CONFIG });
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

const link = (id: string): string => `${api.url}/app/changesets/${id}`;
const first = (r: ToolResult): string => r.content[0]?.text ?? '';

describe('MCP-8 rollback_changeset end to end', () => {
  it('MCP-8 SEC-1 rollback_changeset is listed to every caller and answers the page link', async () => {
    for (const token of [alice, bob]) {
      const client = await connectClient({ era: 'modern', baseUrls: [api.url], token });
      try {
        const tool = (await client.listTools()).tools.find((t) => t.name === 'rollback_changeset');
        expect(tool?.annotations?.readOnlyHint).toBe(false);
        expect(tool?.inputSchema.required).toEqual(['changeset_id', 'hash']);
      } finally {
        await client.close();
      }
    }

    // Whole milliseconds survive the round trip through timestamptz.
    const until = new Date(Math.floor((Date.now() + 7 * DAY) / 1000) * 1000);
    const seeded = await seedExecuted(repo, { requester: 'alice-id', items: 3, rollbackUntil: until });
    const before = await repo.get(seeded.id);

    const ok = (await call(alice, 'rollback_changeset', { changeset_id: seeded.id, hash: seeded.hash })).result;
    expect(ok.isError).toBeUndefined();
    expect(first(ok)).toBe(`Rollback of 3 item(s) of change-set ${seeded.id} is possible until ${until.toISOString()}. Confirm it on the page: ${link(seeded.id)}`);
    expect(ok.structuredContent).toEqual({
      changesetId: seeded.id,
      status: 'completed',
      rollback: { available: true, count: 3, until: until.toISOString() },
      pageUrl: link(seeded.id),
    });

    // UI-4: get_changeset reports the same block, without a hash.
    const read = (await call(alice, 'get_changeset', { changeset_id: seeded.id })).result;
    expect(read.structuredContent?.rollback).toEqual({ available: true, count: 3, until: until.toISOString() });

    // SEC-1: someone else's change-set is not found, and no link names it.
    const foreign = (await call(bob, 'rollback_changeset', { changeset_id: seeded.id, hash: seeded.hash })).result;
    expect(foreign).toMatchObject({ isError: true, content: [{ type: 'text', text: `Change-set ${seeded.id} was not found.` }] });
    expect(JSON.stringify(foreign)).not.toContain('/app/changesets/');

    // The tool never changes state.
    expect(await repo.get(seeded.id)).toEqual(before);
  });

  it('MCP-8 AUD-1 the tool.call row carries the refusal code and no target ids', async () => {
    // No window opened: the refusal is window_closed after the requester check, so it links (MCP-6).
    const closed = await seedExecuted(repo, { requester: 'alice-id', items: 2 });
    const refused = await call(alice, 'rollback_changeset', { changeset_id: closed.id, hash: closed.hash });
    expect(refused.result.isError).toBe(true);
    expect(first(refused.result)).toBe(`The rollback window of change-set ${closed.id} has closed. Open: ${link(closed.id)}`);
    expect(refused.result.structuredContent).toEqual({
      changesetId: closed.id,
      rollback: { available: false, reason: 'window_closed' },
      pageUrl: link(closed.id),
    });

    const stale = await call(alice, 'rollback_changeset', { changeset_id: closed.id, hash: `sha256:${'0'.repeat(64)}` });
    expect(first(stale.result)).toBe(`The change-set changed; review it again. Open: ${link(closed.id)}`);

    for (const [{ correlationId }, code] of [
      [refused, 'not_rollbackable'],
      [stale, 'hash_mismatch'],
    ] as const) {
      const rows = await auditRows(databaseUrl, 'correlation_id = $1', [correlationId]);
      const toolCall = rows.filter((r) => r.action === 'tool.call');
      expect(toolCall).toHaveLength(1);
      expect(toolCall[0]?.outcome).toBe('error');
      expect(toolCall[0]?.details).toMatchObject({ errorCode: code });
      // Nothing but the call itself and its policy decision: the tool writes nothing (SEC-3: no target IDs, hash or link).
      for (const row of rows) {
        const text = JSON.stringify(row);
        expect(text).not.toContain('SKU-');
        expect(text).not.toContain(closed.hash);
        expect(text).not.toContain('/app/changesets/');
      }
      expect(rows.map((r) => r.action).filter((a) => a.startsWith('changeset.'))).toEqual([]);
    }
  });
});
