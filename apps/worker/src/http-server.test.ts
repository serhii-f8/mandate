// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Mandate Authors
import { request } from 'node:http';
import type { ReadinessReport } from '@mandate/config';
import { afterEach, describe, expect, it } from 'vitest';
import { startWorkerHttpServer, type WorkerHttpDeps } from './http-server.js';

const READY: ReadinessReport = { database: 'ok', configuration: { revision: 'r1', hash: 'a'.repeat(64) }, temporal: 'ok' };

interface Reply {
  readonly status: number;
  readonly headers: Record<string, string | string[] | undefined>;
  readonly body: string;
}

/** A raw request, so the path is sent exactly as written (no URL normalisation). */
function send(port: number, method: string, path: string, body?: string): Promise<Reply> {
  return new Promise((resolve, reject) => {
    const req = request({ host: '127.0.0.1', port, method, path, agent: false }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (c: Buffer) => chunks.push(c));
      res.on('end', () => {
        resolve({ status: res.statusCode ?? 0, headers: res.headers, body: Buffer.concat(chunks).toString('utf8') });
      });
      res.on('error', reject);
    });
    req.on('error', reject);
    req.end(body);
  });
}

const open: { close(): Promise<void> }[] = [];

afterEach(async () => {
  await Promise.all(open.splice(0).map((s) => s.close()));
});

async function serve(deps: Partial<WorkerHttpDeps> = {}): Promise<number> {
  const server = await startWorkerHttpServer(0, '127.0.0.1', {
    readiness: deps.readiness ?? (() => Promise.resolve(READY)),
    metrics:
      deps.metrics ??
      ((_req, res) => {
        res.statusCode = 200;
        res.end('# metrics\n');
      }),
  });
  open.push(server);
  expect(server.port).toBeGreaterThan(0);
  return server.port;
}

describe('NFR-10 NFR-12 worker HTTP server', () => {
  it('NFR-10 /healthz answers 200 while running and reports the product version', async () => {
    const port = await serve();
    const reply = await send(port, 'GET', '/healthz');
    expect(reply.status).toBe(200);
    expect(JSON.parse(reply.body)).toEqual({ ok: true, version: '1.1.0' });
  });

  it('NFR-10 /readyz is 200 only with database, configuration and a running worker', async () => {
    const cases: readonly [ReadinessReport, number][] = [
      [READY, 200],
      [{ ...READY, database: 'unavailable' }, 503],
      [{ ...READY, configuration: 'none' }, 503],
      [{ ...READY, configuration: 'configuration_mismatch' }, 503],
      [{ ...READY, temporal: 'unavailable' }, 503],
    ];
    for (const [report, status] of cases) {
      const port = await serve({ readiness: () => Promise.resolve(report) });
      const reply = await send(port, 'GET', '/readyz');
      expect(reply.status, JSON.stringify(report)).toBe(status);
      expect(JSON.parse(reply.body)).toEqual(report);
      expect(reply.headers['cache-control']).toBe('no-store');
      expect(reply.headers['content-type']).toMatch(/^application\/json/);
    }
  });

  it('NFR-12 /metrics is served by the metrics handler', async () => {
    const port = await serve({
      metrics: (_req, res) => {
        res.statusCode = 200;
        res.setHeader('content-type', 'text/plain');
        res.end('mandate_changesets{status="prepared"} 0\n');
      },
    });
    const reply = await send(port, 'GET', '/metrics');
    expect(reply.status).toBe(200);
    expect(reply.body).toBe('mandate_changesets{status="prepared"} 0\n');
  });

  it('NFR-10 other paths 404 and other methods 405 without echoing the request', async () => {
    const port = await serve();
    for (const path of ['/readyz?x=<script>', '/readyz/', '/READYZ', '/healthz/<script>', '/', '/metrics/../readyz', '//readyz']) {
      const reply = await send(port, 'GET', path);
      expect(reply.status, path).toBe(404);
      expect(reply.body, path).not.toContain('<script>');
      expect(reply.body, path).not.toContain('readyz');
    }
    for (const method of ['POST', 'PUT', 'DELETE', 'HEAD']) {
      const reply = await send(port, method, '/healthz', method === 'HEAD' ? undefined : '<script>alert(1)</script>');
      expect(reply.status, method).toBe(405);
      expect(reply.headers.allow).toBe('GET');
      expect(reply.body, method).not.toContain('<script>');
    }
    const unknown = await send(port, 'POST', '/nowhere?q=<script>', '<script>');
    expect(unknown.status).toBe(405);
    expect(unknown.body).not.toContain('<script>');
  });

  it('NFR-10 a throwing readiness probe answers 503, not a crash', async () => {
    const port = await serve({ readiness: () => Promise.reject(new Error('probe exploded: secret-detail')) });
    const reply = await send(port, 'GET', '/readyz');
    expect(reply.status).toBe(503);
    expect(reply.headers['cache-control']).toBe('no-store');
    // Fail closed, in the readiness body's shape (Global Constraints).
    expect(JSON.parse(reply.body)).toEqual({ database: 'unavailable', configuration: 'none', temporal: 'unavailable' });
    expect(reply.body).not.toContain('secret-detail');
    // The server keeps answering.
    expect((await send(port, 'GET', '/healthz')).status).toBe(200);
  });
});
