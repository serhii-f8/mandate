/**
 * `POST /api/v1/changesets/:id/rollback` end to end (EXE-8, SEC-8, SEC-1, POL-6, AUD-1, SEC-11,
 * UI-4): the trusted page is the only place a rollback starts. PostgreSQL repository, the in-memory
 * executor behind a toggle, change-sets seeded as executed with an open window.
 */
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDb, PostgresChangeSetRepository, type Database } from '@aiops/db';
import { InMemoryExecutor, pageLogin, ScriptedWriter, startTestIssuer, type StartedPostgres, type TestIssuer, type TestLoginUser } from '@aiops/testing';
import { seedExecuted, type Seeded } from './approval-seed.js';
import { auditRows, startApi, startDatabase, type RunningApi } from './helpers.js';
import { ToggleExecutor } from './toggle-executor.js';

const CONFIG = fileURLToPath(new URL('./fixtures/approvals-pages-config', import.meta.url));
const HOUR = 3_600_000;

const ALICE: TestLoginUser = { sub: 'alice-id', username: 'alice', groups: ['content', 'leads'] };
/** Alice after losing the `content` group: still the requester, no longer allowed the operation (POL-6). */
const ALICE_DEMOTED: TestLoginUser = { sub: 'alice-id', username: 'alice', groups: ['support'] };
const DAVE: TestLoginUser = { sub: 'dave-id', username: 'dave', groups: ['leads', 'brand'] };
const BOB: TestLoginUser = { sub: 'bob-id', username: 'bob', groups: ['support'] };

let postgres: StartedPostgres;
let databaseUrl: string;
let issuer: TestIssuer;
let api: RunningApi;
let webDir: string;
let seedDb: Database;
let repo: PostgresChangeSetRepository;
let executor: ToggleExecutor;

/** Every refusal seen in this file, checked by the AUD-1 test. */
const refusals: { correlationId: string; reason: string; rollbackReason?: string }[] = [];
/** Every change-set seeded here, for the SEC-3 check of the AUD-1 test. */
const seededAll: Seeded[] = [];
let success: { id: string; correlationId: string } | undefined;

interface Page {
  readonly cookie: string;
  readonly csrfToken: string;
}

interface Answer {
  readonly status: number;
  readonly body: unknown;
  readonly correlationId: string;
}

beforeAll(async () => {
  ({ postgres, databaseUrl } = await startDatabase());
  issuer = await startTestIssuer();
  webDir = await mkdtemp(join(tmpdir(), 'aiops-web-e2e-'));
  await mkdir(join(webDir, 'assets'));
  await writeFile(join(webDir, 'index.html'), '<!doctype html><title>Approvals</title><div id="root"></div>');
  seedDb = createDb(databaseUrl, { onError: () => undefined });
  repo = new PostgresChangeSetRepository(seedDb.db);
  executor = new ToggleExecutor(new InMemoryExecutor({ repository: repo, writer: new ScriptedWriter(), batchSizeOf: () => 100 }));
  api = await startApi(databaseUrl, { issuer, configDir: CONFIG, webDir, executor });
});

afterAll(async () => {
  for (const s of seededAll) await executor.inner.settled(s.id);
  await api.close();
  await seedDb.close();
  await issuer.close();
  await postgres.stop();
  await rm(webDir, { recursive: true });
});

const nowSeconds = (): number => Math.floor(Date.now() / 1000);

async function login(user: TestLoginUser, o: { authTime?: number } = {}): Promise<Page> {
  issuer.setLoginUser(o.authTime === undefined ? user : { ...user, authTime: o.authTime });
  const { cookie, csrfToken } = await pageLogin(api.url, user.username ?? user.sub, 'unused');
  return { cookie, csrfToken };
}

async function rollback(page: Page, id: string, body: unknown, headers: Record<string, string | undefined> = {}): Promise<Answer> {
  const merged: Record<string, string | undefined> = {
    cookie: page.cookie,
    origin: new URL(api.url).origin,
    'x-csrf-token': page.csrfToken,
    'content-type': 'application/json',
    ...headers,
  };
  const response = await fetch(`${api.url}/api/v1/changesets/${id}/rollback`, {
    method: 'POST',
    redirect: 'manual',
    headers: Object.fromEntries(Object.entries(merged).filter((e): e is [string, string] => e[1] !== undefined)),
    body: JSON.stringify(body),
  });
  expect(response.headers.get('cache-control')).toBe('no-store');
  const text = await response.text();
  return { status: response.status, body: text === '' ? undefined : (JSON.parse(text) as unknown), correlationId: response.headers.get('x-correlation-id') ?? '' };
}

/** Asserts a refused rollback and remembers it for the AUD-1 test. */
function refused(answer: Answer, status: number, reason: string, rollbackReason?: string): void {
  const body = rollbackReason === undefined ? { error: reason } : { error: reason, reason: rollbackReason };
  expect({ status: answer.status, body: answer.body }).toEqual({ status, body });
  refusals.push({ correlationId: answer.correlationId, reason, ...(rollbackReason === undefined ? {} : { rollbackReason }) });
}

/** An executed change-set of alice's with `items` written items and a window open for an hour. */
async function seedAlice(items = 3, o: { window?: boolean } = {}): Promise<Seeded> {
  const seeded = await seedExecuted(repo, { requester: ALICE.sub, items, ...(o.window === false ? {} : { rollbackUntil: new Date(Date.now() + HOUR) }) });
  seededAll.push(seeded);
  return seeded;
}

/** The state a refusal must leave untouched. */
async function untouched(id: string): Promise<void> {
  const record = await repo.get(id);
  expect(record?.status).toBe('completed');
  expect(record?.rollbackRequest).toBeUndefined();
}

describe('EXE-8 SEC-8 page rollback', () => {
  it('EXE-8 UI-4 the requester rolls back with a fresh login and gets 200 rolling_back, then rolled_back with restored items', async () => {
    const seeded = await seedAlice(3);
    const answer = await rollback(await login(ALICE), seeded.id, { hash: seeded.hash });
    expect({ status: answer.status, body: answer.body }).toEqual({ status: 200, body: { status: 'rolling_back' } });
    success = { id: seeded.id, correlationId: answer.correlationId };
    await executor.inner.settled(seeded.id);
    const after = await repo.get(seeded.id);
    expect(after?.status).toBe('rolled_back');
    expect(after?.rollbackRequest).toMatchObject({ actor: ALICE.sub, clientId: 'aiops-web', correlationId: answer.correlationId });
    const items = await repo.itemsPage(seeded.id, { limit: 100 });
    expect(items.map((i) => i.rollbackStatus)).toEqual(['restored', 'restored', 'restored']);
  });

  it('SEC-8 without CSRF or with another Origin is 403 csrf and changes nothing', async () => {
    const seeded = await seedAlice();
    const alice = await login(ALICE);
    refused(await rollback(alice, seeded.id, { hash: seeded.hash }, { 'x-csrf-token': undefined }), 403, 'csrf');
    refused(await rollback(alice, seeded.id, { hash: seeded.hash }, { origin: 'http://evil.example' }), 403, 'csrf');
    // CSRF is checked before freshness and the body.
    const stale = await login(ALICE, { authTime: nowSeconds() - 3600 });
    refused(await rollback(stale, seeded.id, {}, { 'x-csrf-token': undefined }), 403, 'csrf');
    await untouched(seeded.id);
  });

  it('SEC-8 a stale login is 403 reauthentication_required and changes nothing', async () => {
    const seeded = await seedAlice();
    const stale = await login(ALICE, { authTime: nowSeconds() - 3600 });
    refused(await rollback(stale, seeded.id, { hash: seeded.hash }), 403, 'reauthentication_required');
    // Freshness is checked before the body.
    refused(await rollback(stale, seeded.id, { hash: 'nope' }), 403, 'reauthentication_required');
    await untouched(seeded.id);
  });

  it('SEC-1 a foreign user and an approver get 404', async () => {
    const seeded = await seedAlice();
    // The ID check comes first: even without CSRF the answer is 404.
    refused(await rollback(await login(BOB), seeded.id, { hash: seeded.hash }, { 'x-csrf-token': undefined }), 404, 'not_found');
    refused(await rollback(await login(DAVE), seeded.id, { hash: seeded.hash }), 404, 'not_found');
    const alice = await login(ALICE);
    refused(await rollback(alice, 'not-a-uuid', { hash: seeded.hash }), 404, 'not_found');
    refused(await rollback(alice, '00000000-0000-4000-8000-000000000000', { hash: seeded.hash }), 404, 'not_found');
    await untouched(seeded.id);
  });

  it('SEC-8 a bad body is 400 invalid_body', async () => {
    const seeded = await seedAlice();
    const alice = await login(ALICE);
    for (const body of [{}, { hash: 'sha256:xyz' }, { hash: seeded.hash, extra: 1 }, { hash: 1 }, []]) {
      refused(await rollback(alice, seeded.id, body), 400, 'invalid_body');
    }
    await untouched(seeded.id);
  });

  it('EXE-8 a stale hash is 409 hash_mismatch; a closed window is 409 not_rollbackable window_closed; a second rollback is 409 already_rolled_back', async () => {
    const alice = await login(ALICE);
    const seeded = await seedAlice();
    refused(await rollback(alice, seeded.id, { hash: `sha256:${'0'.repeat(64)}` }), 409, 'hash_mismatch');
    await untouched(seeded.id);

    const closed = await seedAlice(2, { window: false });
    refused(await rollback(alice, closed.id, { hash: closed.hash }), 409, 'not_rollbackable', 'window_closed');
    await untouched(closed.id);

    const first = await rollback(alice, seeded.id, { hash: seeded.hash });
    expect(first.status).toBe(200);
    refused(await rollback(alice, seeded.id, { hash: seeded.hash }), 409, 'not_rollbackable', 'already_rolled_back');
    await executor.inner.settled(seeded.id);
    refused(await rollback(alice, seeded.id, { hash: seeded.hash }), 409, 'not_rollbackable', 'already_rolled_back');
  });

  it('POL-6 a requester who lost the role is 403 policy_denied', async () => {
    const seeded = await seedAlice();
    refused(await rollback(await login(ALICE_DEMOTED), seeded.id, { hash: seeded.hash }), 403, 'policy_denied');
    await untouched(seeded.id);
  });

  it('EXE-8 executor down is 409 executor_unavailable and changes nothing', async () => {
    const seeded = await seedAlice();
    const alice = await login(ALICE);
    executor.unavailable = true;
    try {
      refused(await rollback(alice, seeded.id, { hash: seeded.hash }), 409, 'executor_unavailable');
    } finally {
      executor.unavailable = false;
    }
    await untouched(seeded.id);
  });

  it('EXE-8 two concurrent requests give one 200 and one 409', async () => {
    const seeded = await seedAlice();
    const alice = await login(ALICE);
    const answers = await Promise.all([rollback(alice, seeded.id, { hash: seeded.hash }), rollback(alice, seeded.id, { hash: seeded.hash })]);
    expect(answers.map((a) => a.status).sort()).toEqual([200, 409]);
    const loser = answers.find((a) => a.status === 409);
    if (loser === undefined) throw new Error('no refused request');
    refused(loser, 409, 'not_rollbackable', 'already_rolled_back');
    await executor.inner.settled(seeded.id);
    // One accepted request: one transition to rolling_back and one ok row for the change-set.
    const rows = await auditRows(databaseUrl, "changeset_id = $1 and (action = 'changeset.rollback' and outcome = 'ok' or action = 'changeset.transition' and details->>'to' = 'rolling_back')", [seeded.id]);
    expect(rows.map((r) => r.action)).toEqual(['changeset.transition', 'changeset.rollback']);
    expect((await repo.get(seeded.id))?.status).toBe('rolled_back');
  });
});

describe('AUD-1 SEC-11 page rollback is audited once', () => {
  it('AUD-1 SEC-11 every refusal above left exactly one denied changeset.rollback row with channel page; the success left the transition and one ok row; no row names a target id or the hash', async () => {
    expect(refusals.length).toBeGreaterThanOrEqual(18);
    for (const { correlationId, reason, rollbackReason } of refusals) {
      const rows = await auditRows(databaseUrl, "action = 'changeset.rollback' and correlation_id = $1", [correlationId]);
      const details = rollbackReason === undefined ? { reason, channel: 'page' } : { reason, channel: 'page', rollbackReason };
      expect({ correlationId, rows: rows.map((r) => ({ outcome: r.outcome, details: r.details })) }).toEqual({
        correlationId,
        rows: [{ outcome: 'denied', details }],
      });
    }

    if (success === undefined) throw new Error('the success case did not run');
    const ok = await auditRows(databaseUrl, "correlation_id = $1 and changeset_id = $2 and action in ('changeset.rollback', 'changeset.transition')", [success.correlationId, success.id]);
    expect(ok.filter((r) => r.action === 'changeset.rollback').map((r) => ({ outcome: r.outcome, actor: r.actor, client: r.client_id, details: r.details }))).toEqual([
      { outcome: 'ok', actor: ALICE.sub, client: 'aiops-web', details: { channel: 'page', count: 3 } },
    ]);
    expect(ok.filter((r) => r.action === 'changeset.transition').map((r) => ({ actor: r.actor, details: r.details }))[0]).toMatchObject({
      actor: ALICE.sub,
      details: { from: 'completed', to: 'rolling_back' },
    });

    const all = await auditRows(databaseUrl, "action like 'changeset.%'");
    for (const row of all) {
      const text = JSON.stringify(row);
      expect(text).not.toMatch(/SKU-|sha256:/);
      for (const s of seededAll) expect(text).not.toContain(s.hash);
      // A change-set ID (page refusals) or the operation ID (change-set events), never a target.
      if (row.subject !== null) expect(row.subject).toMatch(/^([0-9a-f-]{36}|shop\.update_content)$/);
    }
  });
});
