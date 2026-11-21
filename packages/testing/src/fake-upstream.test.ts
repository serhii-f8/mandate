// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The AI Operations Layer Authors
import { request } from 'node:http';
import { afterEach, describe, expect, it } from 'vitest';
import { startFakeUpstream, type FakeUpstream } from './fake-upstream.js';

function call(url: string, method = 'GET', body?: string, headers: Record<string, string> = {}): Promise<{ status: number; headers: Record<string, string | string[] | undefined>; body: string }> {
  return new Promise((resolve, reject) => {
    const req = request(url, { method, headers }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (c: Buffer) => chunks.push(c));
      res.on('end', () => {
        resolve({ status: res.statusCode ?? 0, headers: res.headers, body: Buffer.concat(chunks).toString('utf8') });
      });
      res.on('error', reject);
    });
    req.on('error', reject);
    if (body !== undefined) req.write(body);
    req.end();
  });
}

describe('fake upstream', () => {
  let up: FakeUpstream | undefined;
  afterEach(async () => {
    await up?.close();
    up = undefined;
  });

  it('NFR-1 listens on the given host and port when options are passed', async () => {
    up = await startFakeUpstream({ host: '0.0.0.0', port: 0 });
    expect(up.port).toBeGreaterThan(0);
    expect(up.url).toBe(`http://127.0.0.1:${up.port}`);
    up.route('GET', '/x', () => ({ status: 200, body: 'ok' }));
    expect((await call(`${up.url}/x`)).body).toBe('ok');
  });

  it('listens on 127.0.0.1 with a random port', async () => {
    up = await startFakeUpstream();
    expect(up.port).toBeGreaterThan(0);
    expect(up.url).toBe(`http://127.0.0.1:${up.port}`);
  });

  it('answers unrouted requests with 404 JSON and records them', async () => {
    up = await startFakeUpstream();
    const r = await call(`${up.url}/nothing?x=1`);
    expect(r.status).toBe(404);
    expect(r.headers['content-type']).toMatch(/application\/json/);
    expect(JSON.parse(r.body)).toEqual({ error: 'not found' });
    expect(up.requests).toHaveLength(1);
    expect(up.requests[0]?.path).toBe('/nothing');
    expect(up.requests[0]?.query.get('x')).toBe('1');
  });

  it('routes by method and path, records headers and body, and serialises JSON bodies', async () => {
    up = await startFakeUpstream();
    up.route('POST', '/items', (req) => ({ status: 201, headers: { 'x-echo': req.headers['x-in'] ?? '' }, body: { got: req.body } }));
    const r = await call(`${up.url}/items`, 'POST', 'hello', { 'X-In': 'abc' });
    expect(r.status).toBe(201);
    expect(r.headers['x-echo']).toBe('abc');
    expect(JSON.parse(r.body)).toEqual({ got: 'hello' });
    expect(up.requests[0]).toMatchObject({ method: 'POST', path: '/items', body: 'hello' });
    expect(up.requests[0]?.headers['x-in']).toBe('abc');
  });

  it('sends string bodies verbatim and honours delayMs', async () => {
    up = await startFakeUpstream();
    up.route('GET', '/raw', () => ({ status: 200, headers: { 'content-type': 'text/plain' }, body: 'plain', delayMs: 50 }));
    const t0 = Date.now();
    const r = await call(`${up.url}/raw`);
    expect(Date.now() - t0).toBeGreaterThanOrEqual(45);
    expect(r.body).toBe('plain');
    expect(r.headers['content-type']).toBe('text/plain');
  });

  it('tracks the highest number of requests in flight', async () => {
    up = await startFakeUpstream();
    up.route('GET', '/slow', () => ({ status: 200, body: {}, delayMs: 50 }));
    await Promise.all([call(`${up.url}/slow`), call(`${up.url}/slow`)]);
    expect(up.maxInFlight).toBe(2);
  });
});
