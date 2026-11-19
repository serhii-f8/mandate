import { Writable } from 'node:stream';
import { context, propagation, trace } from '@opentelemetry/api';
import { NodeTracerProvider } from '@opentelemetry/sdk-trace-node';
import { describe, expect, it } from 'vitest';
import { createWorkerLogger } from './logger.js';

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

const parse = (line: string | undefined): Record<string, unknown> => JSON.parse(line ?? '{}') as Record<string, unknown>;

describe('SEC-3 NFR-11 worker logger', () => {
  it('SEC-3 the worker logger redacts the shared paths', () => {
    const { lines, stream } = capture();
    const logger = createWorkerLogger('info', stream);
    // `*.x` paths match one level below the root (packages/config log-redaction.ts).
    logger.info({ upstream: { token: 'SECRET-1', password: 'SECRET-2' }, req: { headers: { authorization: 'Bearer SECRET-3' } } }, 'probe');
    const out = lines.join('');
    expect(out).not.toMatch(/SECRET-\d/);
    const line = parse(lines[0]) as { service: string; upstream: { token: string; password: string } };
    expect(line.upstream.token).toBe('[REDACTED]');
    expect(line.upstream.password).toBe('[REDACTED]');
    expect(line.service).toBe('worker');
  });

  it('SEC-3 the worker logger redacts sensitive keys at the root and two levels down', () => {
    const { lines, stream } = capture();
    const logger = createWorkerLogger('info', stream);
    logger.info(
      {
        token: 'SECRET-1', password: 'SECRET-2', secret: 'SECRET-3', client_secret: 'SECRET-4', authorization: 'SECRET-5',
        access_token: 'SECRET-6', refresh_token: 'SECRET-7', id_token: 'SECRET-8',
        upstream: { access_token: 'SECRET-9', refresh_token: 'SECRET-10', id_token: 'SECRET-11' },
        call: { upstream: { token: 'SECRET-12', password: 'SECRET-13' } },
      },
      'probe',
    );
    expect(lines.join('')).not.toMatch(/SECRET-\d/);
    const line = parse(lines[0]);
    expect(line.token).toBe('[REDACTED]');
    expect(line.password).toBe('[REDACTED]');
  });

  it('NFR-11 worker log lines inside a span carry trace_id and span_id', async () => {
    const provider = new NodeTracerProvider();
    provider.register();
    try {
      const { lines, stream } = capture();
      const logger = createWorkerLogger('info', stream);
      logger.info('outside');
      provider.getTracer('test').startActiveSpan('work', (span) => {
        logger.info('inside');
        const inside = parse(lines[1]);
        expect(inside.trace_id).toBe(span.spanContext().traceId);
        expect(inside.span_id).toBe(span.spanContext().spanId);
        span.end();
      });
      const outside = parse(lines[0]);
      expect(outside).not.toHaveProperty('trace_id');
      expect(outside).not.toHaveProperty('span_id');
    } finally {
      await provider.shutdown();
      trace.disable();
      context.disable();
      propagation.disable();
    }
  });
});
