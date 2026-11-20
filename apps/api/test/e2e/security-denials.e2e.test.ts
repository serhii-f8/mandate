/**
 * Denial suite, part 1 (SEC-11): argument validation, grant, scope and field denials over the real
 * MCP transport. Every test asserts the answer, the audit rows the path really writes, and that
 * the fake upstream saw no request. Fixture `fixtures/security-config`: role `scoped` (scope
 * brand acme, deny_fields cost), `allowlisted` (allow_fields name, description), `nogrant`.
 *
 * The dry-run denial (POL-1 no_grant by `config explain`, POL-7) is pinned by the existing titles in
 * `src/cli-config.test.ts` (as-built names win, ADR 0053).
 */
import { cp, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDb, PostgresChangeSetRepository, type Database } from '@aiops/db';
import { InMemoryExecutor, pageLogin, ScriptedWriter, startFakeUpstream, startTestIssuer, type FakeUpstream, type StartedPostgres, type TestIssuer } from '@aiops/testing';
import { auditRows, modernRequest, rawPost, reloadConfiguration, startApi, startDatabase, tokenFor, vaultOf, type AuditRow, type RunningApi } from './helpers.js';

const SECURITY_CONFIG = fileURLToPath(new URL('./fixtures/security-config', import.meta.url));
const TOOL = 'catalog.search_products';

let postgres: StartedPostgres;
let databaseUrl: string;
let issuer: TestIssuer;
let upstream: FakeUpstream;
let configDir: string;
let api: RunningApi;
let seedDb: Database;
let writer: ScriptedWriter;
let executor: InMemoryExecutor;
/** Fixed wall clock of the rate limits (SEC-10, POL-4): one minute window, no wait on the real clock. */
const NOW = new Date('2026-11-20T12:00:30.000Z');
const wallClock = (): Date => new Date(NOW);

beforeAll(async () => {
  ({ postgres, databaseUrl } = await startDatabase());
  issuer = await startTestIssuer();
  upstream = await startFakeUpstream();
  configDir = await mkdtemp(join(tmpdir(), 'aiops-security-denials-e2e-'));
  await cp(SECURITY_CONFIG, configDir, { recursive: true });
  const connections = join(configDir, 'connections.yaml');
  await writeFile(connections, (await readFile(connections, 'utf8')).replaceAll('__UPSTREAM_URL__', upstream.url));
  upstream.route('GET', '/rest/V1/products', (req) => {
    const skus = (req.query.get('skus') ?? '').split(',').filter((sku) => sku !== '');
    const items = skus.map((sku) => ({ sku, brand: 'acme', name: `Old ${sku}` }));
    return { status: 200, body: { items, total_count: items.length } };
  });
  seedDb = createDb(databaseUrl, { onError: () => undefined });
  writer = new ScriptedWriter();
  executor = new InMemoryExecutor({ repository: new PostgresChangeSetRepository(seedDb.db), writer, batchSizeOf: () => 100 });
  api = await startApi(databaseUrl, { issuer, configDir, executor, wallClock });
  await vaultOf(api).put({ ref: 'shop-token', scheme: 'bearer', secret: { token: 'e2e-only-upstream-token-security' }, actor: 'e2e-setup' });
});

afterAll(async () => {
  await api.close();
  await seedDb.close();
  await upstream.close();
  await issuer.close();
  await postgres.stop();
  await rm(configDir, { recursive: true });
});

interface Answer {
  readonly error?: { readonly code: number; readonly message: string };
  readonly result?: { readonly isError?: boolean; readonly content?: { text?: string }[]; readonly structuredContent?: Record<string, unknown> };
  readonly rows: AuditRow[];
}

/** One tools/call as `sub` in `group`; returns the JSON-RPC answer and the audit rows of that request. */
async function callAs(sub: string, group: string, name: string, args: Record<string, unknown>): Promise<Answer> {
  const token = await tokenFor(issuer, api, sub, [group]);
  const { body, headers } = modernRequest('tools/call', { name, arguments: args });
  const response = await rawPost(api.url, body, { ...headers, authorization: `Bearer ${token}` });
  const json = (await response.json()) as Omit<Answer, 'rows'>;
  const rows = await auditRows(databaseUrl, 'correlation_id = $1', [response.headers.get('x-correlation-id')]);
  return { ...json, rows };
}

/** Runs `body` and asserts the fake upstream saw nothing during it. */
async function withoutUpstream<T>(body: () => Promise<T>): Promise<T> {
  const before = upstream.requests.length;
  const out = await body();
  expect(upstream.requests.length).toBe(before);
  return out;
}

function expectOneDeny(answer: Answer, subject: string, rule: string, reason: string): void {
  expect(answer.rows).toHaveLength(1);
  expect(answer.rows[0]).toMatchObject({ action: 'policy.decision', decision: 'deny', outcome: 'denied', subject, details: { rule, reason } });
}

/** Every denial row the suite caused: aggregated by POL-8 test. */
const denials: { answer: Answer; rule: string; reason: string }[] = [];

describe('SEC-11 MCP-3 argument validation', () => {
  it('SEC-11 MCP-3 invalid_arguments are refused before policy', async () => {
    const answer = await withoutUpstream(() => callAs('mcp3-user', 'scoped', TOOL, { brand: ['acme'], fields: [] }));
    expect(answer.result?.isError).toBe(true);
    expect(answer.result?.content?.[0]?.text).toMatch(/^Input validation error: Invalid arguments for tool catalog\.search_products/);
    expect(answer.rows.map((r) => r.action)).toEqual(['tool.call']);
    expect(answer.rows[0]).toMatchObject({ outcome: 'error', details: { errorCode: 'invalid_arguments' } });
  });
});

describe('SEC-11 POL-1 grants', () => {
  it('SEC-11 POL-1 unknown_tool: an ungranted tool is not listed and its call is refused as unknown', async () => {
    const token = await tokenFor(issuer, api, 'pol1-unknown', ['nogrant']);
    const { body, headers } = modernRequest('tools/list');
    const listed = (await (await rawPost(api.url, body, { ...headers, authorization: `Bearer ${token}` })).json()) as { result: { tools: { name: string }[] } };
    expect(listed.result.tools.map((t) => t.name)).not.toContain(TOOL);
    // A name that exists nowhere records unknown_tool; both answers are the same protocol error (MCP-2).
    const answer = await withoutUpstream(() => callAs('pol1-unknown', 'nogrant', 'catalog.nothing', {}));
    expect(answer.error).toMatchObject({ code: -32602, message: 'Tool catalog.nothing not found' });
    expectOneDeny(answer, 'catalog.nothing', 'default-deny', 'unknown_tool');
    denials.push({ answer, rule: 'default-deny', reason: 'unknown_tool' });
  });

  it('SEC-11 POL-1 no_grant: an existing ungranted tool is refused over MCP with default-deny', async () => {
    const answer = await withoutUpstream(() => callAs('pol1-nogrant', 'nogrant', TOOL, { brand: 'acme' }));
    expect(answer.error).toMatchObject({ code: -32602, message: `Tool ${TOOL} not found` });
    expectOneDeny(answer, TOOL, 'default-deny', 'no_grant');
    denials.push({ answer, rule: 'default-deny', reason: 'no_grant' });
  });
});

describe('SEC-11 POL-2 scope', () => {
  const rule = 'role:scoped/grant:acme-only/scope:brand';

  it('SEC-11 POL-2 out_of_scope', async () => {
    const answer = await withoutUpstream(() => callAs('pol2-out', 'scoped', TOOL, { brand: 'initech', fields: ['name'] }));
    expect(answer.result?.isError).toBe(true);
    expect(answer.result?.content?.[0]?.text).toContain(`rule ${rule}`);
    expectOneDeny(answer, TOOL, rule, 'out_of_scope');
    denials.push({ answer, rule, reason: 'out_of_scope' });
  });

  it('SEC-11 POL-2 scope_argument_missing', async () => {
    const answer = await withoutUpstream(() => callAs('pol2-missing', 'scoped', TOOL, { fields: ['name'] }));
    expect(answer.result?.isError).toBe(true);
    expectOneDeny(answer, TOOL, rule, 'scope_argument_missing');
    denials.push({ answer, rule, reason: 'scope_argument_missing' });
  });
});

describe('SEC-11 POL-3 fields', () => {
  it('SEC-11 POL-3 denied_field', async () => {
    const rule = 'role:scoped/grant:acme-only/deny_fields';
    const answer = await withoutUpstream(() => callAs('pol3-denied', 'scoped', TOOL, { brand: 'acme', fields: ['name', 'cost'] }));
    expect(answer.result?.isError).toBe(true);
    expectOneDeny(answer, TOOL, rule, 'denied_field');
    expect(answer.rows[0]?.details).toMatchObject({ detail: 'cost' });
    denials.push({ answer, rule, reason: 'denied_field' });
  });

  it('SEC-11 POL-3 field_not_allowed', async () => {
    const rule = 'role:allowlisted/grant:name-and-description/allow_fields';
    const answer = await withoutUpstream(() => callAs('pol3-allow', 'allowlisted', TOOL, { brand: 'acme', fields: ['name', 'price'] }));
    expect(answer.result?.isError).toBe(true);
    expectOneDeny(answer, TOOL, rule, 'field_not_allowed');
    expect(answer.rows[0]?.details).toMatchObject({ detail: 'price' });
    denials.push({ answer, rule, reason: 'field_not_allowed' });
  });
});

describe('SEC-11 POL-8 decisions', () => {
  it('SEC-11 POL-8 every MCP denial above wrote exactly one policy.decision row naming its rule', async () => {
    expect(denials.map((d) => d.reason).sort()).toEqual(['denied_field', 'field_not_allowed', 'no_grant', 'out_of_scope', 'scope_argument_missing', 'unknown_tool']);
    for (const { answer, rule, reason } of denials) {
      const row = answer.rows[0];
      const stored = await auditRows(databaseUrl, 'seq = $1', [row?.seq]);
      expect(stored).toHaveLength(1);
      expect(stored[0]).toMatchObject({ action: 'policy.decision', decision: 'deny', details: { rule, reason } });
      const sameRequest = await auditRows(databaseUrl, "correlation_id = $1 and action = 'policy.decision'", [row?.correlation_id]);
      expect(sameRequest).toHaveLength(1);
    }
  });
});

interface Prepared {
  readonly id: string;
  readonly hash: string;
}

/** Prepares `catalog.update_content` for `skus` as `sub` in `group` (reads the fake upstream). */
async function prepare(sub: string, group: string, skus: string[]): Promise<Prepared> {
  const answer = await callAs(sub, group, 'catalog.update_content', { brand: 'acme', skus, changes: { name: 'New name' } });
  expect(answer.result?.isError).toBeUndefined();
  const changeset = answer.result?.structuredContent?.changeset as { id: string; hash: string; status: string } | undefined;
  expect(changeset?.status).toBe('prepared');
  return { id: changeset?.id ?? '', hash: changeset?.hash ?? '' };
}

const submit = (sub: string, group: string, { id, hash }: Prepared): Promise<Answer> => callAs(sub, group, 'submit_for_approval', { changeset_id: id, hash });

async function changeSetRow(id: string): Promise<{ status: string; execution_actor: string | null }> {
  const client = new pg.Client({ connectionString: databaseUrl });
  await client.connect();
  try {
    const { rows } = await client.query<{ status: string; execution_actor: string | null }>('select status, execution_actor from change_set where id = $1', [id]);
    return rows[0] ?? { status: 'missing', execution_actor: null };
  } finally {
    await client.end();
  }
}

/** A submit refused by the executor: the deny row of the start names the role's limit (POL-4, POL-8). */
function expectLimitRefused(answer: Answer, sub: string, limit: string): void {
  expect(answer.result?.isError).toBe(true);
  expect(answer.result?.content?.[0]?.text).toMatch(new RegExp(`^Execution refused: limit ${limit} of role limited reached\\. `));
  const deny = answer.rows.filter((r) => r.action === 'policy.decision' && r.decision === 'deny');
  expect(deny).toHaveLength(1);
  expect(deny[0]).toMatchObject({ actor: sub, outcome: 'denied', subject: 'catalog.update_content', details: { rule: `role:limited/limit:${limit}`, reason: 'limit_exceeded' } });
  expect(answer.rows.find((r) => r.action === 'tool.call')?.details).toMatchObject({ errorCode: 'limit_exceeded' });
}

describe('SEC-11 POL-4 limits', () => {
  // The first execution of the file is held by the writer, so this test runs before every other one that executes.
  it('SEC-11 POL-4 limit_exceeded/concurrent_executions', async () => {
    const sub = 'pol4-concurrent';
    const first = await prepare(sub, 'limited', ['conc-1']);
    const second = await prepare(sub, 'limited', ['conc-2']);
    const hold = writer.pauseAt(0);
    const started = await submit(sub, 'limited', first);
    expect(started.result?.isError).toBeUndefined();
    await hold.reached;
    expect((await changeSetRow(first.id)).status).toBe('executing');
    const answer = await withoutUpstream(() => submit(sub, 'limited', second));
    expectLimitRefused(answer, sub, 'concurrent_executions');
    expect((await changeSetRow(second.id)).status).toBe('prepared');
    hold.release();
    await executor.settled(first.id);
    expect((await changeSetRow(first.id)).status).toBe('completed');
  });

  it('SEC-11 POL-4 limit_exceeded/records_per_operation', async () => {
    const sub = 'pol4-operation';
    const prepared = await prepare(sub, 'limited', ['op-1', 'op-2', 'op-3', 'op-4']);
    const answer = await withoutUpstream(() => submit(sub, 'limited', prepared));
    expectLimitRefused(answer, sub, 'records_per_operation');
    expect((await changeSetRow(prepared.id)).status).toBe('prepared');
  });

  it('SEC-11 POL-4 limit_exceeded/records_per_day', async () => {
    const sub = 'pol4-day';
    const first = await prepare(sub, 'limited', ['day-1', 'day-2', 'day-3']);
    const second = await prepare(sub, 'limited', ['day-4', 'day-5', 'day-6']);
    expect((await submit(sub, 'limited', first)).result?.isError).toBeUndefined();
    await executor.settled(first.id);
    const answer = await withoutUpstream(() => submit(sub, 'limited', second));
    expectLimitRefused(answer, sub, 'records_per_day');
    expect((await changeSetRow(second.id)).status).toBe('prepared');
  });

  it('SEC-11 POL-4 limit_exceeded/calls_per_minute', async () => {
    const sub = 'pol4-calls';
    const args = { brand: 'acme', fields: ['name'] };
    for (let i = 0; i < 2; i++) {
      expect((await callAs(sub, 'ratelimited', TOOL, args)).result?.isError).toBeUndefined();
    }
    const answer = await withoutUpstream(() => callAs(sub, 'ratelimited', TOOL, args));
    expect(answer.result?.isError).toBe(true);
    expect(answer.result?.content?.[0]?.text).toContain('rule role:ratelimited/limit:calls_per_minute');
    expectOneDeny(answer, TOOL, 'role:ratelimited/limit:calls_per_minute', 'limit_exceeded');
    expect(answer.rows[0]?.details).toMatchObject({ detail: 'calls_per_minute' });
  });
});

describe('SEC-11 POL-5 approval', () => {
  it('SEC-11 POL-5 approval_required: a change-set above the threshold does not execute', async () => {
    const sub = 'pol5-gated';
    const prepared = await prepare(sub, 'gated', ['gate-1', 'gate-2']);
    const answer = await withoutUpstream(() => submit(sub, 'gated', prepared));
    expect(answer.result?.isError).toBeUndefined();
    expect(answer.result?.structuredContent).toMatchObject({ changesetId: prepared.id, status: 'pending_approval', total: 2 });
    expect(answer.rows.map((r) => r.action)).toContain('approval.requested');
    expect(answer.rows.filter((r) => r.action === 'changeset.transition').map((r) => r.details)).toMatchObject([{ from: 'prepared', to: 'pending_approval' }]);
    expect(answer.rows.some((r) => r.details.to === 'executing')).toBe(false);
    expect(await changeSetRow(prepared.id)).toEqual({ status: 'pending_approval', execution_actor: null });
  });

  it('SEC-11 POL-5 not_approved: the page start route refuses without approval rows', async () => {
    const sub = 'pol5-notapproved';
    const prepared = await prepare(sub, 'gated', ['na-1', 'na-2']);
    expect((await submit(sub, 'gated', prepared)).result?.structuredContent).toMatchObject({ status: 'pending_approval' });
    // Forced: approved without any approval row, as a corrupted or tampered store would show it.
    const client = new pg.Client({ connectionString: databaseUrl });
    await client.connect();
    try {
      await client.query("update change_set set status = 'approved' where id = $1", [prepared.id]);
    } finally {
      await client.end();
    }
    const user = { sub: 'pol5-approver', username: 'pol5-approver', groups: ['approvers'] };
    issuer.setLoginUser(user);
    const page = await pageLogin(api.url, user.username, 'unused', { fresh: true });
    const response = await withoutUpstream(() =>
      fetch(`${api.url}/api/v1/changesets/${prepared.id}/start`, {
        method: 'POST',
        redirect: 'manual',
        headers: { cookie: page.cookie, origin: new URL(api.url).origin, 'x-csrf-token': page.csrfToken, 'content-type': 'application/json' },
        body: '{}',
      }),
    );
    expect({ status: response.status, body: await response.json() }).toEqual({ status: 409, body: { error: 'not_approved' } });
    const rows = await auditRows(databaseUrl, 'correlation_id = $1', [response.headers.get('x-correlation-id')]);
    expect(rows.map((r) => ({ action: r.action, outcome: r.outcome, actor: r.actor, reason: r.details.reason }))).toEqual([
      { action: 'changeset.start', outcome: 'denied', actor: user.sub, reason: 'not_approved' },
    ]);
    expect((await changeSetRow(prepared.id)).status).toBe('approved');
  });

  // approval_unroutable is unreachable through a loaded configuration (POL-5: the loader rejects a write
  // grant without steps), so only the snapshot-level unit test `src/mcp/submit-tool.test.ts` can prove it.
});

describe('SEC-11 POL-6 re-evaluation', () => {
  it('SEC-11 POL-6 a role removed after preparation is refused at submit', async () => {
    const sub = 'pol6-revoked';
    const prepared = await prepare(sub, 'revocable', ['rev-1']);
    const roles = join(configDir, 'roles.yaml');
    const original = await readFile(roles, 'utf8');
    const grant = '{ operation: catalog.update_content, id: revocable-writes }';
    expect(original).toContain(grant);
    await writeFile(roles, original.replace(`grants:\n      - ${grant}`, 'grants: []'));
    try {
      expect(await reloadConfiguration(api)).toEqual({ ok: true });
      const answer = await withoutUpstream(() => submit(sub, 'revocable', prepared));
      expect(answer.result?.isError).toBe(true);
      // The pipeline's own allow row for the built-in tool precedes the submit's deny row (POL-8).
      expect(answer.rows.filter((r) => r.action === 'policy.decision').map((r) => r.decision)).toEqual(['allow', 'deny']);
      const deny = answer.rows.filter((r) => r.decision === 'deny');
      expect(deny).toHaveLength(1);
      expect(deny[0]).toMatchObject({ decision: 'deny', outcome: 'denied', subject: 'submit_for_approval', details: { rule: 'default-deny', reason: 'no_grant' } });
      expect(answer.rows.find((r) => r.action === 'tool.call')?.details).toMatchObject({ errorCode: 'policy_denied' });
      expect(await changeSetRow(prepared.id)).toEqual({ status: 'prepared', execution_actor: null });
    } finally {
      await writeFile(roles, original);
      await reloadConfiguration(api);
    }
  });
});
