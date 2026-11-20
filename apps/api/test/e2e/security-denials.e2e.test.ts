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
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startFakeUpstream, startTestIssuer, type FakeUpstream, type StartedPostgres, type TestIssuer } from '@aiops/testing';
import { auditRows, modernRequest, rawPost, startApi, startDatabase, tokenFor, vaultOf, type AuditRow, type RunningApi } from './helpers.js';

const SECURITY_CONFIG = fileURLToPath(new URL('./fixtures/security-config', import.meta.url));
const TOOL = 'catalog.search_products';

let postgres: StartedPostgres;
let databaseUrl: string;
let issuer: TestIssuer;
let upstream: FakeUpstream;
let configDir: string;
let api: RunningApi;

beforeAll(async () => {
  ({ postgres, databaseUrl } = await startDatabase());
  issuer = await startTestIssuer();
  upstream = await startFakeUpstream();
  upstream.route('GET', '/rest/V1/products', () => ({ status: 200, body: { items: [], total_count: 0 } }));
  configDir = await mkdtemp(join(tmpdir(), 'aiops-security-denials-e2e-'));
  await cp(SECURITY_CONFIG, configDir, { recursive: true });
  const connections = join(configDir, 'connections.yaml');
  await writeFile(connections, (await readFile(connections, 'utf8')).replaceAll('__UPSTREAM_URL__', upstream.url));
  api = await startApi(databaseUrl, { issuer, configDir });
  await vaultOf(api).put({ ref: 'shop-token', scheme: 'bearer', secret: { token: 'e2e-only-upstream-token-security' }, actor: 'e2e-setup' });
});

afterAll(async () => {
  await api.close();
  await upstream.close();
  await issuer.close();
  await postgres.stop();
  await rm(configDir, { recursive: true });
});

interface Answer {
  readonly error?: { readonly code: number; readonly message: string };
  readonly result?: { readonly isError?: boolean; readonly content?: { text?: string }[] };
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
