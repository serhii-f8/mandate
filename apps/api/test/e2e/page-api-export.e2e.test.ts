// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Mandate Authors
import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDb, PostgresChangeSetRepository, type Database } from '@mandate/db';
import { InMemoryExecutor, pageLogin, ScriptedWriter, startTestIssuer, type StartedPostgres, type TestIssuer, type TestLoginUser } from '@mandate/testing';
import { seedExecuted, seedPending } from './approval-seed.js';
import { startApi, startDatabase, type RunningApi } from './helpers.js';
import { ToggleExecutor } from './toggle-executor.js';

const PAGE_API = fileURLToPath(new URL('../../../../tooling/acceptance/page-api.mjs', import.meta.url));
const run = promisify(execFile);

const CONFIG = fileURLToPath(new URL('./fixtures/approvals-pages-config', import.meta.url));

const ALICE: TestLoginUser = { sub: 'alice-id', username: 'alice', groups: ['content', 'leads'] };
const BOB: TestLoginUser = { sub: 'bob-id', username: 'bob', groups: ['support'] };

let postgres: StartedPostgres;
let databaseUrl: string;
let issuer: TestIssuer;
let api: RunningApi;
let webDir: string;
let seedDb: Database;
let repo: PostgresChangeSetRepository;
let executor: ToggleExecutor;
let outDir: string;

beforeAll(async () => {
  ({ postgres, databaseUrl } = await startDatabase());
  issuer = await startTestIssuer();
  outDir = await mkdtemp(join(tmpdir(), 'mandate-export-out-'));
  webDir = await mkdtemp(join(tmpdir(), 'mandate-web-e2e-'));
  await mkdir(join(webDir, 'assets'));
  await writeFile(join(webDir, 'index.html'), '<!doctype html><title>Approvals</title><div id="root"></div>');
  seedDb = createDb(databaseUrl, { onError: () => undefined });
  repo = new PostgresChangeSetRepository(seedDb.db);
  executor = new ToggleExecutor(new InMemoryExecutor({ repository: repo, writer: new ScriptedWriter(), batchSizeOf: () => 100 }));
  api = await startApi(databaseUrl, { issuer, configDir: CONFIG, webDir, executor });
});

afterAll(async () => {
  for (const id of executor.started) await executor.inner.settled(id);
  await api.close();
  await seedDb.close();
  await issuer.close();
  await postgres.stop();
  await rm(webDir, { recursive: true });
  await rm(outDir, { recursive: true });
});

interface Page {
  readonly cookie: string;
  readonly csrfToken: string;
}

async function login(user: TestLoginUser, o: { authTime?: number; fresh?: boolean } = {}): Promise<Page> {
  issuer.setLoginUser(o.authTime === undefined ? user : { ...user, authTime: o.authTime });
  const { cookie, csrfToken } = await pageLogin(api.url, user.username ?? user.sub, 'unused', o.fresh === true ? { fresh: true } : {});
  return { cookie, csrfToken };
}


describe('CS-8 page-api.mjs export', () => {
  it('CS-8 page-api.mjs export writes the CSV and XLSX files of a change-set the caller may view', async () => {
    const seeded = await seedPending(repo, { requester: ALICE.sub, groups: ['content', 'leads'], role: 'content_manager', items: 3, excluded: 1 });
    const alice = await login(ALICE);
    const env = { ...process.env, MANDATE_PAGE_COOKIE: alice.cookie };
    const call = async (...args: string[]): Promise<{ status: number; contentType?: string; bytes?: number }> => {
      const { stdout } = await run(process.execPath, [PAGE_API, api.url, ...args], { env });
      return JSON.parse(stdout.trim().split('\n')[0] ?? '') as { status: number; contentType?: string; bytes?: number };
    };

    const csvPath = join(outDir, 'a.csv');
    const csv = await call('export', seeded.id, 'csv', csvPath);
    expect(csv).toMatchObject({ status: 200 });
    expect(String(csv.contentType)).toMatch(/^text\/csv/);
    const csvBytes = await readFile(csvPath);
    expect(csv.bytes).toBe(csvBytes.length);
    expect(csvBytes.subarray(0, 3)).toEqual(Buffer.from([0xef, 0xbb, 0xbf]));
    expect(csvBytes.subarray(3).toString('utf8').startsWith('"target_id"')).toBe(true);

    const xlsxPath = join(outDir, 'a.xlsx');
    expect(await call('export', seeded.id, 'xlsx', xlsxPath)).toMatchObject({ status: 200 });
    expect((await readFile(xlsxPath)).subarray(0, 2).toString('latin1')).toBe('PK');

    const bob = await login(BOB);
    const refused = await run(process.execPath, [PAGE_API, api.url, 'export', seeded.id, 'csv', join(outDir, 'b.csv')], { env: { ...process.env, MANDATE_PAGE_COOKIE: bob.cookie } });
    expect(JSON.parse(refused.stdout.trim())).toMatchObject({ status: 404 });

    await expect(run(process.execPath, [PAGE_API, api.url, 'export', seeded.id, 'pdf', join(outDir, 'x')], { env })).rejects.toMatchObject({ code: 2 });
  });
});

describe('UI-4 SEC-8 page-api.mjs rollback', () => {
  it('UI-4 SEC-8 page-api.mjs rollback posts the hash with the session, CSRF and Origin', async () => {
    const seeded = await seedExecuted(repo, { requester: ALICE.sub, items: 2, rollbackUntil: new Date(Date.now() + 3_600_000) });
    executor.started.push(seeded.id);
    const alice = await login(ALICE);
    const { stdout } = await run(process.execPath, [PAGE_API, api.url, 'rollback', seeded.id, seeded.hash], { env: { ...process.env, MANDATE_PAGE_COOKIE: alice.cookie } });
    expect(JSON.parse(stdout.trim())).toEqual({ status: 200, body: { status: 'rolling_back' } });
  });
});
