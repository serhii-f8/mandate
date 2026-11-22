// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Mandate Authors
import { createServer, request, type IncomingHttpHeaders, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { startTokenProxy } from './token-proxy.ts';

interface Seen {
  method: string | undefined;
  url: string | undefined;
  headers: IncomingHttpHeaders;
  body: string;
}

const TOKEN = 'tok-secret-0123456789';
const cleanup: (() => Promise<void>)[] = [];

afterEach(async () => {
  vi.restoreAllMocks();
  while (cleanup.length > 0) await cleanup.pop()?.();
});

function listen(server: Server): Promise<string> {
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      cleanup.push(
        () =>
          new Promise<void>((done) => {
            server.closeAllConnections();
            server.close(() => { done(); });
          }),
      );
      resolve(`http://127.0.0.1:${String((server.address() as AddressInfo).port)}`);
    });
  });
}

async function echoUpstream(): Promise<{ url: string; seen: Seen[] }> {
  const seen: Seen[] = [];
  const server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      const body = Buffer.concat(chunks).toString('utf8');
      seen.push({ method: req.method, url: req.url, headers: req.headers, body });
      if (req.url === '/stream') {
        res.writeHead(200, { 'content-type': 'text/event-stream', 'x-upstream': 'yes' });
        res.write('data: one\n\n');
        setTimeout(() => res.end('data: two\n\n'), 20);
        return;
      }
      res.writeHead(201, { 'content-type': 'application/json', 'x-upstream': 'yes' });
      res.end(JSON.stringify({ echoed: body }));
    });
  });
  return { url: await listen(server), seen };
}

async function proxyFor(target: string): Promise<string> {
  const proxy = await startTokenProxy({ target, token: TOKEN });
  cleanup.push(() => proxy.close());
  return proxy.url;
}

function send(
  url: string,
  opts: { method?: string; path: string; headers?: Record<string, string>; body?: string },
): Promise<{ status: number; headers: IncomingHttpHeaders; body: string }> {
  return new Promise((resolve, reject) => {
    const req = request(url + opts.path, { method: opts.method ?? 'GET', headers: opts.headers }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (c: Buffer) => chunks.push(c));
      res.on('end', () => { resolve({ status: res.statusCode ?? 0, headers: res.headers, body: Buffer.concat(chunks).toString('utf8') }); });
    });
    req.on('error', reject);
    req.end(opts.body);
  });
}

describe('NFR-16 token proxy', () => {
  it('adds the bearer token and replaces an incoming one', async () => {
    const up = await echoUpstream();
    const url = await proxyFor(up.url);
    await send(url, { path: '/a' });
    await send(url, { path: '/b', headers: { authorization: 'Bearer client-supplied' } });
    expect(up.seen.map((s) => s.headers.authorization)).toEqual([`Bearer ${TOKEN}`, `Bearer ${TOKEN}`]);
  });

  it('passes Host and Origin unchanged', async () => {
    const up = await echoUpstream();
    const url = await proxyFor(up.url);
    await send(url, { path: '/', headers: { host: 'mcp.example.test', origin: 'https://client.example.test' } });
    expect(up.seen[0]?.headers.host).toBe('mcp.example.test');
    expect(up.seen[0]?.headers.origin).toBe('https://client.example.test');
  });

  it('forwards method, path and body, and returns status, headers and body unchanged', async () => {
    const up = await echoUpstream();
    const url = await proxyFor(up.url);
    const res = await send(url, { method: 'POST', path: '/mcp?x=1', headers: { 'content-type': 'application/json' }, body: '{"a":1}' });
    expect(up.seen[0]).toMatchObject({ method: 'POST', url: '/mcp?x=1', body: '{"a":1}' });
    expect(res.status).toBe(201);
    expect(res.headers['x-upstream']).toBe('yes');
    expect(JSON.parse(res.body)).toEqual({ echoed: '{"a":1}' });
  });

  it('returns a streamed text/event-stream response unchanged', async () => {
    const up = await echoUpstream();
    const url = await proxyFor(up.url);
    const res = await send(url, { path: '/stream' });
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toBe('text/event-stream');
    expect(res.body).toBe('data: one\n\ndata: two\n\n');
  });

  it('destroys the upstream request when the client closes', async () => {
    let upstreamClosed!: () => void;
    const closed = new Promise<void>((r) => (upstreamClosed = r));
    const server = createServer((req, res) => {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.write(': open\n\n');
      res.on('close', upstreamClosed);
      req.resume();
    });
    const url = await proxyFor(await listen(server));
    await new Promise<void>((resolve, reject) => {
      const req = request(url + '/sse', (res) => {
        res.once('data', () => {
          req.destroy();
          resolve();
        });
      });
      req.on('error', () => undefined);
      req.on('error', reject);
      req.end();
    }).catch(() => undefined);
    await closed;
  });

  it('never writes the token to stdout or stderr', async () => {
    const out = vi.spyOn(process.stdout, 'write');
    const err = vi.spyOn(process.stderr, 'write');
    const up = await echoUpstream();
    const url = await proxyFor(up.url);
    await send(url, { path: '/a' });
    await send(url, { path: '/stream' });
    const dead = await startTokenProxy({ target: 'http://127.0.0.1:1', token: TOKEN });
    cleanup.push(() => dead.close());
    await send(dead.url, { path: '/a' });
    const written = [...out.mock.calls, ...err.mock.calls].map((c) => String(c[0])).join('');
    expect(written).not.toContain(TOKEN);
  });
});
