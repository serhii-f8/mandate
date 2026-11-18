import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { changesetTransitionEvent } from '@aiops/core';
import { createDb, PostgresChangeSetRepository, type Database } from '@aiops/db';
import { InMemoryExecutor, pageLogin, ScriptedWriter, startTestIssuer, type StartedPostgres, type TestIssuer, type TestLoginUser } from '@aiops/testing';
import { seedPending, seedPrepared, type Seeded } from './approval-seed.js';
import { auditRows, startApi, startDatabase, type RunningApi } from './helpers.js';
import { RecordingStarter } from './recording-starter.js';
import { ToggleExecutor } from './toggle-executor.js';

const CONFIG = fileURLToPath(new URL('./fixtures/approvals-pages-config', import.meta.url));

const ALICE: TestLoginUser = { sub: 'alice-id', username: 'alice', groups: ['content', 'leads'] };
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
let starter: RecordingStarter;

/** Every page refusal seen in this file, checked by the AUD-1 test. */
const refusals: { action: 'changeset.submit' | 'changeset.exclude'; correlationId: string; reason: string }[] = [];

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
  starter = new RecordingStarter();
  api = await startApi(databaseUrl, { issuer, configDir: CONFIG, webDir, executor, starter });
});

afterAll(async () => {
  for (const id of executor.started) await executor.inner.settled(id);
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

async function post(page: Page, path: string, body: unknown, headers: Record<string, string | undefined> = {}): Promise<Answer> {
  const merged: Record<string, string | undefined> = {
    cookie: page.cookie,
    origin: new URL(api.url).origin,
    'x-csrf-token': page.csrfToken,
    'content-type': 'application/json',
    ...headers,
  };
  const response = await fetch(`${api.url}${path}`, {
    method: 'POST',
    redirect: 'manual',
    headers: Object.fromEntries(Object.entries(merged).filter((e): e is [string, string] => e[1] !== undefined)),
    body: JSON.stringify(body),
  });
  expect(response.headers.get('cache-control')).toBe('no-store');
  const text = await response.text();
  return { status: response.status, body: text === '' ? undefined : (JSON.parse(text) as unknown), correlationId: response.headers.get('x-correlation-id') ?? '' };
}

const submit = (page: Page, id: string, body: unknown, headers?: Record<string, string | undefined>): Promise<Answer> =>
  post(page, `/api/v1/changesets/${id}/submit`, body, headers);

const exclude = (page: Page, id: string, body: unknown, headers?: Record<string, string | undefined>): Promise<Answer> =>
  post(page, `/api/v1/changesets/${id}/exclusions`, body, headers);

/** Asserts a refused page action and remembers it for the AUD-1 test. */
function refused(action: 'changeset.submit' | 'changeset.exclude', answer: Answer, status: number, reason: string, extra: Record<string, unknown> = {}): void {
  expect({ status: answer.status, body: answer.body }).toEqual({ status, body: { error: reason, ...extra } });
  refusals.push({ action, correlationId: answer.correlationId, reason });
}

const submitRefused = (answer: Answer, status: number, reason: string, extra?: Record<string, unknown>): void => {
  refused('changeset.submit', answer, status, reason, extra);
};
const excludeRefused = (answer: Answer, status: number, reason: string, extra?: Record<string, unknown>): void => {
  refused('changeset.exclude', answer, status, reason, extra);
};

async function statusOf(id: string): Promise<string | undefined> {
  return (await repo.get(id))?.status;
}

/** A prepared change-set of alice's: `items` included (SKU-0001…) plus SKU-…(items+1) excluded as `not_found`. */
const seedAlice = (items: number): Promise<Seeded> => seedPrepared(repo, { requester: ALICE.sub, items, excluded: 1 });

const ids = (n: number): string[] => Array.from({ length: n }, (_, i) => `t-${String(i)}`);

describe('UI-3 SEC-8 page submit', () => {
  it('UI-3 the requester submits 2 changes and execution starts', async () => {
    const seeded = await seedAlice(2);
    const answer = await submit(await login(ALICE), seeded.id, { hash: seeded.hash });
    expect({ status: answer.status, body: answer.body }).toEqual({ status: 200, body: { status: 'executing' } });
    expect(executor.started).toContain(seeded.id);
    const rows = await auditRows(databaseUrl, "action = 'changeset.submit' and correlation_id = $1", [answer.correlationId]);
    expect(rows.map((r) => ({ outcome: r.outcome, actor: r.actor, client: r.client_id, subject: r.subject, details: r.details }))).toEqual([
      { outcome: 'ok', actor: ALICE.sub, client: 'aiops-web', subject: seeded.id, details: { channel: 'page', status: 'executing' } },
    ]);
  });

  it('UI-3 APR-1 3 changes go to approval with the page link', async () => {
    const seeded = await seedAlice(3);
    const answer = await submit(await login(ALICE), seeded.id, { hash: seeded.hash });
    expect({ status: answer.status, body: answer.body }).toEqual({
      status: 200,
      body: { status: 'pending_approval', approval: { step: 1, steps: ['content_lead', 'brand_owner'], url: `${api.url}/app/changesets/${seeded.id}` } },
    });
    expect(await statusOf(seeded.id)).toBe('pending_approval');
    const rows = await auditRows(databaseUrl, "action = 'changeset.submit' and correlation_id = $1", [answer.correlationId]);
    expect(rows.map((r) => ({ outcome: r.outcome, details: r.details }))).toEqual([{ outcome: 'ok', details: { channel: 'page', status: 'pending_approval' } }]);
  });

  it('SEC-8 a submit without CSRF or with another Origin is 403 csrf and changes nothing', async () => {
    const seeded = await seedAlice(2);
    const alice = await login(ALICE);
    submitRefused(await submit(alice, seeded.id, { hash: seeded.hash }, { 'x-csrf-token': undefined }), 403, 'csrf');
    submitRefused(await submit(alice, seeded.id, { hash: seeded.hash }, { origin: 'http://evil.example' }), 403, 'csrf');
    // CSRF comes before the body.
    submitRefused(await submit(alice, seeded.id, {}, { 'x-csrf-token': undefined }), 403, 'csrf');
    expect(await statusOf(seeded.id)).toBe('prepared');
    expect(executor.started).not.toContain(seeded.id);
  });

  it('SEC-1 UI-7 only the requester may submit: an approver and a foreign user get 404', async () => {
    const prepared = await seedAlice(2);
    const pending = await seedPending(repo, { requester: ALICE.sub, groups: ['content', 'leads'], role: 'content_manager', items: 3 });
    const dave = await login(DAVE);
    const bob = await login(BOB);
    // The 404 comes before CSRF, so a stranger learns nothing.
    submitRefused(await submit(dave, pending.id, { hash: pending.hash }, { 'x-csrf-token': undefined }), 404, 'not_found');
    submitRefused(await submit(dave, prepared.id, { hash: prepared.hash }), 404, 'not_found');
    submitRefused(await submit(bob, prepared.id, { hash: prepared.hash }), 404, 'not_found');
    submitRefused(await submit(bob, randomUUID(), { hash: prepared.hash }), 404, 'not_found');
    submitRefused(await submit(bob, 'x', { hash: prepared.hash }), 404, 'not_found');
    expect(await statusOf(prepared.id)).toBe('prepared');
    expect(await statusOf(pending.id)).toBe('pending_approval');
  });

  it('SEC-9 a stale hash is 409 hash_mismatch; a pending change-set is 409 not_prepared', async () => {
    const alice = await login(ALICE);
    const seeded = await seedAlice(2);
    submitRefused(await submit(alice, seeded.id, { hash: `sha256:${'0'.repeat(64)}` }), 409, 'hash_mismatch');
    submitRefused(await submit(alice, seeded.id, { hash: 'sha256:short' }), 400, 'invalid_body');
    submitRefused(await submit(alice, seeded.id, { hash: seeded.hash, extra: 1 }), 400, 'invalid_body');
    expect(await statusOf(seeded.id)).toBe('prepared');
    const pending = await seedPending(repo, { requester: ALICE.sub, groups: ['content', 'leads'], role: 'content_manager', items: 3 });
    submitRefused(await submit(alice, pending.id, { hash: pending.hash }), 409, 'not_prepared');
    // A change-set past its expiry reads as expired (CS-6).
    const old = await seedPrepared(repo, { requester: ALICE.sub, items: 2, expiresAt: new Date(Date.now() - 1000) });
    submitRefused(await submit(alice, old.id, { hash: old.hash }), 409, 'expired');
    submitRefused(await submit(alice, old.id, { hash: old.hash }), 409, 'expired');
  });

  it('SEC-8 F3 an approved change-set is not started from the submit route', async () => {
    const pending = await seedPending(repo, { requester: ALICE.sub, groups: ['content', 'leads'], role: 'catalog_editor', items: 1 });
    // Approve it straight in the store, as a finished approval round would leave it.
    const changeset = { id: pending.id, operation: 'shop.update_content' };
    const event = changesetTransitionEvent({ id: randomUUID(), actor: DAVE.sub, changeset, from: 'pending_approval', to: 'approved', correlationId: randomUUID() });
    expect(await repo.transition(pending.id, ['pending_approval'], 'approved', event)).toBeDefined();
    submitRefused(await submit(await login(ALICE), pending.id, { hash: pending.hash }), 409, 'not_prepared');
    expect(await statusOf(pending.id)).toBe('approved');
    expect(executor.started).not.toContain(pending.id);
  });

  it('POL-6 the page re-evaluates policy with the session groups: a requester who lost the role is 403 policy_denied', async () => {
    const seeded = await seedAlice(2);
    const answer = await submit(await login({ ...ALICE, groups: ['leads'] }), seeded.id, { hash: seeded.hash });
    submitRefused(answer, 403, 'policy_denied');
    expect(await statusOf(seeded.id)).toBe('prepared');
    const decisions = await auditRows(databaseUrl, "action = 'policy.decision' and correlation_id = $1", [answer.correlationId]);
    expect(decisions.map((r) => r.decision)).toEqual(['deny']);
  });

  it('POL-4 a start refusal answers its code: executor down is 409 executor_unavailable', async () => {
    const seeded = await seedAlice(2);
    executor.unavailable = true;
    try {
      submitRefused(await submit(await login(ALICE), seeded.id, { hash: seeded.hash }), 409, 'executor_unavailable');
    } finally {
      executor.unavailable = false;
    }
    expect(await statusOf(seeded.id)).toBe('prepared');
    executor.refuseStarts = true;
    try {
      submitRefused(await submit(await login(ALICE), seeded.id, { hash: seeded.hash }), 409, 'not_executable');
    } finally {
      executor.refuseStarts = false;
    }
  });

  it('SEC-8 submit needs no fresh login', async () => {
    const seeded = await seedAlice(2);
    const stale = await login(ALICE, { authTime: nowSeconds() - 3600 });
    const answer = await submit(stale, seeded.id, { hash: seeded.hash });
    expect({ status: answer.status, body: answer.body }).toEqual({ status: 200, body: { status: 'executing' } });
  });
});

describe('CS-5 page exclusions', () => {
  it('CS-5 the requester excludes an item and gets 201 with a new id and hash', async () => {
    const seeded = await seedAlice(3);
    const answer = await exclude(await login(ALICE), seeded.id, { hash: seeded.hash, exclude: ['SKU-0001'] });
    expect(answer.status).toBe(201);
    const body = answer.body as { id: string; hash: string; stats: { included: number; excluded: Record<string, number> }; derivedFrom: string };
    expect(body.derivedFrom).toBe(seeded.id);
    expect(body.id).not.toBe(seeded.id);
    expect(body.hash).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(body.hash).not.toBe(seeded.hash);
    expect(body.stats.included).toBe(2);
    expect(body.stats.excluded).toEqual({ not_found: 1, requester: 1 });
    expect(Object.keys(body).sort()).toEqual(['derivedFrom', 'hash', 'id', 'stats']);
    const source = await repo.get(seeded.id);
    expect({ status: source?.status, hash: source?.hash, included: source?.stats.included }).toEqual({ status: 'prepared', hash: seeded.hash, included: 3 });
    expect(starter.started).toContain(body.id);
    const rows = await auditRows(databaseUrl, "action = 'changeset.exclude' and correlation_id = $1", [answer.correlationId]);
    expect(rows.map((r) => ({ outcome: r.outcome, actor: r.actor, client: r.client_id, subject: r.subject, details: r.details }))).toEqual([
      {
        outcome: 'ok',
        actor: ALICE.sub,
        client: 'aiops-web',
        subject: seeded.id,
        details: { channel: 'page', changesetId: body.id, derivedFrom: seeded.id, excludeCount: 1, includeCount: 0 },
      },
    ]);
    // The derived change-set is submitted like any other.
    const submitted = await submit(await login(ALICE), body.id, { hash: body.hash });
    expect({ status: submitted.status, body: submitted.body }).toEqual({ status: 200, body: { status: 'executing' } });
  });

  it('CS-5 refusals: 409 unknown_items with count, nothing_left, empty_request, hash_mismatch; 400 invalid_body for bad shapes and over 1000 ids', async () => {
    const seeded = await seedAlice(3);
    const alice = await login(ALICE);
    const { hash } = seeded;
    excludeRefused(await exclude(alice, seeded.id, { hash, exclude: ['SKU-0001', 'SKU-0404', 'SKU-0004'] }), 409, 'unknown_items', { count: 2 });
    excludeRefused(await exclude(alice, seeded.id, { hash, exclude: ['SKU-0001', 'SKU-0002', 'SKU-0003'] }), 409, 'nothing_left');
    excludeRefused(await exclude(alice, seeded.id, { hash }), 409, 'empty_request');
    excludeRefused(await exclude(alice, seeded.id, { hash, exclude: [], include: [] }), 409, 'empty_request');
    excludeRefused(await exclude(alice, seeded.id, { hash: `sha256:${'0'.repeat(64)}`, exclude: ['SKU-0001'] }), 409, 'hash_mismatch');
    for (const body of [
      {},
      { exclude: ['SKU-0001'] },
      { hash, exclude: 'SKU-0001' },
      { hash, exclude: [1] },
      { hash, exclude: ['SKU-0001'], extra: true },
      { hash, exclude: ids(1001) },
      // Each list within its bound, together over 1000: refused by the core (invalid_request).
      { hash, exclude: ids(600), include: ids(600).map((t) => `${t}-i`) },
      { hash, exclude: ['SKU\u00010001'] },
      { hash, exclude: [''] },
    ]) {
      excludeRefused(await exclude(alice, seeded.id, body), 400, 'invalid_body');
    }
    const pending = await seedPending(repo, { requester: ALICE.sub, groups: ['content', 'leads'], role: 'content_manager', items: 3 });
    excludeRefused(await exclude(alice, pending.id, { hash: pending.hash, exclude: ['SKU-0001'] }), 409, 'not_prepared');
    const old = await seedPrepared(repo, { requester: ALICE.sub, items: 2, expiresAt: new Date(Date.now() - 1000) });
    excludeRefused(await exclude(alice, old.id, { hash: old.hash, exclude: ['SKU-0001'] }), 409, 'expired');
    excludeRefused(await exclude(alice, old.id, { hash: old.hash, exclude: ['SKU-0001'] }), 409, 'expired');
    const source = await repo.get(seeded.id);
    expect({ status: source?.status, hash: source?.hash }).toEqual({ status: 'prepared', hash: seeded.hash });
  });

  it('SEC-1 a foreign user gets 404, an approver too', async () => {
    const prepared = await seedAlice(3);
    const pending = await seedPending(repo, { requester: ALICE.sub, groups: ['content', 'leads'], role: 'content_manager', items: 3 });
    const bob = await login(BOB);
    const dave = await login(DAVE);
    excludeRefused(await exclude(bob, prepared.id, { hash: prepared.hash, exclude: ['SKU-0001'] }), 404, 'not_found');
    excludeRefused(await exclude(dave, pending.id, { hash: pending.hash, exclude: ['SKU-0001'] }, { 'x-csrf-token': undefined }), 404, 'not_found');
    excludeRefused(await exclude(bob, randomUUID(), { hash: prepared.hash, exclude: ['SKU-0001'] }), 404, 'not_found');
    excludeRefused(await exclude(bob, 'not-a-uuid', {}), 404, 'not_found');
  });

  it('SEC-8 an exclusion without CSRF is 403 csrf', async () => {
    const seeded = await seedAlice(3);
    const alice = await login(ALICE);
    excludeRefused(await exclude(alice, seeded.id, { hash: seeded.hash, exclude: ['SKU-0001'] }, { 'x-csrf-token': undefined }), 403, 'csrf');
    excludeRefused(await exclude(alice, seeded.id, { hash: seeded.hash, exclude: ['SKU-0001'] }, { origin: 'http://evil.example' }), 403, 'csrf');
    const derived = await seedDb.pool.query('select id from change_set where derived_from = $1', [seeded.id]);
    expect(derived.rows).toEqual([]);
  });
});

describe('AUD-1 SEC-11 page actions are audited once', () => {
  it('AUD-1 SEC-11 every refusal above left one denied row with its reason and channel page, and no row names a target id', async () => {
    expect(refusals.length).toBeGreaterThan(20);
    for (const { action, correlationId, reason } of refusals) {
      const rows = await auditRows(databaseUrl, 'action = $1 and correlation_id = $2', [action, correlationId]);
      expect({ correlationId, rows: rows.map((r) => ({ outcome: r.outcome, details: r.details })) }).toEqual({
        correlationId,
        rows: [{ outcome: 'denied', details: { reason, channel: 'page' } }],
      });
    }
    const all = await auditRows(databaseUrl, "action in ('changeset.submit', 'changeset.exclude')");
    for (const row of all) {
      const text = JSON.stringify(row);
      expect(text).not.toMatch(/SKU-|t-\d|sha256:/);
      if (row.subject !== null) expect(row.subject).toMatch(/^[0-9a-f-]{36}$/);
    }
  });
});
