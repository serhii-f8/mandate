import { Writable } from 'node:stream';
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
