// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Mandate Authors
/**
 * Staging files on the trusted page API (CS-10): upload and own-file listing.
 *
 * Identities (`files-config`): ed (group `editors`) holds `editor`, which grants an operation with a
 * file argument; vi (group `viewers`) holds `viewer`, which does not.
 */
import { cp, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { pageLogin, startTestIssuer, type StartedPostgres, type TestIssuer, type TestLoginUser } from '@mandate/testing';
import { HARD_MAX_FILE_BYTES, sha256Of, type FileStore } from '@mandate/core';
import { FILE_STORE } from '../../src/tokens.js';
import { auditRows, startApi, startDatabase, uploadFile, type RunningApi } from './helpers.js';

const FILES_CONFIG = fileURLToPath(new URL('./fixtures/files-config', import.meta.url));
const ED: TestLoginUser = { sub: 'ed-id', username: 'ed', groups: ['editors'] };
const ED2: TestLoginUser = { sub: 'ed2-id', username: 'ed2', groups: ['editors'] };
const ED3: TestLoginUser = { sub: 'ed3-id', username: 'ed3', groups: ['editors'] };
const ED4: TestLoginUser = { sub: 'ed4-id', username: 'ed4', groups: ['editors'] };
const FRANK: TestLoginUser = { sub: 'frank-id', username: 'frank', groups: ['editors'] };
const GINA: TestLoginUser = { sub: 'gina-id', username: 'gina', groups: ['editors'] };
const VI: TestLoginUser = { sub: 'vi-id', username: 'vi', groups: ['viewers'] };
const PNG = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x01]);

let postgres: StartedPostgres;
let databaseUrl: string;
let issuer: TestIssuer;
let api: RunningApi;
let small: RunningApi;
let configDir: string;
let smallDir: string;

interface Page {
  readonly cookie: string;
  readonly csrfToken: string;
}

beforeAll(async () => {
  ({ postgres, databaseUrl } = await startDatabase());
  issuer = await startTestIssuer();
  configDir = await mkdtemp(join(tmpdir(), 'mandate-files-e2e-'));
  await cp(FILES_CONFIG, configDir, { recursive: true });
  smallDir = await mkdtemp(join(tmpdir(), 'mandate-files-small-e2e-'));
  await cp(FILES_CONFIG, smallDir, { recursive: true });
  await writeFile(join(smallDir, 'files.yaml'), 'version: 1\nfiles: { max_bytes: 100, per_user_count: 1 }\n');
  api = await startApi(databaseUrl, { issuer, configDir });
  small = await startApi(databaseUrl, { issuer, configDir: smallDir });
});

afterAll(async () => {
  await small.close();
  await api.close();
  await issuer.close();
  await postgres.stop();
  await rm(configDir, { recursive: true });
  await rm(smallDir, { recursive: true });
});

async function login(target: RunningApi, user: TestLoginUser): Promise<Page> {
  issuer.setLoginUser(user);
  const { cookie, csrfToken } = await pageLogin(target.url, user.username ?? user.sub, 'unused');
  return { cookie, csrfToken };
}

const storeOf = (target: RunningApi): FileStore => target.app.get<FileStore>(FILE_STORE);
const upload = (target: RunningApi, page: Page, options: Omit<Parameters<typeof uploadFile>[1], 'cookie' | 'csrfToken'> & { csrfToken?: string | null }) =>
  uploadFile(target.url, { cookie: page.cookie, csrfToken: page.csrfToken, ...options });
const listed = async (target: RunningApi, page: Page): Promise<Record<string, unknown>[]> => {
  const response = await fetch(`${target.url}/api/v1/files`, { headers: { cookie: page.cookie } });
  expect(response.status).toBe(200);
  expect(response.headers.get('cache-control')).toBe('no-store');
  return (await response.json()) as Record<string, unknown>[];
};

describe('CS-10 staging files', () => {
  it('CS-10 an editor uploads a file: 201, listed, audited without the name', async () => {
    const ed = await login(api, ED);
    const answer = await upload(api, ed, { body: PNG, name: 'caf%C3%A9.png', type: 'Image/PNG; x=y' });
    expect(answer.status).toBe(201);
    const view = answer.body as Record<string, string | number>;
    expect(view).toMatchObject({ name: 'café.png', mediaType: 'image/png', size: 10, sha256: sha256Of(PNG), preview: 'image' });
    expect(Date.parse(String(view.expiresAt)) - Date.parse(String(view.createdAt))).toBe(24 * 3600 * 1000);
    expect((await listed(api, ed)).map((f) => f.id)).toEqual([view.id]);
    const rows = await auditRows(databaseUrl, `action = 'file.staged' and subject = $1`, [String(view.id)]);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ actor: 'ed-id', outcome: 'ok', correlation_id: answer.correlationId, details: { size: 10, mediaType: 'image/png', sha256: sha256Of(PNG) } });
    expect(Object.keys(rows[0]?.details ?? {}).sort()).toEqual(['mediaType', 'sha256', 'size']);
    expect(JSON.stringify(rows)).not.toContain('caf');
  });

  it('CS-10 a listing shows only the caller own files', async () => {
    const ed2 = await login(api, ED2);
    const other = await login(api, ED3);
    const answer = await upload(api, ed2, { body: PNG });
    expect(answer.status).toBe(201);
    expect(await listed(api, other)).toEqual([]);
  });

  it('CS-10 an application/json upload is stored as exactly the bytes sent', async () => {
    const ed = await login(api, ED);
    const body = new TextEncoder().encode('{"a": 1}');
    const answer = await upload(api, ed, { body, type: 'application/json' });
    expect(answer.status).toBe(201);
    const stored = await storeOf(api).content((answer.body as { id: string }).id);
    expect(Buffer.from(stored ?? []).toString('utf8')).toBe('{"a": 1}');
    expect(stored?.length).toBe(8);
  });

  it('CS-10 a 5 MiB body is stored, above the 4 MB JSON limit', async () => {
    const ed = await login(api, ED4);
    const body = new Uint8Array(5 * 1024 * 1024).fill(7);
    const answer = await upload(api, ed, { body, type: 'application/json' });
    expect(answer.status).toBe(201);
    expect((answer.body as { size: number }).size).toBe(body.length);
    const stored = await storeOf(api).content((answer.body as { id: string }).id);
    expect(stored?.length).toBe(body.length);
  });

  it('SEC-1 CS-10 refuses a viewer, no session and a bad CSRF token; nothing is stored', async () => {
    const vi = await login(api, VI);
    expect(await upload(api, vi, { body: PNG })).toMatchObject({ status: 403, body: { error: 'forbidden' } });
    expect(await uploadFile(api.url, { body: PNG })).toMatchObject({ status: 401 });
    const ed = await login(api, ED3);
    expect(await upload(api, ed, { body: PNG, csrfToken: null })).toMatchObject({ status: 403, body: { error: 'csrf' } });
    expect(await upload(api, ed, { body: PNG, csrfToken: 'wrong' })).toMatchObject({ status: 403, body: { error: 'csrf' } });
    expect(await listed(api, ed)).toEqual([]);
    const forbidden = await fetch(`${api.url}/api/v1/files`, { headers: { cookie: vi.cookie } });
    expect(forbidden.status).toBe(403);
    expect(await forbidden.json()).toEqual({ error: 'forbidden' });
    expect((await fetch(`${api.url}/api/v1/files`)).status).toBe(401);
  });

  it('CS-10 refuses malformed names, media types and empty bodies; nothing is stored', async () => {
    const ed = await login(api, ED3);
    for (const name of ['..', '.', 'a%2Fb', 'a%5Cb', 'a%0Ab', '%E0%A4%A', null]) {
      expect(await upload(api, ed, { body: PNG, name }), String(name)).toMatchObject({ status: 400, body: { error: 'invalid_name' } });
    }
    expect(await upload(api, ed, { body: PNG, type: 'png' })).toMatchObject({ status: 400, body: { error: 'invalid_media_type' } });
    expect(await upload(api, ed, { body: PNG, type: null })).toMatchObject({ status: 400, body: { error: 'invalid_media_type' } });
    expect(await upload(api, ed, { body: new Uint8Array(), type: 'image/png' })).toMatchObject({ status: 400, body: { error: 'empty_file' } });
    expect(await upload(api, ed, { body: new Uint8Array(), type: 'application/json' })).toMatchObject({ status: 400, body: { error: 'empty_file' } });
    expect(await listed(api, ed)).toEqual([]);
  });

  it('CS-10 a body above files.max_bytes is 413 and one above the hard limit is 413 too', async () => {
    const frank = await login(small, FRANK);
    expect(await upload(small, frank, { body: new Uint8Array(101) })).toMatchObject({ status: 413, body: { error: 'payload_too_large' } });
    expect(await listed(small, frank)).toEqual([]);
    expect(await upload(small, frank, { body: new Uint8Array(100) })).toMatchObject({ status: 201 });
    const ed = await login(api, ED3);
    expect(await upload(api, ed, { body: new Uint8Array(HARD_MAX_FILE_BYTES + 1), type: 'application/json' })).toMatchObject({ status: 413, body: { error: 'payload_too_large' } });
    expect(await listed(api, ed)).toEqual([]);
  });

  it('CS-10 a second upload over per_user_count is 409 quota_exceeded; nothing more is stored', async () => {
    const ed = await login(small, GINA);
    expect((await upload(small, ed, { body: PNG })).status).toBe(201);
    expect(await upload(small, ed, { body: PNG })).toMatchObject({ status: 409, body: { error: 'quota_exceeded' } });
    expect(await listed(small, ed)).toHaveLength(1);
  });
});
