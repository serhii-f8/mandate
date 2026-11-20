/**
 * The official MCP conformance suite against the running api (NFR-16, MCP-1).
 *
 * The api runs on `conformance-config` (one read and one write operation on the fake upstream,
 * the widget bundles present). The suite cannot send a bearer token, so it talks to a test-only
 * proxy that adds one. The pinned CLI runs the frozen 2026-07-28 requirement set with the
 * reviewed baseline; the must-pass scenarios are then checked one by one in the result files.
 */
import { spawn } from 'node:child_process';
import { cp, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { parse } from 'yaml';
import { startFakeUpstream, startTestIssuer, type FakeUpstream, type StartedPostgres, type TestIssuer } from '@aiops/testing';
import { MUST_PASS } from '../conformance/must-pass.js';
import { startTokenProxy } from '../support/token-proxy.js';
import { startApi, startDatabase, vaultOf, type RunningApi } from './helpers.js';

const CONFIG = fileURLToPath(new URL('./fixtures/conformance-config', import.meta.url));
const WIDGET_DIR = fileURLToPath(new URL('./fixtures/widgets', import.meta.url));
const BASELINE_2026 = fileURLToPath(new URL('../conformance/expected-failures.2026-07-28.yaml', import.meta.url));
const PKG_DIR = dirname(createRequire(import.meta.url).resolve('@modelcontextprotocol/conformance/package.json'));

type CheckStatus = 'SUCCESS' | 'FAILURE' | 'WARNING' | 'SKIPPED' | 'INFO';
interface Check {
  readonly id: string;
  readonly status: CheckStatus;
  readonly errorMessage?: string;
}

let postgres: StartedPostgres;
let issuer: TestIssuer;
let upstream: FakeUpstream;
let api: RunningApi;
let proxy: { url: string; close(): Promise<void> };
let configDir: string;
let outDir: string;

beforeAll(async () => {
  const started = await startDatabase();
  postgres = started.postgres;
  issuer = await startTestIssuer();
  upstream = await startFakeUpstream();
  upstream.route('GET', '/rest/V1/products', (req) => {
    const items = (req.query.get('skus') ?? '').split(',').map((sku) => ({ sku, name: `Old ${sku}` }));
    return { status: 200, body: { items, total_count: items.length } };
  });
  configDir = await mkdtemp(join(tmpdir(), 'aiops-conformance-e2e-'));
  await cp(CONFIG, configDir, { recursive: true });
  const connections = join(configDir, 'connections.yaml');
  await writeFile(connections, (await readFile(connections, 'utf8')).replaceAll('__UPSTREAM_URL__', upstream.url));
  outDir = await mkdtemp(join(tmpdir(), 'aiops-conformance-out-'));
  api = await startApi(started.databaseUrl, { issuer, configDir, widgetDir: WIDGET_DIR });
  await vaultOf(api).put({ ref: 'shop-token', scheme: 'bearer', secret: { token: 'e2e-only-upstream-token-conformance' }, actor: 'e2e-setup' });
  // One token for the whole run: the default 300 s would expire before the last scenario.
  const token = await issuer.token({ sub: 'conformance-id', groups: ['conformance'], aud: api.resource, azp: 'aiops-mcp', expiresIn: 3600 });
  proxy = await startTokenProxy({ target: api.url, token });
});

afterAll(async () => {
  await proxy.close();
  await api.close();
  await upstream.close();
  await issuer.close();
  await postgres.stop();
  await rm(configDir, { recursive: true });
  await rm(outDir, { recursive: true, force: true });
});

/** Runs the pinned CLI; resolves with its exit code and combined output. */
function runSuite(requirements: string, baseline: string, out: string): Promise<{ code: number | null; output: string }> {
  const args = [join(PKG_DIR, 'dist/index.js'), 'server', '--url', `${proxy.url}/mcp`, '--requirements', requirements, '--expected-failures', baseline, '-o', out, '--timeout', '30000'];
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let output = '';
    child.stdout.on('data', (chunk: Buffer) => (output += chunk.toString()));
    child.stderr.on('data', (chunk: Buffer) => (output += chunk.toString()));
    child.on('error', reject);
    child.on('close', (code) => {
      resolve({ code, output });
    });
  });
}

/** `server-<scenario>-<ISO timestamp>` result directories, mapped to their checks. */
async function resultsByScenario(out: string): Promise<Map<string, Check[]>> {
  const results = new Map<string, Check[]>();
  for (const entry of await readdir(out, { withFileTypes: true })) {
    if (!entry.isDirectory() || !entry.name.startsWith('server-')) continue;
    const scenario = entry.name.slice('server-'.length).replace(/-\d{4}-\d\d-\d\dT.*$/, '');
    const checks = JSON.parse(await readFile(join(out, entry.name, 'checks.json'), 'utf8')) as Check[];
    results.set(scenario, [...(results.get(scenario) ?? []), ...checks]);
  }
  return results;
}

/** The single checks a baseline excuses (`<scenario>:<check-id>` entries); whole-scenario entries are not returned. */
async function excusedChecks(baseline: string): Promise<Set<string>> {
  const doc = parse(await readFile(baseline, 'utf8')) as { server?: unknown };
  const entries = Array.isArray(doc.server) ? doc.server : [];
  return new Set(entries.filter((e): e is string => typeof e === 'string' && e.includes(':')));
}

describe('NFR-16 MCP-1 official MCP conformance suite', () => {
  it('NFR-16 MCP-1 the 2026-07-28 requirement set passes with the reviewed baseline', { timeout: 1_200_000 }, async () => {
    const out = join(outDir, '2026-07-28');
    const { code, output } = await runSuite('2026-07-28', BASELINE_2026, out);
    expect(code, output).toBe(0);

    const results = await resultsByScenario(out);
    // A must-pass scenario passes when none of its checks fails, except a single check the reviewed baseline excuses (ADR 0055).
    const excused = await excusedChecks(BASELINE_2026);
    for (const scenario of MUST_PASS['2026-07-28']) {
      const checks = results.get(scenario);
      expect(checks, `scenario ${scenario} did not run`).toBeDefined();
      expect(checks?.length ?? 0, `scenario ${scenario} reported no checks`).toBeGreaterThan(0);
      const failed = (checks ?? []).filter((c) => c.status === 'FAILURE' && !excused.has(`${scenario}:${c.id}`)).map((c) => `${c.id}: ${c.errorMessage ?? ''}`);
      expect(failed, `scenario ${scenario}`).toEqual([]);
    }

    const all = [...results.values()].flat();
    const count = (status: CheckStatus): number => all.filter((c) => c.status === status).length;
    console.log(
      `conformance 2026-07-28: ${String(results.size)} scenarios, ${String(count('SUCCESS'))} success, ${String(count('FAILURE'))} failure, ${String(count('WARNING'))} warning, ${String(count('SKIPPED'))} skipped, ${String(count('INFO'))} info`,
    );
  });
});
