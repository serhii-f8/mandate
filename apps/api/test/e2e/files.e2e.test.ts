// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Mandate Authors
/**
 * Staging files on the trusted page API (CS-10): upload and own-file listing.
 *
 * Identities (`files-config`): ed (group `editors`) holds `editor`, which grants an operation with a
 * file argument; vi (group `viewers`) holds `viewer`, which does not.
 */
import { randomUUID } from 'node:crypto';
import { gzipSync } from 'node:zlib';
import { cp, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { pageLogin, startTestIssuer, type StartedPostgres, type TestIssuer, type TestLoginUser } from '@mandate/testing';
import { HARD_MAX_FILE_BYTES, sha256Of, type FileStore } from '@mandate/core';
import { FILE_STORE } from '../../src/tokens.js';
import pg from 'pg';
import { auditRows, connectClient, startApi, startDatabase, text, tokenFor, uploadFile, type RunningApi } from './helpers.js';

const FILES_CONFIG = fileURLToPath(new URL('./fixtures/files-config', import.meta.url));
const ED: TestLoginUser = { sub: 'ed-id', username: 'ed', groups: ['editors'] };
const ED2: TestLoginUser = { sub: 'ed2-id', username: 'ed2', groups: ['editors'] };
const ED3: TestLoginUser = { sub: 'ed3-id', username: 'ed3', groups: ['editors'] };
const ED4: TestLoginUser = { sub: 'ed4-id', username: 'ed4', groups: ['editors'] };
const FRANK: TestLoginUser = { sub: 'frank-id', username: 'frank', groups: ['editors'] };
const GINA: TestLoginUser = { sub: 'gina-id', username: 'gina', groups: ['editors'] };
const HANK: TestLoginUser = { sub: 'hank-id', username: 'hank', groups: ['editors'] };
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

  it('CS-10 every spelling of the route reads the exact bytes', async () => {
    const ed = await login(api, ED4);
    const body = new TextEncoder().encode('{"b": 2}');
    for (const path of ['/API/v1/Files', '/api/v1/files/', '/api/v1/files?x=1']) {
      const answer = await upload(api, ed, { body, type: 'application/json', path });
      expect(answer.status, path).toBe(201);
      const stored = await storeOf(api).content((answer.body as { id: string }).id);
      expect(Buffer.from(stored ?? []).toString('utf8'), path).toBe('{"b": 2}');
    }
  });

  it('CS-10 a compressed upload is refused, not decompressed; nothing is stored', async () => {
    const ed = await login(api, ED3);
    const answer = await upload(api, ed, { body: gzipSync(PNG), headers: { 'content-encoding': 'gzip' } });
    expect(answer).toMatchObject({ status: 415, body: { error: 'invalid_body' } });
    expect(await listed(api, ed)).toEqual([]);
  });

  it('AUD-3 CS-10 refused uploads leave no file.staged row', async () => {
    const before = (await auditRows(databaseUrl, `action = 'file.staged'`)).length;
    const ed = await login(api, ED3);
    const vi = await login(api, VI);
    await upload(api, vi, { body: PNG });
    await upload(api, ed, { body: PNG, name: '..' });
    await upload(api, ed, { body: PNG, type: 'png' });
    await upload(api, ed, { body: new Uint8Array() });
    await upload(api, ed, { body: gzipSync(PNG), headers: { 'content-encoding': 'gzip' } });
    const hank = await login(small, HANK);
    expect((await upload(small, hank, { body: new Uint8Array(101) })).status).toBe(413);
    expect((await upload(small, hank, { body: PNG })).status).toBe(201);
    expect((await upload(small, hank, { body: PNG })).status).toBe(409);
    // Only the one stored file has a row.
    expect((await auditRows(databaseUrl, `action = 'file.staged'`)).length - before).toBe(1);
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

interface ToolResult {
  isError?: boolean;
  content: { type: string; text: string }[];
  structuredContent?: Record<string, unknown>;
}

const MED: TestLoginUser = { sub: 'med-id', username: 'med', groups: ['editors'] };
const MED2: TestLoginUser = { sub: 'med2-id', username: 'med2', groups: ['editors'] };
const MVI: TestLoginUser = { sub: 'mvi-id', username: 'mvi', groups: ['viewers'] };

async function callTool(token: string, name: string, args: Record<string, unknown>): Promise<{ result: ToolResult; correlationId: string }> {
  let correlationId = '';
  const client = await connectClient({
    era: 'modern',
    baseUrls: [api.url],
    token,
    onResponse: (r) => {
      correlationId = r.headers.get('x-correlation-id') ?? correlationId;
    },
  });
  try {
    return { result: (await client.callTool({ name, arguments: args })) as unknown as ToolResult, correlationId };
  } finally {
    await client.close();
  }
}

async function toolNames(token: string): Promise<string[]> {
  const client = await connectClient({ era: 'modern', baseUrls: [api.url], token });
  try {
    return (await client.listTools()).tools.map((t) => t.name);
  } finally {
    await client.close();
  }
}

async function query<T extends Record<string, unknown>>(sql: string, params: unknown[] = []): Promise<T[]> {
  const client = new pg.Client({ connectionString: databaseUrl });
  await client.connect();
  try {
    return (await client.query<T>(sql, params)).rows;
  } finally {
    await client.end();
  }
}

const changesetCount = async (): Promise<number> => Number((await query<{ n: string }>('select count(*) as n from change_set'))[0]?.n);
const NOT_FOUND = (pointer: string, base: string): string => `The file at ${pointer} was not found. Upload it at ${base}/app/files and pass its ID.`;

describe('MCP-11 CS-10 a tool call with a file', () => {
  it('MCP-11 tools/list of an editor contains list_staged_files, of a viewer does not, and a viewer call is an unknown tool', async () => {
    const editor = await tokenFor(issuer, api, MED.sub, ['editors']);
    const viewer = await tokenFor(issuer, api, MVI.sub, ['viewers']);
    const tools = (await (async () => {
      const client = await connectClient({ era: 'modern', baseUrls: [api.url], token: editor });
      try {
        return (await client.listTools()).tools;
      } finally {
        await client.close();
      }
    })()).find((t) => t.name === 'list_staged_files');
    expect(tools?.annotations?.readOnlyHint).toBe(true);
    expect(await toolNames(viewer)).not.toContain('list_staged_files');
    // A hidden tool is answered exactly as one that does not exist (MCP-2).
    const message = async (name: string): Promise<string> => {
      const failure = await callTool(viewer, name, {}).then(
        () => undefined,
        (error: unknown) => error,
      );
      return (failure instanceof Error ? failure.message : 'no error').replace(name, 'X');
    };
    expect(await message('list_staged_files')).toBe(await message('no_such_tool_at_all'));
    expect(await message('list_staged_files')).toBe('Tool X not found');
  });

  it('MCP-11 list_staged_files answers the upload URL and only the caller own files', async () => {
    const med = await login(api, MED);
    const other = await login(api, MED2);
    const mine = (await upload(api, med, { body: PNG, name: 'mine.png' })).body as { id: string };
    await upload(api, other, { body: PNG, name: 'theirs-secret.png' });
    const { result } = await callTool(await tokenFor(issuer, api, MED.sub, ['editors']), 'list_staged_files', {});
    expect(result.isError).toBeUndefined();
    const answer = result.structuredContent as { uploadUrl: string; files: { id: string }[] };
    expect(answer.uploadUrl).toBe(`${api.url}/app/files`);
    expect(answer.files.map((f) => f.id)).toEqual([mine.id]);
    expect(text(result)).toContain(`mine.png (${mine.id})`);
    expect(text(result)).not.toContain('theirs-secret');
  });

  it('MCP-11 CS-10 CS-4 a staged file passed by ID prepares a change-set sealing its descriptor under hash version 3', async () => {
    const med = await login(api, MED);
    const staged = (await upload(api, med, { body: PNG, name: 'logo.png' })).body as { id: string; mediaType: string; size: number; sha256: string };
    const token = await tokenFor(issuer, api, MED.sub, ['editors']);
    const { result, correlationId } = await callTool(token, 'shop.upload_image', { image: staged.id });
    expect(result.isError).toBeUndefined();
    const prepared = result.structuredContent?.changeset as { id: string; status: string };
    expect(prepared.status).toBe('prepared');
    const { result: shown } = await callTool(token, 'get_changeset', { changeset_id: prepared.id });
    const shownChangeset = shown.structuredContent?.changeset as { args: Record<string, unknown> };
    expect(shownChangeset.args.image).toEqual({ $file: { id: staged.id, name: 'logo.png', media_type: 'image/png', size: PNG.length, sha256: staged.sha256 } });
    expect((await query<{ hash_version: number }>('select hash_version from change_set where id = $1', [prepared.id]))[0]?.hash_version).toBe(3);
    const row = (await auditRows(databaseUrl, `action = 'tool.call' and correlation_id = $1`, [correlationId]))[0];
    expect(row?.details).toMatchObject({ changesetId: prepared.id });
    expect(JSON.stringify(row)).not.toContain('logo.png');
  });

  it('SEC-1 CS-10 another user file, an unknown ID and a purged file answer file_not_found and create nothing', async () => {
    const med = await login(api, MED);
    const other = await login(api, MED2);
    const theirs = (await upload(api, other, { body: PNG, name: 'theirs-secret.png' })).body as { id: string };
    const purged = (await upload(api, med, { body: PNG, name: 'purged-secret.png' })).body as { id: string };
    const token = await tokenFor(issuer, api, MED.sub, ['editors']);
    // An operator-side purge: the file has no change-set and is older than the TTL.
    await storeOf(api).purge({ now: new Date(Date.now() + 48 * 3_600_000), stagedTtlHours: 24, keepDays: 7, limit: 1000 }, (n) => ({
      id: randomUUID(),
      actor: 'system',
      action: 'files.purged',
      outcome: 'ok',
      correlationId: 'e2e-purge',
      details: { count: n },
    }));
    for (const id of [theirs.id, '99999999-9999-4999-8999-999999999999', purged.id]) {
      const before = await changesetCount();
      const { result, correlationId } = await callTool(token, 'shop.upload_image', { image: id });
      expect(result.isError, id).toBe(true);
      expect(text(result), id).toBe(NOT_FOUND('/image', api.url));
      expect(JSON.stringify(result)).not.toMatch(/secret/);
      expect(await changesetCount()).toBe(before);
      const row = (await auditRows(databaseUrl, `action = 'tool.call' and correlation_id = $1`, [correlationId]))[0];
      expect(row?.details).toMatchObject({ errorCode: 'file_not_found', pointer: '/image' });
      expect(JSON.stringify(row)).not.toMatch(/secret/);
    }
  });

  it('MCP-3 a value that is not a UUID is refused by argument validation, before policy', async () => {
    const token = await tokenFor(issuer, api, MED.sub, ['editors']);
    const before = await changesetCount();
    const { result, correlationId } = await callTool(token, 'shop.upload_image', { image: 'not-a-uuid' });
    expect(result.isError).toBe(true);
    expect(text(result)).toMatch(/^Input validation error: Invalid arguments for tool shop\.upload_image/);
    const rows = await auditRows(databaseUrl, 'correlation_id = $1', [correlationId]);
    expect(rows.map((r) => r.action)).toEqual(['tool.call']);
    expect(rows[0]?.details).toMatchObject({ errorCode: 'invalid_arguments' });
    expect(await changesetCount()).toBe(before);
  });

  it('MCP-11 a configuration with an operation named list_staged_files is refused at load', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'mandate-files-reserved-e2e-'));
    try {
      await cp(FILES_CONFIG, dir, { recursive: true });
      for (const file of ['operations.yaml', 'roles.yaml']) {
        const path = join(dir, file);
        await writeFile(path, (await readFile(path, 'utf8')).replaceAll('shop.post_note', 'list_staged_files'));
      }
      await expect(startApi(databaseUrl, { issuer, configDir: dir })).rejects.toThrow(/is reserved for a built-in tool/);
    } finally {
      await rm(dir, { recursive: true });
    }
  });
});

const LEAD: TestLoginUser = { sub: 'lead-id', username: 'lead', groups: ['leads'] };
const OWN: TestLoginUser = { sub: 'own-id', username: 'own', groups: ['editors'] };
const OTHER: TestLoginUser = { sub: 'other-id', username: 'other', groups: ['editors'] };
const SVG = new TextEncoder().encode('<svg onload=alert(1)>');
const CSV = new TextEncoder().encode('a,b\n1,2\n');

interface Prepared {
  readonly fileId: string;
  readonly changesetId: string;
}

/** Stages `body` as `owner` (a page login), names it in a call and submits, so an approver may see it. */
async function pendingWithFile(owner: Page, options: { body: Uint8Array; name?: string; type?: string }): Promise<Prepared> {
  const staged = (await upload(api, owner, options)).body as { id: string };
  const token = await tokenFor(issuer, api, OWN.sub, ['editors']);
  const { result } = await callTool(token, 'shop.upload_image', { image: staged.id });
  const prepared = result.structuredContent?.changeset as { id: string; hash: string };
  const { result: submitted } = await callTool(token, 'submit_for_approval', { changeset_id: prepared.id, hash: prepared.hash });
  expect(submitted.isError).toBeUndefined();
  return { fileId: staged.id, changesetId: prepared.id };
}

const get = (page: Page, path: string): Promise<Response> => fetch(`${api.url}/api/v1/changesets/${path}`, { headers: { cookie: page.cookie } });
const HARDENING = { 'cache-control': 'no-store', 'x-content-type-options': 'nosniff', 'content-security-policy': "sandbox; default-src 'none'" };
const expectHardened = (response: Response): void => {
  for (const [name, value] of Object.entries(HARDENING)) expect(response.headers.get(name), name).toBe(value);
};

describe('APR-5 UI-7 the files of a change-set', () => {
  // Page logins are rate limited: each identity signs in once.
  let own: Page;
  let lead: Page;
  let stranger: Page;
  beforeAll(async () => {
    own = await login(api, OWN);
    lead = await login(api, LEAD);
    stranger = await login(api, OTHER);
  });

  it('APR-5 UI-7 the requester and an approver get the detail with the file row; anyone else gets 404 on detail, content and preview', async () => {
    const { fileId, changesetId } = await pendingWithFile(own, { body: PNG, name: 'logo.png' });
    const expected = { pointer: '/image', id: fileId, name: 'logo.png', mediaType: 'image/png', size: PNG.length, sha256: sha256Of(PNG), preview: 'image', available: true };
    for (const page of [own, lead]) {
      const detail = await get(page, changesetId);
      expect(detail.status).toBe(200);
      expect(((await detail.json()) as { files: unknown[] }).files).toEqual([expected]);
    }
    for (const path of [changesetId, `${changesetId}/files/${fileId}/content`, `${changesetId}/files/${fileId}/preview`]) {
      const response = await get(stranger, path);
      expect(response.status, path).toBe(404);
      expect(await response.json()).toEqual({ error: 'not_found' });
    }
  });

  it('APR-5 a change-set without files has no files member', async () => {
    const vi = await login(api, VI);
    const token = await tokenFor(issuer, api, VI.sub, ['viewers']);
    const { result } = await callTool(token, 'shop.post_note', { note: 'hello' });
    const prepared = result.structuredContent?.changeset as { id: string };
    const detail = (await (await get(vi, prepared.id)).json()) as Record<string, unknown>;
    expect(detail).not.toHaveProperty('files');
  });

  it('UI-7 content returns the exact bytes as an attachment with the hardening headers; a quote in the name is escaped', async () => {
    const { fileId, changesetId } = await pendingWithFile(own, { body: PNG, name: encodeURIComponent('a"b.png') });
    const response = await get(lead, `${changesetId}/files/${fileId}/content`);
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toBe('application/octet-stream');
    expect(response.headers.get('content-length')).toBe(String(PNG.length));
    const disposition = response.headers.get('content-disposition') ?? '';
    expect(disposition).toBe("attachment; filename*=UTF-8''a%22b.png");
    expect(disposition.slice(0, disposition.indexOf('filename'))).not.toContain('"');
    expect(disposition).not.toContain('"');
    expectHardened(response);
    expect(new Uint8Array(await response.arrayBuffer())).toEqual(PNG);
  });

  it('UI-7 preview of a PNG is the bytes as image/png; of a CSV is its text; of 70000 bytes is cut at 65536', async () => {
    const png = await pendingWithFile(own, { body: PNG, name: 'a.png' });
    const image = await get(lead, `${png.changesetId}/files/${png.fileId}/preview`);
    expect(image.status).toBe(200);
    expect(image.headers.get('content-type')).toBe('image/png');
    expectHardened(image);
    expect(new Uint8Array(await image.arrayBuffer())).toEqual(PNG);

    const csv = await pendingWithFile(own, { body: CSV, name: 'a.csv', type: 'text/csv' });
    const text = await get(lead, `${csv.changesetId}/files/${csv.fileId}/preview`);
    expect(text.status).toBe(200);
    expectHardened(text);
    expect(await text.json()).toEqual({ text: 'a,b\n1,2\n', truncated: false });

    const big = await pendingWithFile(own, { body: new TextEncoder().encode('x'.repeat(70_000)), name: 'big.txt', type: 'text/plain' });
    const cut = (await (await get(lead, `${big.changesetId}/files/${big.fileId}/preview`)).json()) as { text: string; truncated: boolean };
    expect(cut.truncated).toBe(true);
    expect(cut.text.length).toBe(65_536);
  });

  it('UI-7 SEC-3 an SVG uploaded as image/png has no preview and downloads only as an attachment', async () => {
    const { fileId, changesetId } = await pendingWithFile(own, { body: SVG, name: 'evil.png' });
    const row = ((await (await get(lead, changesetId)).json()) as { files: { preview: string }[] }).files[0];
    expect(row?.preview).toBe('none');
    const preview = await get(lead, `${changesetId}/files/${fileId}/preview`);
    expect(preview.status).toBe(404);
    expect(await preview.json()).toEqual({ error: 'no_preview' });
    expectHardened(preview);
    const content = await get(lead, `${changesetId}/files/${fileId}/content`);
    expect(content.status).toBe(200);
    expect(content.headers.get('content-type')).toBe('application/octet-stream');
    expect(content.headers.get('content-disposition')).toMatch(/^attachment;/);
    expectHardened(content);
  });

  it('UI-7 a file not linked to this change-set, and a malformed file ID, are 404; a purged file is 410 and reads available: false', async () => {
    const first = await pendingWithFile(own, { body: PNG, name: 'first.png' });
    const second = await pendingWithFile(own, { body: PNG, name: 'second.png' });
    for (const path of [`${first.changesetId}/files/${second.fileId}/content`, `${first.changesetId}/files/x/content`, `${first.changesetId}/files/x/preview`, `${first.changesetId}/files/${second.fileId}/preview`]) {
      const response = await get(lead, path);
      expect(response.status, path).toBe(404);
      expect(await response.json()).toEqual({ error: 'not_found' });
    }
    // A linked file purges only once its change-set is final; the test applies what the purge does (content NULL, purged_at set).
    await query('update staged_file set content = null, purged_at = now() where id = $1', [first.fileId]);
    for (const route of ['content', 'preview']) {
      const response = await get(lead, `${first.changesetId}/files/${first.fileId}/${route}`);
      expect(response.status, route).toBe(410);
      expect(await response.json()).toEqual({ error: 'purged' });
      expectHardened(response);
    }
    const row = ((await (await get(lead, first.changesetId)).json()) as { files: { available: boolean }[] }).files[0];
    expect(row?.available).toBe(false);
  });

  it('APR-5 SEC-3 get_changeset carries the file row and not one byte of content', async () => {
    const body = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x11, 0x22, 0x33, 0x44]);
    const { fileId, changesetId } = await pendingWithFile(own, { body, name: 'bytes.png' });
    const { result } = await callTool(await tokenFor(issuer, api, OWN.sub, ['editors']), 'get_changeset', { changeset_id: changesetId });
    expect(result.structuredContent?.files).toEqual([{ pointer: '/image', id: fileId, name: 'bytes.png', mediaType: 'image/png', size: body.length, sha256: sha256Of(body), preview: 'image', available: true }]);
    const serialised = JSON.stringify(result);
    expect(serialised).not.toContain(Buffer.from(body).toString('base64'));
    expect(serialised).not.toContain(Buffer.from(body).toString('hex'));
  });
});
