// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Mandate Authors
import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { strFromU8, unzipSync } from 'fflate';
import type { ChangeItemRecord } from '@mandate/core';
import { createDb, PostgresChangeSetRepository, type Database } from '@mandate/db';
import { pageLogin, startTestIssuer, type StartedPostgres, type TestIssuer, type TestLoginUser } from '@mandate/testing';
import { seedPending, seedPrepared, type Seeded } from './approval-seed.js';
import { auditRows, startApi, startDatabase, type RunningApi } from './helpers.js';

const CONFIG = fileURLToPath(new URL('./fixtures/approvals-pages-config', import.meta.url));

const ALICE: TestLoginUser = { sub: 'alice-id', username: 'alice', groups: ['content', 'leads'] };
const DAVE: TestLoginUser = { sub: 'dave-id', username: 'dave', groups: ['leads', 'brand'] };
const BOB: TestLoginUser = { sub: 'bob-id', username: 'bob', groups: ['support'] };

/** A pending item whose new name is a formula: the export must neutralise it (SEC-5). */
const FORMULA: ChangeItemRecord = { targetId: 'SKU-9999', status: 'pending', before: { name: 'old 9999' }, after: { name: '=SUM(A1)' } };

let postgres: StartedPostgres;
let databaseUrl: string;
let issuer: TestIssuer;
let api: RunningApi;
let webDir: string;
let seedDb: Database;
let repo: PostgresChangeSetRepository;

interface Download {
  readonly status: number;
  readonly headers: Headers;
  readonly bytes: Uint8Array;
  readonly correlationId: string;
}

beforeAll(async () => {
  ({ postgres, databaseUrl } = await startDatabase());
  issuer = await startTestIssuer();
  webDir = await mkdtemp(join(tmpdir(), 'mandate-web-e2e-'));
  await mkdir(join(webDir, 'assets'));
  await writeFile(join(webDir, 'index.html'), '<!doctype html><title>Approvals</title><div id="root"></div>');
  seedDb = createDb(databaseUrl, { onError: () => undefined });
  repo = new PostgresChangeSetRepository(seedDb.db);
  api = await startApi(databaseUrl, { issuer, configDir: CONFIG, webDir });
});

afterAll(async () => {
  await api.close();
  await seedDb.close();
  await issuer.close();
  await postgres.stop();
  await rm(webDir, { recursive: true });
});

async function login(user: TestLoginUser): Promise<string> {
  issuer.setLoginUser(user);
  return (await pageLogin(api.url, user.username ?? user.sub, 'unused')).cookie;
}

async function download(cookie: string, id: string, query: string): Promise<Download> {
  const response = await fetch(`${api.url}/api/v1/changesets/${id}/export${query}`, { headers: { cookie } });
  return {
    status: response.status,
    headers: response.headers,
    bytes: new Uint8Array(await response.arrayBuffer()),
    correlationId: response.headers.get('x-correlation-id') ?? '',
  };
}

const textOf = (d: Download): string => new TextDecoder('utf-8', { ignoreBOM: true }).decode(d.bytes);
const jsonOf = (d: Download): unknown => JSON.parse(textOf(d)) as unknown;
/** Lines of a CSV body: every line, the last included, ends with CRLF. */
const linesOf = (csv: string): string[] => csv.split('\r\n').slice(0, -1);

const seedAlice = (): Promise<Seeded> =>
  seedPending(repo, { requester: ALICE.sub, groups: ['content', 'leads'], role: 'content_manager', items: 3, excluded: 1, extra: [FORMULA] });

describe('CS-8 change-set export', () => {
  it('CS-8 CSV export of a visible change-set: headers, BOM, one row per item, formula prefixed', async () => {
    const seeded = await seedAlice();
    const answer = await download(await login(ALICE), seeded.id, '?format=csv');
    expect(answer.status).toBe(200);
    expect(answer.headers.get('content-type')).toMatch(/^text\/csv/);
    expect(answer.headers.get('content-disposition')).toBe(`attachment; filename="changeset-${seeded.id}.csv"`);
    expect(answer.headers.get('cache-control')).toBe('no-store');
    expect(answer.headers.get('x-content-type-options')).toBe('nosniff');
    const body = textOf(answer);
    expect(body.startsWith('﻿"target_id"')).toBe(true);
    expect(linesOf(body)).toHaveLength(1 + 5);
    expect(body).toContain(`"'=SUM(A1)"`);
  });

  it('CS-8 XLSX export unzips to a workbook with the same rows', async () => {
    const seeded = await seedAlice();
    const answer = await download(await login(ALICE), seeded.id, '?format=xlsx');
    expect(answer.status).toBe(200);
    expect(answer.headers.get('content-type')).toBe('application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    expect(answer.headers.get('content-disposition')).toBe(`attachment; filename="changeset-${seeded.id}.xlsx"`);
    expect(answer.headers.get('cache-control')).toBe('no-store');
    expect(answer.headers.get('x-content-type-options')).toBe('nosniff');
    const sheet = strFromU8(unzipSync(answer.bytes)['xl/worksheets/sheet1.xml'] ?? new Uint8Array());
    const rows = [...sheet.matchAll(/<row[^>]*>(.*?)<\/row>/g)].map((m) => m[1] ?? '');
    expect(rows).toHaveLength(1 + 5);
    expect(rows[0]).toContain('<t xml:space="preserve">target_id</t>');
    expect(rows.at(-1)).toContain(`<t xml:space="preserve">'=SUM(A1)</t>`);
  });

  it('UI-7 SEC-1 export follows detail visibility: approver yes, foreign user and unknown id 404', async () => {
    const seeded = await seedAlice();
    expect((await download(await login(DAVE), seeded.id, '?format=csv')).status).toBe(200);
    const bob = await login(BOB);
    for (const id of [seeded.id, randomUUID(), 'x']) {
      const answer = await download(bob, id, '?format=csv');
      expect({ status: answer.status, body: jsonOf(answer) }).toEqual({ status: 404, body: { error: 'not_found' } });
      expect(answer.headers.get('content-disposition')).toBeNull();
    }
  });

  it('CS-8 an unknown or repeated format is 400 invalid_query', async () => {
    const seeded = await seedAlice();
    const alice = await login(ALICE);
    for (const query of ['?format=pdf', '', '?format=csv&format=xlsx']) {
      const answer = await download(alice, seeded.id, query);
      expect({ query, status: answer.status, body: jsonOf(answer) }).toEqual({ query, status: 400, body: { error: 'invalid_query' } });
      const rows = await auditRows(databaseUrl, "action = 'changeset.export' and correlation_id = $1", [answer.correlationId]);
      expect(rows.map((r) => ({ outcome: r.outcome, details: r.details }))).toEqual([
        { outcome: 'denied', details: { reason: 'invalid_query', channel: 'page' } },
      ]);
    }
  });

  it('AUD-1 SEC-11 an export is audited before the stream, a refused export as denied', async () => {
    const seeded = await seedAlice();
    const ok = await download(await login(ALICE), seeded.id, '?format=csv');
    expect(ok.status).toBe(200);
    const okRows = await auditRows(databaseUrl, "action = 'changeset.export' and correlation_id = $1", [ok.correlationId]);
    expect(okRows.map((r) => ({ outcome: r.outcome, actor: r.actor, subject: r.subject, details: r.details }))).toEqual([
      { outcome: 'ok', actor: ALICE.sub, subject: seeded.id, details: { format: 'csv', rows: 5, channel: 'page' } },
    ]);

    const refused = await download(await login(BOB), seeded.id, '?format=csv');
    expect(refused.status).toBe(404);
    const deniedRows = await auditRows(databaseUrl, "action = 'changeset.export' and correlation_id = $1", [refused.correlationId]);
    expect(deniedRows.map((r) => ({ outcome: r.outcome, actor: r.actor, subject: r.subject, details: r.details }))).toEqual([
      { outcome: 'denied', actor: BOB.sub, subject: seeded.id, details: { reason: 'not_found', channel: 'page' } },
    ]);

    // A malformed ID is refused and audited, but never stored as the change-set.
    const malformed = await download(await login(BOB), 'x', '?format=csv');
    const malformedRows = await auditRows(databaseUrl, "action = 'changeset.export' and correlation_id = $1", [malformed.correlationId]);
    expect(malformedRows.map((r) => ({ outcome: r.outcome, subject: r.subject }))).toEqual([{ outcome: 'denied', subject: null }]);
  });

  it('NFR-8 a 1200-item change-set exports every row', async () => {
    const seeded = await seedPrepared(repo, { requester: ALICE.sub, items: 1200 });
    const answer = await download(await login(ALICE), seeded.id, '?format=csv');
    expect(answer.status).toBe(200);
    const lines = linesOf(textOf(answer));
    expect(lines).toHaveLength(1201);
    expect(lines.at(-1)).toMatch(/^"SKU-1200",/);
  });
});
