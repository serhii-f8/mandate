// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Mandate Authors
import { Writable } from 'node:stream';
import { NodeTracerProvider } from '@opentelemetry/sdk-trace-node';
import { describe, expect, it } from 'vitest';
import { createLogger } from './logger.js';

function capture(): { lines: string[]; stream: Writable } {
  const lines: string[] = [];
  const stream = new Writable({
    write(chunk: Buffer, _encoding, done) {
      lines.push(chunk.toString('utf8'));
      done();
    },
  });
  return { lines, stream };
}

describe('SEC-3 the api logger redacts credential-bearing paths', () => {
  it('SEC-3 censors authorization, cookies and secret fields', () => {
    const { lines, stream } = capture();
    const logger = createLogger('info', stream);
    logger.info(
      {
        req: { headers: { authorization: 'Bearer tok-SECRET-1', cookie: 'sid=SECRET-2' } },
        res: { headers: { 'set-cookie': 'sid=SECRET-3' } },
        upstream: { password: 'SECRET-4', secret: 'SECRET-5', token: 'SECRET-6', client_secret: 'SECRET-7', authorization: 'SECRET-8' },
      },
      'request',
    );
    const out = lines.join('');
    expect(out).not.toMatch(/SECRET-\d/);
    const parsed = JSON.parse(out) as { req: { headers: Record<string, string> }; res: { headers: Record<string, string> }; upstream: Record<string, string> };
    expect(parsed.req.headers.authorization).toBe('[REDACTED]');
    expect(parsed.res.headers['set-cookie']).toBe('[REDACTED]');
    expect(parsed.upstream.client_secret).toBe('[REDACTED]');
  });
});

describe('SEC-3 the api logger redacts sensitive keys at the root of a record', () => {
  it('SEC-3 censors root-level and two-level-deep secret fields', () => {
    const { lines, stream } = capture();
    const logger = createLogger('info', stream);
    logger.info(
      {
        token: 'SECRET-1', password: 'SECRET-2', secret: 'SECRET-3', client_secret: 'SECRET-4', authorization: 'SECRET-5',
        access_token: 'SECRET-6', refresh_token: 'SECRET-7', id_token: 'SECRET-8',
        upstream: { access_token: 'SECRET-9', refresh_token: 'SECRET-10', id_token: 'SECRET-11' },
        call: { upstream: { token: 'SECRET-12', password: 'SECRET-13' } },
      },
      'request',
    );
    const out = lines.join('');
    expect(out).not.toMatch(/SECRET-\d/);
    const parsed = JSON.parse(out) as Record<string, unknown>;
    expect(parsed.token).toBe('[REDACTED]');
    expect(parsed.password).toBe('[REDACTED]');
  });
});

describe('NFR-11 log correlation', () => {
  it('NFR-11 log lines inside a span carry trace_id and span_id, lines outside carry neither', async () => {
    const provider = new NodeTracerProvider();
    provider.register();
    try {
      const { lines, stream } = capture();
      const logger = createLogger('info', stream);
      logger.info('outside');
      const tracer = provider.getTracer('test');
      tracer.startActiveSpan('work', (span) => {
        logger.info('inside');
        const ctx = span.spanContext();
        const inside = JSON.parse(lines[1] ?? '{}') as Record<string, unknown>;
        expect(inside.trace_id).toBe(ctx.traceId);
        expect(inside.span_id).toBe(ctx.spanId);
        span.end();
      });
      const outside = JSON.parse(lines[0] ?? '{}') as Record<string, unknown>;
      expect(outside).not.toHaveProperty('trace_id');
      expect(outside).not.toHaveProperty('span_id');
    } finally {
      await provider.shutdown();
    }
  });
});
