import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ExecutorUnavailable, type ChangeSetExecutor, type StartOutcome, type StartRequest } from '@aiops/core';
import { createDb, PostgresChangeSetRepository, type Database } from '@aiops/db';
import { InMemoryExecutor, pageLogin, ScriptedWriter, startTestIssuer, type StartedPostgres, type TestIssuer, type TestLoginUser } from '@aiops/testing';
import { seedPending, type Seeded } from './approval-seed.js';
import { auditRows, startApi, startDatabase, type RunningApi } from './helpers.js';

const PAGE_API = fileURLToPath(new URL('../../../../tooling/acceptance/page-api.mjs', import.meta.url));
const run = promisify(execFile);

const CONFIG = fileURLToPath(new URL('./fixtures/approvals-pages-config', import.meta.url));

const ALICE: TestLoginUser = { sub: 'alice-id', username: 'alice', groups: ['content', 'leads'] };
const DAVE: TestLoginUser = { sub: 'dave-id', username: 'dave', groups: ['leads', 'brand'] };
const ERIN: TestLoginUser = { sub: 'erin-id', username: 'erin', groups: ['brand'] };
const BOB: TestLoginUser = { sub: 'bob-id', username: 'bob', groups: ['support'] };
const EVE: TestLoginUser = { sub: 'eve-id', username: 'eve', groups: ['editors'] };

const SECRET_COMMENT = 'audit-must-not-see-this-comment';

/** Wraps the in-memory executor; a test can make starts refuse or the executor unreachable. */
class ToggleExecutor implements ChangeSetExecutor {
  refuseStarts = false;
  unavailable = false;
  readonly started: string[] = [];

  constructor(readonly inner: InMemoryExecutor) {}

  async start(req: StartRequest): Promise<StartOutcome> {
    if (this.unavailable) throw new ExecutorUnavailable();
    if (this.refuseStarts) return { ok: false, reason: 'not_executable' };
    this.started.push(req.changesetId);
    return this.inner.start(req);
  }

  cancel(req: Parameters<ChangeSetExecutor['cancel']>[0]): ReturnType<ChangeSetExecutor['cancel']> {
    return this.inner.cancel(req);
  }

  progress(changesetId: string): ReturnType<ChangeSetExecutor['progress']> {
    return this.inner.progress(changesetId);
  }

  // The in-memory run never waits for a signal, so its wake takes no argument.
  wake(): Promise<void> {
    return this.inner.wake();
  }
}

let postgres: StartedPostgres;
let databaseUrl: string;
let issuer: TestIssuer;
let api: RunningApi;
let webDir: string;
let seedDb: Database;
let repo: PostgresChangeSetRepository;
let executor: ToggleExecutor;

/** Every refusal of the decision route seen in this file, checked by the AUD-1 test. */
const refusals: { correlationId: string; reason: string }[] = [];

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
  for (const id of executor.started) await executor.inner.settled(id);
  await api.close();
  await seedDb.close();
  await issuer.close();
  await postgres.stop();
  await rm(webDir, { recursive: true });
});

const nowSeconds = (): number => Math.floor(Date.now() / 1000);

async function login(user: TestLoginUser, o: { authTime?: number; fresh?: boolean } = {}): Promise<Page> {
  issuer.setLoginUser(o.authTime === undefined ? user : { ...user, authTime: o.authTime });
  const { cookie, csrfToken } = await pageLogin(api.url, user.username ?? user.sub, 'unused', o.fresh === true ? { fresh: true } : {});
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
  const text = await response.text();
  return { status: response.status, body: text === '' ? undefined : (JSON.parse(text) as unknown), correlationId: response.headers.get('x-correlation-id') ?? '' };
}

const decide = (page: Page, id: string, body: unknown, headers?: Record<string, string | undefined>): Promise<Answer> =>
  post(page, `/api/v1/changesets/${id}/decision`, body, headers);

const start = (page: Page, id: string, headers?: Record<string, string | undefined>): Promise<Answer> => post(page, `/api/v1/changesets/${id}/start`, {}, headers);

const approve = (s: Seeded, extra: Record<string, unknown> = {}): Record<string, unknown> => ({ decision: 'approve', hash: s.hash, count: s.included, ...extra });

/** Asserts a refused decision and remembers it for the AUD-1 test. */
function refused(answer: Answer, status: number, reason: string): void {
  expect({ status: answer.status, body: answer.body }).toEqual({ status, body: { error: reason } });
  refusals.push({ correlationId: answer.correlationId, reason });
}

async function detail(page: Page, id: string): Promise<{ status: string; viewer: Record<string, unknown> }> {
  const response = await fetch(`${api.url}/api/v1/changesets/${id}`, { headers: { cookie: page.cookie } });
  expect(response.status).toBe(200);
  return (await response.json()) as { status: string; viewer: Record<string, unknown> };
}

async function statusOf(id: string): Promise<string | undefined> {
  return (await repo.get(id))?.status;
}

const seedAlice = (extra: { expiresAt?: Date; at?: Date } = {}): Promise<Seeded> =>
  seedPending(repo, { requester: ALICE.sub, groups: ['content', 'leads'], role: 'content_manager', items: 3, excluded: 1, ...extra });

describe('SEC-8 deciding needs CSRF, the exact Origin and a fresh login', () => {
  it('SEC-8 a decision without the CSRF token or with another Origin is 403 csrf and changes nothing', async () => {
    const seeded = await seedAlice();
    const dave = await login(DAVE);
    const noToken = await decide(dave, seeded.id, approve(seeded), { 'x-csrf-token': undefined });
    refused(noToken, 403, 'csrf');
    const otherOrigin = await decide(dave, seeded.id, approve(seeded), { origin: 'http://evil.example' });
    refused(otherOrigin, 403, 'csrf');
    expect(await statusOf(seeded.id)).toBe('pending_approval');
    for (const answer of [noToken, otherOrigin]) {
      const rows = await auditRows(databaseUrl, "action = 'approval.decision' and correlation_id = $1", [answer.correlationId]);
      expect(rows.map((r) => ({ outcome: r.outcome, reason: r.details.reason, actor: r.actor, subject: r.subject }))).toEqual([
        { outcome: 'denied', reason: 'csrf', actor: DAVE.sub, subject: seeded.id },
      ]);
    }
  });

  it('SEC-8 a login older than 300 s is 403 reauthentication_required', async () => {
    const seeded = await seedAlice();
    const stale = await login(DAVE, { authTime: nowSeconds() - 301 });
    refused(await decide(stale, seeded.id, approve(seeded)), 403, 'reauthentication_required');
    expect(await statusOf(seeded.id)).toBe('pending_approval');
  });

  it('SEC-8 checks run in order: visibility, CSRF, freshness, body', async () => {
    const seeded = await seedAlice();
    const bob = await login(BOB);
    refused(await decide(bob, seeded.id, approve(seeded), { 'x-csrf-token': undefined }), 404, 'not_found');
    const stale = await login(DAVE, { authTime: nowSeconds() - 301 });
    refused(await decide(stale, seeded.id, {}, { 'x-csrf-token': undefined }), 403, 'csrf');
    refused(await decide(stale, seeded.id, {}), 403, 'reauthentication_required');
    const fresh = await login(DAVE);
    refused(await decide(fresh, seeded.id, {}), 400, 'invalid_body');
    expect(await statusOf(seeded.id)).toBe('pending_approval');
  });
});

describe('APR-2 separation of duties on the page', () => {
  it('APR-2 the requester holding the approver role is refused 403 separation_of_duties', async () => {
    const seeded = await seedAlice();
    // alice is in `leads` (content_lead, the step 1 role) and requested it.
    refused(await decide(await login(ALICE), seeded.id, approve(seeded)), 403, 'separation_of_duties');
    expect(await statusOf(seeded.id)).toBe('pending_approval');
  });

  it('APR-2 one person cannot decide two steps', async () => {
    const seeded = await seedAlice();
    const dave = await login(DAVE);
    const first = await decide(dave, seeded.id, approve(seeded));
    expect({ status: first.status, body: first.body }).toEqual({ status: 200, body: { status: 'pending_approval' } });
    // Step 2 awaits brand_owner, which dave also holds.
    refused(await decide(dave, seeded.id, approve(seeded)), 403, 'separation_of_duties');
    const erin = await login(ERIN);
    const last = await decide(erin, seeded.id, approve(seeded));
    // The decision's own status (ruling P2); the start is reported beside it.
    expect({ status: last.status, body: last.body }).toEqual({ status: 200, body: { status: 'approved', start: 'started' } });
    expect(['executing', 'completed']).toContain((await detail(erin, seeded.id)).status);
  });
});

describe('APR-6 SEC-9 the approval binds the hash and the count', () => {
  it('SEC-9 a stale hash is 409 hash_mismatch', async () => {
    const seeded = await seedAlice();
    // The comment rides along on a refusal: the AUD-1 test checks that no audit row holds it.
    refused(await decide(await login(DAVE), seeded.id, approve(seeded, { hash: `sha256:${'0'.repeat(64)}`, comment: SECRET_COMMENT })), 409, 'hash_mismatch');
    expect(await statusOf(seeded.id)).toBe('pending_approval');
  });

  it('APR-6 a count other than stats.included is 409 count_mismatch', async () => {
    const seeded = await seedAlice();
    // stats.total is 4 (one excluded item); the approver approves the 3 included ones.
    refused(await decide(await login(DAVE), seeded.id, approve(seeded, { count: 4 })), 409, 'count_mismatch');
    expect(await statusOf(seeded.id)).toBe('pending_approval');
  });
});

describe('CS-6 no decision after expiry', () => {
  it('CS-6 deciding an expired change-set is 409 expired', async () => {
    // Seeded with the expiry already passed (no wall-clock wait); nothing has moved it to expired yet.
    const seeded = await seedAlice({ at: new Date(Date.now() - 120_000), expiresAt: new Date(Date.now() - 60_000) });
    const dave = await login(DAVE);
    refused(await decide(dave, seeded.id, approve(seeded)), 409, 'expired');
    expect((await detail(dave, seeded.id)).status).toBe('expired');
  });
});

describe('AUTH-6 step-up before an approval that requires it', () => {
  it('AUTH-6 a login from before the submission is refused step_up_required, a fresh re-login passes', async () => {
    // dave's login (60 s old, fresh by SEC-8) predates the submission (2 s old): the step-up is unmet.
    const stale = await login(DAVE, { authTime: nowSeconds() - 60 });
    const seeded = await seedPending(repo, { requester: EVE.sub, groups: ['editors'], role: 'catalog_editor', items: 2, at: new Date(Date.now() - 2_000) });
    expect((await detail(stale, seeded.id)).viewer).toMatchObject({ canDecide: true, stepUpSatisfied: false });
    refused(await decide(stale, seeded.id, approve(seeded)), 403, 'step_up_required');

    const fresh = await login(DAVE, { fresh: true });
    expect((await detail(fresh, seeded.id)).viewer).toMatchObject({ canDecide: true, stepUpSatisfied: true });
    const answer = await decide(fresh, seeded.id, approve(seeded));
    expect(answer.status).toBe(200);
    expect(answer.body).toMatchObject({ status: 'approved', start: 'started' });
  });
});

describe('APR-4 reject and return', () => {
  it('APR-4 return without a comment is 400 comment_required; with one it goes back to prepared', async () => {
    const seeded = await seedAlice();
    const dave = await login(DAVE);
    refused(await decide(dave, seeded.id, { decision: 'return', hash: seeded.hash, count: seeded.included }), 400, 'comment_required');
    const returned = await decide(dave, seeded.id, { decision: 'return', hash: seeded.hash, count: seeded.included, comment: 'Please fix the brand.' });
    expect({ status: returned.status, body: returned.body }).toEqual({ status: 200, body: { status: 'prepared' } });
    expect(await statusOf(seeded.id)).toBe('prepared');
  });

  it('APR-4 a rejected change-set answers 409 not_pending to a further decision', async () => {
    const seeded = await seedAlice();
    const dave = await login(DAVE);
    const rejected = await decide(dave, seeded.id, { decision: 'reject', hash: seeded.hash, count: seeded.included, comment: 'No.' });
    expect({ status: rejected.status, body: rejected.body }).toEqual({ status: 200, body: { status: 'rejected' } });
    refused(await decide(await login(ERIN), seeded.id, approve(seeded)), 409, 'not_pending');
  });
});

describe('AUD-1 SEC-11 every page refusal is audited once', () => {
  it('AUD-1 SEC-11 each refused decision leaves exactly one approval.decision denied row with its reason and no comment text', async () => {
    expect(refusals.length).toBeGreaterThanOrEqual(12);
    for (const r of refusals) {
      // The lazy expiry's own `changeset.transition` row shares the correlation ID; it is not a refusal.
      const rows = await auditRows(databaseUrl, "correlation_id = $1 and (action = 'approval.decision' or outcome = 'denied')", [r.correlationId]);
      expect({ r, rows: rows.map((row) => ({ action: row.action, outcome: row.outcome, reason: row.details.reason })) }).toEqual({
        r,
        rows: [{ action: 'approval.decision', outcome: 'denied', reason: r.reason }],
      });
    }
    expect(await auditRows(databaseUrl, 'details::text like $1', [`%${SECRET_COMMENT}%`])).toEqual([]);
    expect(await auditRows(databaseUrl, 'details::text like $1', ['%Please fix the brand.%'])).toEqual([]);
  });
});

describe('APR-7 starting an approved change-set from the page', () => {
  it('APR-7 a start refusal leaves approved; the last step role starts it, others are refused', async () => {
    const seeded = await seedAlice();
    const dave = await login(DAVE);
    const erin = await login(ERIN);
    expect((await decide(dave, seeded.id, approve(seeded))).status).toBe(200);
    executor.refuseStarts = true;
    try {
      const last = await decide(erin, seeded.id, approve(seeded));
      expect({ status: last.status, body: last.body }).toEqual({ status: 200, body: { status: 'approved', start: 'not_executable' } });
    } finally {
      executor.refuseStarts = false;
    }
    expect(await statusOf(seeded.id)).toBe('approved');

    // alice (content_lead) does not hold the last step's role (brand_owner).
    const alice = await login(ALICE);
    const notPermitted = await start(alice, seeded.id);
    expect({ status: notPermitted.status, body: notPermitted.body }).toEqual({ status: 403, body: { error: 'not_permitted' } });
    const rows = await auditRows(databaseUrl, 'correlation_id = $1', [notPermitted.correlationId]);
    expect(rows.map((r) => ({ action: r.action, outcome: r.outcome, reason: r.details.reason, actor: r.actor }))).toEqual([
      { action: 'changeset.start', outcome: 'denied', reason: 'not_permitted', actor: ALICE.sub },
    ]);

    const noCsrf = await start(erin, seeded.id, { 'x-csrf-token': undefined });
    expect({ status: noCsrf.status, body: noCsrf.body }).toEqual({ status: 403, body: { error: 'csrf' } });
    expect((await auditRows(databaseUrl, 'correlation_id = $1', [noCsrf.correlationId])).map((r) => [r.action, r.details.reason])).toEqual([['changeset.start', 'csrf']]);

    const started = await start(erin, seeded.id);
    expect(started.status).toBe(200);
    expect(['executing', 'completed']).toContain((started.body as { status: string }).status);

    const pending = await seedAlice();
    const notApproved = await start(dave, pending.id);
    expect({ status: notApproved.status, body: notApproved.body }).toEqual({ status: 409, body: { error: 'not_approved_status' } });
  });

  it('APR-7 decision answer start is executor_unavailable when the executor is down', async () => {
    const seeded = await seedAlice();
    expect((await decide(await login(DAVE), seeded.id, approve(seeded))).status).toBe(200);
    const erin = await login(ERIN);
    executor.unavailable = true;
    try {
      const last = await decide(erin, seeded.id, approve(seeded));
      expect({ status: last.status, body: last.body }).toEqual({ status: 200, body: { status: 'approved', start: 'executor_unavailable' } });
      const retry = await start(erin, seeded.id);
      expect({ status: retry.status, body: retry.body }).toEqual({ status: 409, body: { error: 'executor_unavailable' } });
    } finally {
      executor.unavailable = false;
    }
    expect(await statusOf(seeded.id)).toBe('approved');
  });
});

describe('APR-7 page-api.mjs for the acceptance run', () => {
  it('APR-7 page-api.mjs lists, reads, decides and starts through the page API', async () => {
    const seeded = await seedAlice();
    const dave = await login(DAVE);
    const env = { ...process.env, AIOPS_PAGE_COOKIE: dave.cookie };
    const call = async (...args: string[]): Promise<{ status: number; body: { viewer: { canDecide: boolean } } }> => {
      const { stdout } = await run(process.execPath, [PAGE_API, api.url, ...args], { env });
      const lines = stdout.trim().split('\n');
      expect(lines).toHaveLength(1);
      return JSON.parse(lines[0] ?? '') as { status: number; body: { viewer: { canDecide: boolean } } };
    };

    const queue = await call('approvals');
    expect(queue.status).toBe(200);
    expect(JSON.stringify(queue.body)).toContain(seeded.id);
    const one = await call('changeset', seeded.id);
    expect(one.status).toBe(200);
    expect(one.body.viewer.canDecide).toBe(true);
    expect((await call('items', seeded.id)).status).toBe(200);

    const decided = await call('decide', seeded.id, 'approve', seeded.hash, String(seeded.included));
    expect(decided).toEqual({ status: 200, body: { status: 'pending_approval' } });
    expect((await call('start', seeded.id)).status).toBe(409);

    await expect(run(process.execPath, [PAGE_API, api.url, 'decide', seeded.id, 'bogus', seeded.hash, '1'], { env })).rejects.toMatchObject({ code: 2 });
  });
});
