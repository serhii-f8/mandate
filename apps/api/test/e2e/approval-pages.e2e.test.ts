// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The AI Operations Layer Authors
import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDb, PostgresChangeSetRepository, type Database } from '@aiops/db';
import { pageLogin, recordApproval, startTestIssuer, type StartedPostgres, type TestIssuer, type TestLoginUser } from '@aiops/testing';
import { seedExecuted, seedPending, seedPrepared } from './approval-seed.js';
import { startApi, startDatabase, type RunningApi } from './helpers.js';

const CONFIG = fileURLToPath(new URL('./fixtures/approvals-pages-config', import.meta.url));

const ALICE: TestLoginUser = { sub: 'alice-id', username: 'alice', groups: ['content', 'leads'] };
const DAVE: TestLoginUser = { sub: 'dave-id', username: 'dave', groups: ['leads', 'brand'] };
const ERIN: TestLoginUser = { sub: 'erin-id', username: 'erin', groups: ['brand'] };
const BOB: TestLoginUser = { sub: 'bob-id', username: 'bob', groups: ['support'] };

let postgres: StartedPostgres;
let databaseUrl: string;
let issuer: TestIssuer;
let a: RunningApi;
let b: RunningApi;
let webDir: string;
let seedDb: Database;
let repo: PostgresChangeSetRepository;

interface Page {
  readonly base: string;
  readonly cookie: string;
  readonly csrfToken: string;
}

interface Answer {
  readonly status: number;
  readonly body: unknown;
  readonly headers: Headers;
}

beforeAll(async () => {
  ({ postgres, databaseUrl } = await startDatabase());
  issuer = await startTestIssuer();
  // A stand-in bundle: the e2e does not depend on the web build.
  webDir = await mkdtemp(join(tmpdir(), 'aiops-web-e2e-'));
  await mkdir(join(webDir, 'assets'));
  await writeFile(join(webDir, 'index.html'), '<!doctype html><title>Approvals</title><div id="root"></div>');
  a = await startApi(databaseUrl, { issuer, configDir: CONFIG, webDir });
  b = await startApi(databaseUrl, { issuer, configDir: CONFIG, webDir });
  seedDb = createDb(databaseUrl, { onError: () => undefined });
  repo = new PostgresChangeSetRepository(seedDb.db);
});

afterAll(async () => {
  await a.close();
  await b.close();
  await seedDb.close();
  await issuer.close();
  await postgres.stop();
  await rm(webDir, { recursive: true });
});

async function login(user: TestLoginUser, api: RunningApi = a): Promise<Page> {
  issuer.setLoginUser(user);
  const { cookie, csrfToken } = await pageLogin(api.url, user.username ?? user.sub, 'unused');
  return { base: api.url, cookie, csrfToken };
}

async function send(page: Page, method: 'GET' | 'POST', path: string, body?: unknown): Promise<Answer> {
  const response = await fetch(`${page.base}${path}`, {
    method,
    redirect: 'manual',
    headers: {
      cookie: page.cookie,
      ...(method === 'POST' ? { origin: new URL(page.base).origin, 'x-csrf-token': page.csrfToken, 'content-type': 'application/json' } : {}),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const text = await response.text();
  return { status: response.status, body: text === '' ? undefined : (JSON.parse(text) as unknown), headers: response.headers };
}

const get = (page: Page, path: string): Promise<Answer> => send(page, 'GET', path);

interface QueueRow {
  id: string;
  step: number;
  steps: number;
  [key: string]: unknown;
}

async function queueIds(page: Page): Promise<string[]> {
  const answer = await get(page, '/api/v1/approvals?limit=100');
  expect(answer.status).toBe(200);
  return (answer.body as { items: QueueRow[] }).items.map((r) => r.id);
}

const seedAlice = (items = 3, extra: { excluded?: number; expiresAt?: Date; at?: Date } = {}) =>
  seedPending(repo, { requester: ALICE.sub, groups: ['content', 'leads'], role: 'content_manager', items, ...extra });

interface ItemsPage {
  items: { targetId: string; status: string }[];
  next?: string;
}

describe('UI-7 change-sets are visible to requester and approvers only', () => {
  it('UI-7 the requester, the awaiting approver and a later-step approver see the detail', async () => {
    const seeded = await seedAlice();
    for (const user of [ALICE, DAVE, ERIN]) {
      const answer = await get(await login(user), `/api/v1/changesets/${seeded.id}`);
      expect(answer.status, user.sub).toBe(200);
      expect(answer.body).toMatchObject({ id: seeded.id });
    }
  });

  it('UI-7 a foreign user gets 404 on detail, items, sample, decision and start, like an unknown id', async () => {
    const seeded = await seedAlice();
    const bob = await login(BOB);
    for (const id of [seeded.id, randomUUID(), 'x']) {
      for (const path of [`/api/v1/changesets/${id}`, `/api/v1/changesets/${id}/items`, `/api/v1/changesets/${id}/sample`]) {
        const answer = await get(bob, path);
        expect({ path, status: answer.status, body: answer.body }).toEqual({ path, status: 404, body: { error: 'not_found' } });
        expect(answer.headers.get('cache-control')).toBe('no-store');
      }
      for (const [path, body] of [
        [`/api/v1/changesets/${id}/decision`, { decision: 'approve', hash: seeded.hash, count: seeded.included }],
        [`/api/v1/changesets/${id}/start`, {}],
      ] as const) {
        const answer = await send(bob, 'POST', path, body);
        expect({ path, status: answer.status, body: answer.body }).toEqual({ path, status: 404, body: { error: 'not_found' } });
        expect(answer.headers.get('cache-control')).toBe('no-store');
      }
    }
  });

  it('UI-7 APR-6 the approval queue lists what the user can decide now, not their own, not expired', async () => {
    // One excluded item: the queue shows the number an approver approves (included), not the total.
    const seeded = await seedAlice(3, { excluded: 1 });
    const dave = await login(DAVE);
    const answer = await get(dave, '/api/v1/approvals?limit=100');
    expect(answer.headers.get('cache-control')).toBe('no-store');
    const row = (answer.body as { items: QueueRow[] }).items.find((r) => r.id === seeded.id);
    expect(row).toMatchObject({
      id: seeded.id,
      operation: 'shop.update_content',
      title: 'Update product content',
      requester: ALICE.sub,
      total: 3,
      step: 1,
      steps: 2,
      submittedAt: expect.any(String) as unknown,
      expiresAt: expect.any(String) as unknown,
    });
    expect(await queueIds(await login(ALICE))).not.toContain(seeded.id);

    const erin = await login(ERIN);
    expect(await queueIds(erin)).not.toContain(seeded.id);
    const record = await repo.get(seeded.id);
    if (record === undefined) throw new Error('seeded change-set missing');
    await recordApproval(repo, record, { approver: DAVE.sub });
    const erinRows = (await get(erin, '/api/v1/approvals?limit=100')).body as { items: QueueRow[] };
    expect(erinRows.items.find((r) => r.id === seeded.id)).toMatchObject({ step: 2, steps: 2 });

    // Seeded with the expiry already passed (no wall-clock wait); the workflow timer has not run.
    const expired = await seedAlice(3, { at: new Date(Date.now() - 120_000), expiresAt: new Date(Date.now() - 60_000) });
    const live = await seedAlice();
    const daveIds = await queueIds(dave);
    expect(daveIds).toContain(live.id);
    expect(daveIds).not.toContain(expired.id);
  });

  it('UI-7 APR-2 the queue leaves out a change-set the user decided an earlier step of, though they hold the awaiting role', async () => {
    const seeded = await seedAlice();
    const record = await repo.get(seeded.id);
    if (record === undefined) throw new Error('seeded change-set missing');
    // dave (leads, brand) approves step 1; step 2 awaits brand_owner, which dave also holds.
    await recordApproval(repo, record, { approver: DAVE.sub });
    expect(await queueIds(await login(DAVE))).not.toContain(seeded.id);
    expect(await queueIds(await login(ERIN))).toContain(seeded.id);
  });

  it('UI-7 NFR-8 the queue pages by cursor and validates its query', async () => {
    const seeded = [await seedAlice(), await seedAlice(), await seedAlice()];
    const dave = await login(DAVE);
    const seen: string[] = [];
    let path = '/api/v1/approvals?limit=1';
    for (let i = 0; i < 200; i++) {
      const page = (await get(dave, path)).body as { items: QueueRow[]; next?: string };
      expect(page.items.length).toBeLessThanOrEqual(1);
      seen.push(...page.items.map((r) => r.id));
      if (page.next === undefined) break;
      path = `/api/v1/approvals?limit=1&after=${page.next}`;
    }
    expect(new Set(seen).size).toBe(seen.length);
    for (const s of seeded) expect(seen).toContain(s.id);
    for (const q of ['limit=0', 'limit=101', 'limit=10&limit=20', 'after=***', `after=${'A'.repeat(5000)}`]) {
      const answer = await get(dave, `/api/v1/approvals?${q}`);
      expect({ q, status: answer.status, body: answer.body }).toEqual({ q, status: 400, body: { error: 'invalid_query' } });
    }
  });
});

describe('APR-5 the detail is built from storage', () => {
  it('APR-5 UI-2 the detail shows request, policy, stats, hash, chain and viewer', async () => {
    const seeded = await seedAlice(3, { excluded: 1 });
    const answer = await get(await login(DAVE), `/api/v1/changesets/${seeded.id}`);
    expect(answer.status).toBe(200);
    expect(answer.headers.get('cache-control')).toBe('no-store');
    expect(answer.body).toMatchObject({
      id: seeded.id,
      status: 'pending_approval',
      hash: seeded.hash,
      operation: { id: 'shop.update_content', title: 'Update product content' },
      request: { args: { brand: 'acme', changes: { name: 'new' } }, requester: ALICE.sub },
      policy: { rule: 'role:content_manager/grant:own-brands', role: 'content_manager', approval: { reason: 'above_threshold', threshold: 2, included: 3 } },
      stats: { total: 4, included: 3, excluded: { not_found: 1 } },
      approval: { round: 1, awaitingRole: 'content_lead', steps: [{ step: 1, role: 'content_lead' }, { step: 2, role: 'brand_owner' }] },
      viewer: { canDecide: true, reason: null },
    });
  });

  it('UI-3 the requester sees canSubmit and canExclude on a prepared change-set', async () => {
    const seeded = await seedPrepared(repo, { requester: ALICE.sub, items: 2 });
    const own = await get(await login(ALICE), `/api/v1/changesets/${seeded.id}`);
    expect(own.status).toBe(200);
    expect(own.body).toMatchObject({ status: 'prepared', rollback: { available: false }, viewer: { canSubmit: true, canExclude: true } });
  });

  it('UI-4 the page detail carries the requester\'s rollback block', async () => {
    // Whole seconds survive the round trip through timestamptz.
    const until = new Date(Math.floor((Date.now() + 86_400_000) / 1000) * 1000);
    const open = await seedExecuted(repo, { requester: ALICE.sub, items: 2, rollbackUntil: until });
    const closed = await seedExecuted(repo, { requester: ALICE.sub, items: 2 });
    const page = await login(ALICE);
    expect((await get(page, `/api/v1/changesets/${open.id}`)).body).toMatchObject({
      status: 'completed',
      rollback: { available: true, count: 2, until: until.toISOString() },
    });
    expect((await get(page, `/api/v1/changesets/${closed.id}`)).body).toMatchObject({ rollback: { available: false, reason: 'window_closed' } });
  });

  it('APR-5 the sample is deterministic per seed, included items only, and re-sampling draws a new seed', async () => {
    const seeded = await seedAlice(30, { excluded: 5 });
    const dave = await login(DAVE);
    const seed = '0123456789abcdef0123456789abcdef';
    const first = await get(dave, `/api/v1/changesets/${seeded.id}/sample?seed=${seed}&size=20`);
    const second = await get(dave, `/api/v1/changesets/${seeded.id}/sample?seed=${seed}&size=20`);
    expect(first.status).toBe(200);
    expect(first.headers.get('cache-control')).toBe('no-store');
    expect(first.body).toEqual(second.body);
    const sample = first.body as { seed: string; items: { status: string }[] };
    expect(sample.seed).toBe(seed);
    expect(sample.items).toHaveLength(20);
    expect(sample.items.filter((i) => i.status === 'excluded')).toEqual([]);

    const fresh = (await get(dave, `/api/v1/changesets/${seeded.id}/sample`)).body as { seed: string; items: unknown[] };
    expect(fresh.seed).toMatch(/^[0-9a-f]{32}$/);
    expect(fresh.items).toHaveLength(10);
    const again = (await get(dave, `/api/v1/changesets/${seeded.id}/sample?seed=${fresh.seed}`)).body;
    expect(again).toEqual(fresh);

    const tooBig = await get(dave, `/api/v1/changesets/${seeded.id}/sample?size=51`);
    expect({ status: tooBig.status, body: tooBig.body }).toEqual({ status: 400, body: { error: 'invalid_query' } });
    expect(tooBig.headers.get('cache-control')).toBe('no-store');
  });
});

describe('NFR-8 items are paged on the server', () => {
  it('NFR-8 pages of 50 cover every item once in target order', async () => {
    const seeded = await seedAlice(120);
    const dave = await login(DAVE);
    const sizes: number[] = [];
    const targets: string[] = [];
    let path = `/api/v1/changesets/${seeded.id}/items`;
    let last: ItemsPage | undefined;
    for (let i = 0; i < 10; i++) {
      const answer = await get(dave, path);
      expect(answer.status).toBe(200);
      last = answer.body as ItemsPage;
      sizes.push(last.items.length);
      targets.push(...last.items.map((it) => it.targetId));
      if (last.next === undefined) break;
      path = `/api/v1/changesets/${seeded.id}/items?after=${last.next}`;
    }
    expect(sizes).toEqual([50, 50, 20]);
    expect(last?.next).toBeUndefined();
    expect(targets).toEqual(Array.from({ length: 120 }, (_, i) => `SKU-${String(i + 1).padStart(4, '0')}`));
    expect((await get(dave, `/api/v1/changesets/${seeded.id}/items?limit=1`)).body).toEqual({
      items: [{ targetId: 'SKU-0001', status: 'pending', before: { name: 'old 1' }, after: { name: 'new 1' } }],
      next: expect.any(String) as unknown,
    });
  });

  it('NFR-8 limit and cursor are validated', async () => {
    const seeded = await seedAlice(3, { excluded: 2 });
    const dave = await login(DAVE);
    for (const q of ['limit=0', 'limit=101', 'limit=1&limit=2', 'after=***', 'status=deleted']) {
      const answer = await get(dave, `/api/v1/changesets/${seeded.id}/items?${q}`);
      expect({ q, status: answer.status, body: answer.body }).toEqual({ q, status: 400, body: { error: 'invalid_query' } });
      expect(answer.headers.get('cache-control')).toBe('no-store');
    }
    const excluded = (await get(dave, `/api/v1/changesets/${seeded.id}/items?status=excluded`)).body as { items: { targetId: string; status: string; reason?: string }[] };
    expect(excluded.items).toEqual([
      expect.objectContaining({ targetId: 'SKU-0004', status: 'excluded', reason: 'not_found' }),
      expect.objectContaining({ targetId: 'SKU-0005', status: 'excluded' }),
    ]);
  });
});

describe('NFR-3 page reads work on any instance', () => {
  it('NFR-3 a session from api A reads the detail on api B', async () => {
    const seeded = await seedAlice();
    const dave = await login(DAVE, a);
    const onB = await get({ ...dave, base: b.url }, `/api/v1/changesets/${seeded.id}`);
    expect(onB.status).toBe(200);
    expect(onB.body).toMatchObject({ id: seeded.id, viewer: { canDecide: true } });
  });
});
