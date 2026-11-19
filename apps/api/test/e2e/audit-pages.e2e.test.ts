import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { AuditEventInput, AuditRecord } from '@aiops/core';
import { createDb, DrizzleAuditLog, sealAuditChain, type Database } from '@aiops/db';
import { pageLogin, startTestIssuer, type StartedPostgres, type TestIssuer, type TestLoginUser } from '@aiops/testing';
import { encodeItemCursor } from '../../src/approvals/page-query.js';
import { auditRows, startApi, startDatabase, type RunningApi } from './helpers.js';

const CONFIG = fileURLToPath(new URL('./fixtures/audit-config', import.meta.url));

const EVE: TestLoginUser = { sub: 'eve-id', username: 'eve', groups: ['auditors'] };
const ALICE: TestLoginUser = { sub: 'alice-id', username: 'alice', groups: ['content', 'leads'] };
/** The actor of the bulk rows: more than one export page (1000). */
const BULK = 'bulk-id';
const BULK_ROWS = 1100;

let postgres: StartedPostgres;
let databaseUrl: string;
let issuer: TestIssuer;
let api: RunningApi;
let seedDb: Database;
let eve: string;
let alice: string;

const event = (o: Partial<AuditEventInput> & Pick<AuditEventInput, 'actor' | 'action'>): AuditEventInput => ({
  id: randomUUID(),
  outcome: 'ok',
  correlationId: randomUUID(),
  details: {},
  ...o,
});

async function login(user: TestLoginUser): Promise<string> {
  issuer.setLoginUser(user);
  return (await pageLogin(api.url, user.username ?? user.sub, 'unused')).cookie;
}

beforeAll(async () => {
  ({ postgres, databaseUrl } = await startDatabase());
  issuer = await startTestIssuer();
  seedDb = createDb(databaseUrl, { onError: () => undefined });
  api = await startApi(databaseUrl, { issuer, configDir: CONFIG });
  const log = new DrizzleAuditLog(seedDb.db);
  // Alice's decisions, oldest first; the last carries values the redactor must replace (AUD-4).
  await log.append(event({ actor: ALICE.sub, action: 'approval.decision', decision: 'allow', details: { step: 1 } }));
  await log.append(event({ actor: ALICE.sub, action: 'tool.call', subject: 'ping', details: { durationMs: 2 } }));
  await log.append(event({ actor: ALICE.sub, action: 'approval.decision', decision: 'deny', details: { step: 2 } }));
  await log.append(event({ actor: 'dave-id', action: 'approval.decision', decision: 'allow', details: { step: 1 } }));
  await log.append(event({ actor: ALICE.sub, action: 'approval.decision', decision: 'allow', details: { step: 3, token: 'tok-value', note: 'Bearer abc.def' } }));
  for (let start = 0; start < BULK_ROWS; start += 100) {
    await Promise.all(Array.from({ length: 100 }, (_, i) => log.append(event({ actor: BULK, action: 'tool.call', subject: `bulk-${start + i}`, details: { n: start + i } }))));
  }
  // Seal what is there so chainPos is set (the worker's sealer does this in production).
  while ((await sealAuditChain(seedDb.pool)).sealed > 0);
  eve = await login(EVE);
  alice = await login(ALICE);
});

afterAll(async () => {
  await api.close();
  await seedDb.close();
  await issuer.close();
  await postgres.stop();
});

interface Answer {
  readonly status: number;
  readonly headers: Headers;
  readonly body: unknown;
  readonly correlationId: string;
}

async function getJson(path: string, cookie?: string): Promise<Answer> {
  const response = await fetch(`${api.url}${path}`, { headers: cookie === undefined ? {} : { cookie } });
  const text = await response.text();
  return { status: response.status, headers: response.headers, body: text === '' ? undefined : (JSON.parse(text) as unknown), correlationId: response.headers.get('x-correlation-id') ?? '' };
}

interface SearchAnswer {
  readonly events: AuditRecord[];
  readonly nextCursor?: string;
}

/** Every match of `query`, following `nextCursor` with pages of 100. */
async function searchAll(query: string): Promise<AuditRecord[]> {
  const all: AuditRecord[] = [];
  let cursor: string | undefined;
  do {
    const answer = await getJson(`/api/v1/audit?${query}&limit=100${cursor === undefined ? '' : `&cursor=${cursor}`}`, eve);
    expect(answer.status).toBe(200);
    const body = answer.body as SearchAnswer;
    all.push(...body.events);
    cursor = body.nextCursor;
  } while (cursor !== undefined);
  return all;
}

const rowsOf = (action: string, correlationId: string) => auditRows(databaseUrl, 'action = $1 and correlation_id = $2', [action, correlationId]);

describe('SEC-1 AUD-6 audit page access', () => {
  it('SEC-1 without a session both routes answer 401', async () => {
    for (const path of ['/api/v1/audit', '/api/v1/audit/export']) {
      const answer = await getJson(path);
      expect({ path, status: answer.status, body: answer.body }).toEqual({ path, status: 401, body: { error: 'unauthenticated' } });
    }
  });

  it('SEC-1 a user without view_audit gets 403 forbidden on search and export, each audited once as denied', async () => {
    for (const [path, action] of [
      ['/api/v1/audit', 'audit.search'],
      ['/api/v1/audit/export', 'audit.export'],
    ] as const) {
      const answer = await getJson(path, alice);
      expect({ path, status: answer.status, body: answer.body }).toEqual({ path, status: 403, body: { error: 'forbidden' } });
      expect(answer.headers.get('cache-control')).toBe('no-store');
      expect(answer.headers.get('content-disposition')).toBeNull();
      const rows = await rowsOf(action, answer.correlationId);
      expect(rows.map((r) => ({ actor: r.actor, outcome: r.outcome, subject: r.subject, details: r.details }))).toEqual([
        { actor: ALICE.sub, outcome: 'denied', subject: null, details: { reason: 'forbidden', channel: 'page' } },
      ]);
    }
  });

  it('SEC-1 the flag is checked before the query: a malformed query from alice is still 403', async () => {
    for (const path of ['/api/v1/audit?cursor=%00', '/api/v1/audit?sort=seq', '/api/v1/audit/export?limit=10']) {
      const answer = await getJson(path, alice);
      expect({ path, status: answer.status, body: answer.body }).toEqual({ path, status: 403, body: { error: 'forbidden' } });
    }
  });

  it('UI-2 the session answer carries viewAudit', async () => {
    expect(((await getJson('/api/v1/session', eve)).body as { viewAudit: unknown }).viewAudit).toBe(true);
    expect(((await getJson('/api/v1/session', alice)).body as { viewAudit: unknown }).viewAudit).toBe(false);
  });
});

describe('AUD-6 NFR-8 audit search', () => {
  it("AUD-6 eve finds alice's events by actor and action, newest first, with chainPos and redacted details", async () => {
    const answer = await getJson(`/api/v1/audit?actor=${ALICE.sub}&action=approval.decision`, eve);
    expect(answer.status).toBe(200);
    expect(answer.headers.get('cache-control')).toBe('no-store');
    const body = answer.body as SearchAnswer;
    expect(body.nextCursor).toBeUndefined();
    expect(body.events.map((e) => ({ actor: e.actor, action: e.action, decision: e.decision, details: e.details }))).toEqual([
      { actor: ALICE.sub, action: 'approval.decision', decision: 'allow', details: { step: 3, token: '[redacted]', note: '[redacted]' } },
      { actor: ALICE.sub, action: 'approval.decision', decision: 'deny', details: { step: 2 } },
      { actor: ALICE.sub, action: 'approval.decision', decision: 'allow', details: { step: 1 } },
    ]);
    const seqs = body.events.map((e) => BigInt(e.seq));
    expect([...seqs].sort((x, y) => (x < y ? 1 : -1))).toEqual(seqs);
    for (const e of body.events) {
      expect(e).toEqual({
        seq: expect.stringMatching(/^[1-9][0-9]*$/) as unknown,
        id: expect.stringMatching(/^[0-9a-f-]{36}$/) as unknown,
        ts: expect.stringMatching(/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{6}Z$/) as unknown,
        actor: ALICE.sub,
        clientId: null,
        action: 'approval.decision',
        subject: null,
        decision: expect.any(String) as unknown,
        outcome: 'ok',
        correlationId: expect.any(String) as unknown,
        changesetId: null,
        details: expect.any(Object) as unknown,
        chainPos: expect.any(Number) as unknown,
      });
    }
  });

  it('NFR-8 nextCursor pages through every match once', async () => {
    const first = (await getJson(`/api/v1/audit?actor=${BULK}`, eve)).body as SearchAnswer;
    expect(first.events).toHaveLength(50);
    expect(first.nextCursor).toEqual(expect.any(String));
    const all = await searchAll(`actor=${BULK}`);
    expect(all).toHaveLength(BULK_ROWS);
    expect(new Set(all.map((e) => e.seq)).size).toBe(BULK_ROWS);
    expect(new Set(all.map((e) => e.subject))).toEqual(new Set(Array.from({ length: BULK_ROWS }, (_, i) => `bulk-${i}`)));
    const seqs = all.map((e) => BigInt(e.seq));
    expect([...seqs].sort((x, y) => (x < y ? 1 : -1))).toEqual(seqs);
  });

  it.each([
    ['actor empty', 'actor='],
    ['actor of 256 characters', `actor=${'a'.repeat(256)}`],
    ['actor with NUL', 'actor=a%00b'],
    ['unknown action', 'action=nope'],
    ['unknown outcome', 'outcome=maybe'],
    ['changeset not a UUID', 'changeset=x'],
    ['correlation empty', 'correlation='],
    ['correlation of 129 characters', `correlation=${'c'.repeat(129)}`],
    ['correlation with a newline', 'correlation=a%0Ab'],
    ['from that does not round-trip', 'from=2026-11-18'],
    ['from with month 13', 'from=2026-13-01T00:00:00.000Z'],
    ['to that is no date', 'to=2026-02-30T00:00:00.000Z'],
    ['cursor not canonical', 'cursor=QQ%3D%3D'],
    ['cursor NUL', 'cursor=%00'],
    ['cursor decoding to 0', `cursor=${encodeItemCursor('0')}`],
    ['cursor decoding to abc', `cursor=${encodeItemCursor('abc')}`],
    ['cursor with a leading zero', `cursor=${encodeItemCursor('012')}`],
    ['cursor above the bigint range', `cursor=${encodeItemCursor('9999999999999999999')}`],
    ['cursor one above the bigint maximum', `cursor=${encodeItemCursor('9223372036854775808')}`],
    ['limit 0', 'limit=0'],
    ['limit 101', 'limit=101'],
    ['limit 1.5', 'limit=1.5'],
    ['unknown key', 'sort=seq'],
    ['repeated actor', 'actor=a&actor=b'],
    ['actor object from actor[a]=1', 'actor[a]=1'],
    ['limit object', 'limit[a]=1'],
    ['cursor array', 'cursor[]=MQ'],
  ])('AUD-6 malformed values answer 400 invalid_query, never 500: %s', async (_name, query) => {
    const answer = await getJson(`/api/v1/audit?${query}`, eve);
    expect({ status: answer.status, body: answer.body }).toEqual({ status: 400, body: { error: 'invalid_query' } });
    const rows = await rowsOf('audit.search', answer.correlationId);
    expect(rows.map((r) => ({ actor: r.actor, outcome: r.outcome, details: r.details }))).toEqual([
      { actor: EVE.sub, outcome: 'denied', details: { reason: 'invalid_query', channel: 'page' } },
    ]);
  });

  it('AUD-1 SEC-3 every search writes one audit.search row with filter names and count, never filter values', async () => {
    const correlation = `corr-${randomUUID()}`;
    const answer = await getJson(`/api/v1/audit?action=approval.decision&actor=${ALICE.sub}&correlation=${correlation}&limit=5`, eve);
    expect(answer.status).toBe(200);
    expect((answer.body as SearchAnswer).events).toEqual([]);
    const counted = await getJson(`/api/v1/audit?actor=${ALICE.sub}&action=approval.decision`, eve);
    for (const [a, count, filters] of [
      [answer, 0, ['action', 'actor', 'correlation']],
      [counted, 3, ['action', 'actor']],
    ] as const) {
      const rows = await rowsOf('audit.search', a.correlationId);
      expect(rows.map((r) => ({ actor: r.actor, client_id: r.client_id, outcome: r.outcome, subject: r.subject, details: r.details }))).toEqual([
        { actor: EVE.sub, client_id: 'aiops-web', outcome: 'ok', subject: null, details: { filters, count, channel: 'page' } },
      ]);
      const text = JSON.stringify(rows);
      expect(text).not.toContain(ALICE.sub);
      expect(text).not.toContain(correlation);
    }
  });
});

describe('AUD-6 audit export', () => {
  it('AUD-6 streams every match as JSON Lines with the attachment headers', async () => {
    const response = await fetch(`${api.url}/api/v1/audit/export?actor=${BULK}`, { headers: { cookie: eve } });
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toBe('application/x-ndjson; charset=utf-8');
    expect(response.headers.get('content-disposition')).toMatch(/^attachment; filename="audit-\d{8}T\d{6}Z\.jsonl"$/);
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(response.headers.get('x-content-type-options')).toBe('nosniff');
    const body = await response.text();
    expect(body.endsWith('\n')).toBe(true);
    const records = body
      .split('\n')
      .slice(0, -1)
      .map((line) => JSON.parse(line) as AuditRecord);
    const searched = await searchAll(`actor=${BULK}`);
    expect(records.length).toBeGreaterThan(1000);
    expect(records).toHaveLength(searched.length);
    expect(records).toEqual(searched);
    const rows = await rowsOf('audit.export', response.headers.get('x-correlation-id') ?? '');
    expect(rows.map((r) => ({ actor: r.actor, outcome: r.outcome, details: r.details }))).toEqual([
      { actor: EVE.sub, outcome: 'ok', details: { filters: ['actor'], channel: 'page' } },
    ]);
  });

  it('AUD-1 the audit.export row is written before the first byte', async () => {
    // fetch resolves once the headers arrive; the body is not read yet.
    const response = await fetch(`${api.url}/api/v1/audit/export?actor=${BULK}`, { headers: { cookie: eve } });
    expect(response.status).toBe(200);
    const rows = await rowsOf('audit.export', response.headers.get('x-correlation-id') ?? '');
    expect(rows.map((r) => r.outcome)).toEqual(['ok']);
    expect((await response.text()).split('\n').length - 1).toBe(BULK_ROWS);
  });

  it('AUD-6 cursor or limit on the export is 400 invalid_query', async () => {
    for (const query of [`cursor=${encodeItemCursor('5')}`, 'limit=10', 'from=2026-13-01T00:00:00.000Z']) {
      const answer = await getJson(`/api/v1/audit/export?${query}`, eve);
      expect({ query, status: answer.status, body: answer.body }).toEqual({ query, status: 400, body: { error: 'invalid_query' } });
      expect(answer.headers.get('content-disposition')).toBeNull();
      const rows = await rowsOf('audit.export', answer.correlationId);
      expect(rows.map((r) => ({ outcome: r.outcome, details: r.details }))).toEqual([{ outcome: 'denied', details: { reason: 'invalid_query', channel: 'page' } }]);
    }
  });
});
