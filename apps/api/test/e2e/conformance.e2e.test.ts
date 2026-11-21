// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The AI Operations Layer Authors
/**
 * The official MCP conformance suite against the running api (NFR-16, MCP-1).
 *
 * The api runs on `conformance-config` (one read and one write operation on the fake upstream,
 * the widget bundles present). The suite cannot send a bearer token, so it talks to a test-only
 * proxy that adds one. The pinned CLI runs each frozen requirement set with its reviewed baseline:
 * 2026-07-28 on the stateless endpoint, 2025-11-25 on the SDK's stateless legacy fallback (ADR 0003).
 * The must-pass scenarios are then checked one by one in the result files.
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
const baselineOf = (requirements: Requirements): string => fileURLToPath(new URL(`../conformance/expected-failures.${requirements}.yaml`, import.meta.url));
const PKG_DIR = dirname(createRequire(import.meta.url).resolve('@modelcontextprotocol/conformance/package.json'));

type Requirements = keyof typeof MUST_PASS;
type CheckStatus = 'SUCCESS' | 'FAILURE' | 'WARNING' | 'SKIPPED' | 'INFO';
interface Check {
  readonly id: string;
  readonly status: CheckStatus;
  readonly errorMessage?: string;
}

let postgres: StartedPostgres | undefined;
let issuer: TestIssuer | undefined;
let upstream: FakeUpstream | undefined;
let api: RunningApi | undefined;
let proxy: { url: string; close(): Promise<void> } | undefined;
let configDir: string | undefined;
let outDir: string | undefined;

beforeAll(async () => {
  const started = await startDatabase();
  postgres = started.postgres;
  const testIssuer = await startTestIssuer();
  issuer = testIssuer;
  const fake = await startFakeUpstream();
  upstream = fake;
  fake.route('GET', '/rest/V1/products', (req) => {
    const items = (req.query.get('skus') ?? '').split(',').map((sku) => ({ sku, name: `Old ${sku}` }));
    return { status: 200, body: { items, total_count: items.length } };
  });
  const dir = await mkdtemp(join(tmpdir(), 'aiops-conformance-e2e-'));
  configDir = dir;
  await cp(CONFIG, dir, { recursive: true });
  const connections = join(dir, 'connections.yaml');
  await writeFile(connections, (await readFile(connections, 'utf8')).replaceAll('__UPSTREAM_URL__', fake.url));
  outDir = await mkdtemp(join(tmpdir(), 'aiops-conformance-out-'));
  const running = await startApi(started.databaseUrl, { issuer: testIssuer, configDir: dir, widgetDir: WIDGET_DIR });
  api = running;
  await vaultOf(running).put({ ref: 'shop-token', scheme: 'bearer', secret: { token: 'e2e-only-upstream-token-conformance' }, actor: 'e2e-setup' });
  // One token for the whole run: the default 300 s would expire before the last scenario.
  const token = await testIssuer.token({ sub: 'conformance-id', groups: ['conformance'], aud: running.resource, azp: 'aiops-mcp', expiresIn: 3600 });
  proxy = await startTokenProxy({ target: running.url, token });
});

// Guarded: when beforeAll fails partway, the handles not yet started are undefined.
afterAll(async () => {
  await proxy?.close();
  await api?.close();
  await upstream?.close();
  await issuer?.close();
  await postgres?.stop();
  if (configDir !== undefined) await rm(configDir, { recursive: true, force: true });
  if (outDir !== undefined) await rm(outDir, { recursive: true, force: true });
});

/** Runs the pinned CLI; resolves with its exit code and combined output. */
function runSuite(proxyUrl: string, requirements: Requirements, baseline: string, out: string): Promise<{ code: number | null; output: string }> {
  const args = [join(PKG_DIR, 'dist/index.js'), 'server', '--url', `${proxyUrl}/mcp`, '--requirements', requirements, '--expected-failures', baseline, '-o', out, '--timeout', '30000'];
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

/**
 * The single checks a baseline excuses (`<scenario>:<check-id>` entries); whole-scenario entries are
 * not returned. A malformed file yields no excusals here; its shape is pinned by
 * test/conformance/baseline.unit.test.ts.
 */
async function excusedChecks(baseline: string): Promise<Set<string>> {
  const doc = parse(await readFile(baseline, 'utf8')) as { server?: unknown };
  const entries = Array.isArray(doc.server) ? doc.server : [];
  return new Set(entries.filter((e): e is string => typeof e === 'string' && e.includes(':')));
}

/** The `not_scored` server scenarios of a requirement set: run and reported, never judged by the CLI. */
async function notScored(requirements: Requirements): Promise<Set<string>> {
  const doc = parse(await readFile(join(PKG_DIR, 'requirements', `${requirements}.yaml`), 'utf8')) as { not_scored?: { scenario: string; leg: string }[] };
  return new Set((doc.not_scored ?? []).filter((e) => e.leg === 'server').map((e) => e.scenario));
}

/** Runs one requirement set with its baseline, checks the exit code and the must-pass scenarios, and logs a summary. */
async function conformance(requirements: Requirements): Promise<void> {
  if (proxy === undefined || outDir === undefined) throw new Error('beforeAll did not start the proxy');
  const baseline = baselineOf(requirements);
  const out = join(outDir, requirements);
  const { code, output } = await runSuite(proxy.url, requirements, baseline, out);
  expect(code, output).toBe(0);

  const results = await resultsByScenario(out);
  // A must-pass scenario passes when none of its checks fails, except a single check the reviewed baseline excuses (ADR 0055).
  const excused = await excusedChecks(baseline);
  for (const scenario of MUST_PASS[requirements]) {
    const checks = results.get(scenario);
    expect(checks, `scenario ${scenario} did not run`).toBeDefined();
    expect(checks?.length ?? 0, `scenario ${scenario} reported no checks`).toBeGreaterThan(0);
    const failed = (checks ?? []).filter((c) => c.status === 'FAILURE' && !excused.has(`${scenario}:${c.id}`)).map((c) => `${c.id}: ${c.errorMessage ?? ''}`);
    expect(failed, `scenario ${scenario}`).toEqual([]);
  }

  // Scored and not_scored scenarios are counted apart: the CLI judges only the scored ones (ADR 0055).
  const unscored = await notScored(requirements);
  const summary = (scored: boolean): string => {
    const checks = [...results].filter(([scenario]) => unscored.has(scenario) !== scored).flatMap(([, c]) => c);
    const count = (status: CheckStatus): string => String(checks.filter((c) => c.status === status).length);
    return `${count('SUCCESS')} success, ${count('FAILURE')} failure, ${count('WARNING')} warning, ${count('SKIPPED')} skipped, ${count('INFO')} info`;
  };
  const failingUnscored = [...results].filter(([scenario, checks]) => unscored.has(scenario) && checks.some((c) => c.status === 'FAILURE')).map(([scenario]) => scenario);
  console.log(
    `conformance ${requirements}: ${String(results.size)} scenarios; scored: ${summary(true)}; not_scored: ${summary(false)}; not_scored failing: ${failingUnscored.join(', ') || 'none'}`,
  );
}

describe('NFR-16 MCP-1 official MCP conformance suite', () => {
  it('NFR-16 MCP-1 the 2026-07-28 requirement set passes with the reviewed baseline', { timeout: 1_200_000 }, async () => {
    await conformance('2026-07-28');
  });

  it('NFR-16 MCP-1 the 2025-11-25 requirement set passes on the legacy path with the reviewed baseline', { timeout: 1_200_000 }, async () => {
    await conformance('2025-11-25');
  });
});
