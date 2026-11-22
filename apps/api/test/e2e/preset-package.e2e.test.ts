// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Mandate Authors
/**
 * A code preset installed the way an operator installs one (CONN-8, OPS-5): `npm pack` of the
 * code fixture, extracted into a preset directory, served behind MCP tools by a revision-backed
 * configuration holder as `main.ts` wires it.
 */
import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { cp, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Writable } from 'node:stream';
import { promisify } from 'node:util';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { CONNECTOR_SDK_VERSION } from '@mandate/connector-sdk';
import { READ_RESULT_TEXT } from '@mandate/core';
import { ConfigurationHolder, type ConfigurationLogger } from '@mandate/config';
import { createDb, DrizzleAuditLog, PostgresConfigRevisionStore, type Database } from '@mandate/db';
import {
  CODE_FIXTURE_PRESET_DIR,
  installFakeItems,
  startFakeUpstream,
  startTestIssuer,
  type FakeUpstream,
  type StartedPostgres,
  type TestIssuer,
} from '@mandate/testing';
import { configurationLoadOptions } from '@mandate/upstream';
import { runApiCli } from '../../src/cli.js';
import { createLogger } from '../../src/logger.js';
import { auditRows, connectClient, startApi, startDatabase, testAdapters, tokenFor, vaultOf, type RunningApi } from './helpers.js';

const run = promisify(execFile);
const PACKAGE = '@mandate/code-fixture-preset';
/** Obviously fake; the fake upstream accepts any bearer token. */
const UPSTREAM_TOKEN = 'e2e-only-items-token-0123456789';
/** Part of the text the fixture's `boom` throws (OPS-5). */
const SENTINEL = 'token-sentinel';
const silent: ConfigurationLogger = { debug: () => undefined, info: () => undefined, warn: () => undefined, error: () => undefined };

let postgres: StartedPostgres;
let databaseUrl: string;
let issuer: TestIssuer;
let upstream: FakeUpstream;
let configDb: Database;
let api: RunningApi;
let work: string;
let configDir: string;
let incompatibleDir: string;
let viewer: string;
const logLines: string[] = [];

interface ToolResult {
  isError?: boolean;
  content: { type: string; text: string }[];
  structuredContent?: Record<string, unknown>;
}

/**
 * Copies the fixture, applies `edit` to its package.json, packs it with `npm pack` and extracts
 * the tarball into `<presetDir>/code-fixture`, as an operator installs a preset package.
 */
async function installTarball(presetDir: string, edit: (pkg: Record<string, unknown>) => void): Promise<void> {
  const source = await mkdtemp(join(work, 'source-'));
  await cp(CODE_FIXTURE_PRESET_DIR, source, { recursive: true });
  const manifest = join(source, 'package.json');
  const pkg = JSON.parse(await readFile(manifest, 'utf8')) as Record<string, unknown>;
  edit(pkg);
  await writeFile(manifest, JSON.stringify(pkg, null, 2));
  const packed = await mkdtemp(join(work, 'packed-'));
  await run('npm', ['pack', '--pack-destination', packed], { cwd: source });
  const [tarball] = (await readdir(packed)).filter((f) => f.endsWith('.tgz'));
  if (tarball === undefined) throw new Error('npm pack wrote no tarball');
  const target = join(presetDir, 'code-fixture');
  await mkdir(target, { recursive: true });
  await run('tar', ['-xzf', join(packed, tarball), '--strip-components=1', '-C', target]);
}

const CONFIG = (baseUrl: string): string => `version: 1
presets:
  - { id: fixture, package: "${PACKAGE}", version: "^1.0.0" }
connections:
  - id: items
    adapter: openapi
    base_url: ${baseUrl}
    credential_ref: items-token
    preset: fixture
    allow_private_network: true
    timeout_ms: 2000
    retry: { max_attempts: 1 }
roles:
  - id: viewer
    grants:
      - { operation: fixture.get_many }
      - { operation: fixture.search }
      - { operation: fixture.boom }
role_mapping:
  - { group: viewers, roles: [viewer] }
`;

beforeAll(async () => {
  ({ postgres, databaseUrl } = await startDatabase());
  issuer = await startTestIssuer();
  upstream = await startFakeUpstream();
  installFakeItems(upstream, [
    { id: 'a1', title: 'Anvil', state: 'open', tags: ['heavy'] },
    { id: 'b2', title: 'Rocket', state: 'closed', tags: [] },
  ]);
  work = await mkdtemp(join(tmpdir(), 'mandate-preset-package-e2e-'));
  // The version the fixture has (1.1.0), and a newer one in a second directory: the newer wins.
  const first = join(work, 'presets-a');
  const second = join(work, 'presets-b');
  await installTarball(first, () => undefined);
  await installTarball(second, (pkg) => {
    pkg.version = '1.2.0';
  });
  // A package that requires a connector SDK this platform does not provide (NFR-18).
  incompatibleDir = join(work, 'presets-incompatible');
  await installTarball(incompatibleDir, (pkg) => {
    pkg.mandate = { ...(pkg.mandate as Record<string, unknown>), sdk: '^9.0.0' };
  });
  configDir = join(work, 'config');
  await mkdir(configDir);
  await writeFile(join(configDir, 'mandate.yaml'), CONFIG(upstream.url));

  const stream = new Writable({
    write(chunk: Buffer, _encoding, done) {
      logLines.push(chunk.toString('utf8'));
      done();
    },
  });
  const logger = createLogger('debug', stream);
  const presetDirs = [first, second];
  const adapter = testAdapters(logger);
  // As `main.ts` wires it: a revision-backed holder whose loads are audited as config.load (AUD-1).
  configDb = createDb(databaseUrl, { onError: () => undefined });
  const configuration = await ConfigurationHolder.fromRevisions({
    store: new PostgresConfigRevisionStore(configDb.db, { databaseUrl }),
    fallbackDir: configDir,
    load: configurationLoadOptions(adapter, { presetDirs }),
    audit: new DrizzleAuditLog(configDb.db),
    service: 'api',
    newId: randomUUID,
    logger: silent,
  });
  api = await startApi(databaseUrl, { issuer, configDir, presetDirs, adapter, configuration, logger });
  await vaultOf(api).put({ ref: 'items-token', scheme: 'bearer', secret: { token: UPSTREAM_TOKEN }, actor: 'e2e-setup' });
  viewer = await tokenFor(issuer, api, 'viewer-id', ['viewers']);
});

afterAll(async () => {
  await api.close();
  await configDb.close();
  await upstream.close();
  await issuer.close();
  await postgres.stop();
  await rm(work, { recursive: true, force: true });
});

async function call(name: string, args: Record<string, unknown>): Promise<ToolResult> {
  const client = await connectClient({ era: 'modern', baseUrls: [api.url], token: viewer });
  try {
    return (await client.callTool({ name, arguments: args })) as unknown as ToolResult;
  } finally {
    await client.close();
  }
}

async function allAuditText(): Promise<string> {
  const client = new pg.Client({ connectionString: databaseUrl });
  await client.connect();
  try {
    return (await client.query<{ row: string }>('select t::text as row from audit_event t')).rows.map((r) => r.row).join('\n');
  } finally {
    await client.end();
  }
}

describe('CONN-8 OPS-5 a tarball-installed code preset behind MCP tools', () => {
  it('CONN-8 a preset installed from an npm pack tarball loads with the highest satisfying version', async () => {
    const rows = await auditRows(databaseUrl, "action = 'config.load' and outcome = 'ok'");
    expect(rows).toHaveLength(1);
    expect(rows[0]?.details.presets).toEqual([{ id: 'fixture', package: PACKAGE, version: '1.2.0' }]);
  });

  it('OPS-5 MCP-2 a code-backed read is offered and answers through tools/call with projected fields', async () => {
    const client = await connectClient({ era: 'modern', baseUrls: [api.url], token: viewer });
    try {
      const names = (await client.listTools()).tools.map((t) => t.name);
      expect(names).toEqual(expect.arrayContaining(['fixture.get_many', 'fixture.search', 'fixture.boom']));
    } finally {
      await client.close();
    }
    const result = await call('fixture.get_many', { ids: ['a1', 'missing', 'b2'], fields: ['id', 'title'] });
    expect(result.isError).toBeUndefined();
    expect(result.structuredContent).toEqual({
      operation: 'fixture.get_many',
      items: [
        { id: 'a1', title: 'Anvil' },
        { id: 'b2', title: 'Rocket' },
      ],
      returned: 2,
      truncated: false,
    });
  });

  it('OPS-5 SEC-3 SEC-5 a throwing code read answers upstream_error; the thrown text never reaches the client or the audit', async () => {
    const result = await call('fixture.boom', {});
    expect(result.isError).toBe(true);
    // The fixed wording of upstream_error, the code a throwing code module answers (OPS-5).
    expect(result.content).toEqual([{ type: 'text', text: READ_RESULT_TEXT.errors.upstream_error('fixture.boom') }]);
    expect(JSON.stringify(result)).not.toContain(SENTINEL);
    expect(await allAuditText()).not.toContain(SENTINEL);
    // The thrown text reaches only the operator log, scrubbed of the credential and cut (SEC-3);
    // `operation` is the code operation's name in the preset module, beside the connection.
    const failures = logLines.map((l) => JSON.parse(l) as Record<string, unknown>).filter((l) => l.msg === 'preset code failed');
    expect(failures).toHaveLength(1);
    expect(failures[0]).toMatchObject({ connection: 'items', operation: 'boom', kind: 'read', message: `fixture failure ${SENTINEL}` });
    expect(String(failures[0]?.message).length).toBeLessThanOrEqual(500);
    expect(logLines.join('\n')).not.toContain(UPSTREAM_TOKEN);
  });

  it('CONN-8 NFR-18 a preset requiring connector SDK ^9.0.0 is refused at load with preset_sdk_incompatible', async () => {
    const lines: string[] = [];
    const code = await runApiCli(['validate', configDir, '--preset-dir', incompatibleDir], (line) => lines.push(line), { env: {}, defaultPresetDir: null });
    expect(code).toBe(1);
    expect(lines.join('\n')).toContain(`preset_sdk_incompatible: the preset requires connector SDK ^9.0.0; this platform provides ${CONNECTOR_SDK_VERSION}`);
  });
});
