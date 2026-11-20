import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { CODE_FIXTURE_PRESET_DIR, installFakeItems } from './fake-items.js';
import { startFakeUpstream, type FakeUpstream } from './fake-upstream.js';

const SEED = [
  { id: 'a1', title: 'Alpha', state: 'open' as const, tags: [] },
  { id: 'b2', title: 'Beta', state: 'closed' as const, tags: ['x'] },
  { id: 'c3', title: 'Gamma', state: 'open' as const, tags: [] },
];

let fake: FakeUpstream | undefined;
afterEach(async () => {
  await fake?.close();
  fake = undefined;
});

async function call(method: string, path: string, body?: unknown, auth = true): Promise<{ status: number; json: unknown }> {
  if (fake === undefined) throw new Error('fake upstream not started');
  const headers: Record<string, string> = auth ? { authorization: 'Bearer test-token' } : {};
  if (body !== undefined) headers['content-type'] = 'application/json';
  const res = await fetch(`${fake.url}${path}`, { method, headers, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  const text = await res.text();
  return { status: res.status, json: text === '' ? undefined : (JSON.parse(text) as unknown) };
}

describe('OPS-5 OPS-6 fake items upstream', () => {
  it('fake items serve, patch, tag and inject failures', async () => {
    fake = await startFakeUpstream();
    const items = installFakeItems(fake, SEED);

    // Every route requires a bearer token.
    expect((await call('GET', '/items', undefined, false)).status).toBe(401);
    expect((await call('POST', '/ping', { message: 'hi' }, false)).status).toBe(401);

    // GET /items: bare array, filtered by state, paged by page and limit.
    expect((await call('GET', '/items')).json).toEqual(SEED);
    expect((await call('GET', '/items?state=open')).json).toEqual([SEED[0], SEED[2]]);
    expect((await call('GET', '/items?page=2&limit=2')).json).toEqual([SEED[2]]);
    expect((await call('GET', '/items?page=3&limit=2')).json).toEqual([]);

    // GET /items/{id}: one item or 404.
    expect(await call('GET', '/items/b2')).toEqual({ status: 200, json: SEED[1] });
    expect((await call('GET', '/items/zz')).status).toBe(404);

    // PATCH takes title and state only.
    expect(await call('PATCH', '/items/a1', { title: 'Alpha 2', state: 'closed' })).toEqual({
      status: 200,
      json: { id: 'a1', title: 'Alpha 2', state: 'closed', tags: [] },
    });
    expect(items.items.get('a1')?.title).toBe('Alpha 2');
    expect((await call('PATCH', '/items/a1', { tags: ['y'] })).status).toBe(400);
    expect((await call('PATCH', '/items/a1', { state: 'gone' })).status).toBe(400);
    expect((await call('PATCH', '/items/a1', ['title'])).status).toBe(400);
    expect((await call('PATCH', '/items/zz', { title: 'Z' })).status).toBe(404);

    // PUT tags replaces them; the tag `unknown` is refused.
    expect(await call('PUT', '/items/c3/tags', { tags: ['red', 'blue'] })).toEqual({ status: 200, json: { tags: ['red', 'blue'] } });
    expect(items.items.get('c3')?.tags).toEqual(['red', 'blue']);
    expect((await call('PUT', '/items/c3/tags', { tags: ['unknown'] })).status).toBe(400);
    expect(items.items.get('c3')?.tags).toEqual(['red', 'blue']);

    // POST /ping accepts.
    expect((await call('POST', '/ping', { message: 'hi' })).status).toBe(200);

    // Injected failures answer the status for the next `count` matching requests only.
    items.failNext('PATCH', '/items/b2', 503, 2);
    expect((await call('PATCH', '/items/b2', { title: 'B' })).status).toBe(503);
    expect((await call('PATCH', '/items/b2', { title: 'B' })).status).toBe(503);
    expect((await call('PATCH', '/items/b2', { title: 'B' })).status).toBe(200);
    items.failNext('POST', '/ping', 500);
    expect((await call('POST', '/ping', { message: 'hi' })).status).toBe(500);
    expect((await call('POST', '/ping', { message: 'hi' })).status).toBe(200);
    expect(items.requestsTo('PATCH', '/items/b2')).toBe(3);
    expect(items.requestsTo('POST', '/ping')).toBe(4);
  });

  it('CONN-8 CODE_FIXTURE_PRESET_DIR is the code fixture package', async () => {
    const pkg = JSON.parse(await readFile(join(CODE_FIXTURE_PRESET_DIR, 'package.json'), 'utf8')) as { name: string; aiops: { code: string } };
    expect(pkg.name).toBe('@aiops/code-fixture-preset');
    expect(pkg.aiops.code).toBe('lib/index.js');
  });
});
