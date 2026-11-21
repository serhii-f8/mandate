// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The AI Operations Layer Authors
import { createHash } from 'node:crypto';
import { Writable } from 'node:stream';
import { pino } from 'pino';
import { describe, expect, it } from 'vitest';
import { DEFAULT_RATE_LIMITS } from '@aiops/config';
import type { RateCounter } from '@aiops/core';
import { InMemoryAuditLog, InMemoryRateCounter } from '@aiops/testing';
import { EndpointRateLimiter, mcpLimitCheck, retryAfterSeconds, type LimitCheck } from './rate-limiter.js';

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

function setup(rateCounter: RateCounter = new InMemoryRateCounter()) {
  const audit = new InMemoryAuditLog();
  const { lines, stream } = capture();
  let now = new Date('2026-11-20T12:00:30.000Z');
  const limiter = new EndpointRateLimiter({ rateCounter, audit, wallClock: () => now, logger: pino(stream) });
  return {
    audit,
    lines,
    limiter,
    advance: (ms: number) => {
      now = new Date(now.getTime() + ms);
    },
  };
}

const CHECK: LimitCheck = { key: 'mcp:user:alice', limit: 3, scope: 'mcp' };
const CTX = { actor: 'alice', clientId: 'client-a', correlationId: 'corr-1' };

describe('SEC-10 EndpointRateLimiter', () => {
  it('SEC-10 allows up to the limit and refuses limit + 1', async () => {
    const { limiter } = setup();
    for (let i = 0; i < 3; i += 1) expect(await limiter.check(CHECK, CTX)).toEqual({ allowed: true });
    expect(await limiter.check(CHECK, CTX)).toEqual({ allowed: false, retryAfterSeconds: 30 });
  });

  it('SEC-10 AUD-1 writes one rate.limited row for the first refusal of a window and none after', async () => {
    const { limiter, audit } = setup();
    for (let i = 0; i < 3; i += 1) await limiter.check(CHECK, CTX);
    for (let i = 0; i < 5; i += 1) expect((await limiter.check(CHECK, CTX)).allowed).toBe(false);
    const rows = audit.events.filter((e) => e.action === 'rate.limited');
    expect(rows).toHaveLength(1);
    expect(audit.events).toHaveLength(1);
    expect(rows[0]).toMatchObject({ actor: 'alice', clientId: 'client-a', outcome: 'denied', correlationId: 'corr-1' });
    expect(rows[0]?.details).toEqual({ scope: 'mcp', limit: 3 });
  });

  it('SEC-10 a new window allows again', async () => {
    const { limiter, advance } = setup();
    for (let i = 0; i < 4; i += 1) await limiter.check(CHECK, CTX);
    advance(60_000);
    expect(await limiter.check(CHECK, CTX)).toEqual({ allowed: true });
  });

  it('SEC-10 keeps separate budgets per key', async () => {
    const { limiter } = setup();
    for (let i = 0; i < 4; i += 1) await limiter.check(CHECK, CTX);
    expect(await limiter.check({ ...CHECK, key: 'mcp:user:bob' }, CTX)).toEqual({ allowed: true });
  });

  it('SEC-10 retryAfterSeconds is the ceiling of the seconds to the next UTC minute, at least 1', () => {
    expect(retryAfterSeconds(new Date('2026-11-20T12:00:00.000Z'))).toBe(60);
    expect(retryAfterSeconds(new Date('2026-11-20T12:00:59.000Z'))).toBe(1);
    expect(retryAfterSeconds(new Date('2026-11-20T12:00:59.999Z'))).toBe(1);
    expect(retryAfterSeconds(new Date('2026-11-20T12:00:30.500Z'))).toBe(30);
  });

  it('SEC-10 fails closed when the counter throws', async () => {
    const failing: RateCounter = { hit: () => Promise.reject(new Error('connection to db-secret-host refused')) };
    const { limiter, lines, audit } = setup(failing);
    expect(await limiter.check(CHECK, CTX)).toEqual({ allowed: false, unavailable: true });
    const out = lines.join('');
    expect(out).toContain('rate limit check failed');
    expect(out).not.toContain('mcp:user:alice');
    expect(out).not.toContain('db-secret-host');
    expect(audit.events).toHaveLength(0);
  });

  it('SEC-10 an audit failure still refuses', async () => {
    const { limiter, audit, lines } = setup();
    for (let i = 0; i < 3; i += 1) await limiter.check(CHECK, CTX);
    audit.failNext = new Error('audit store down at db-secret-host');
    expect(await limiter.check(CHECK, CTX)).toEqual({ allowed: false, retryAfterSeconds: 30 });
    const out = lines.join('');
    expect(out).toContain('rate.limited audit failed');
    expect(out).not.toContain('db-secret-host');
    expect(out).not.toContain('mcp:user:alice');
  });
});

describe('SEC-10 mcpLimitCheck keys and limits', () => {
  const configuration = {
    rateLimits: { ...DEFAULT_RATE_LIMITS, mcpUserPerMinute: 7, mcpServiceAccountPerMinute: 11 },
    serviceAccounts: new Map<string, { role: string; rateLimitPerMinute?: number }>([
      ['svc-plain', { role: 'reader' }],
      ['svc-fast', { role: 'reader', rateLimitPerMinute: 99 }],
    ]),
  };

  it('SEC-10 keys a user by subject with the user limit', () => {
    expect(mcpLimitCheck('alice', configuration)).toEqual({ key: 'mcp:user:alice', limit: 7, scope: 'mcp' });
  });

  it('SEC-10 keys a service account by client ID with the service-account limit or its override', () => {
    expect(mcpLimitCheck('service:svc-plain', configuration)).toEqual({ key: 'mcp:sa:svc-plain', limit: 11, scope: 'mcp' });
    expect(mcpLimitCheck('service:svc-fast', configuration)).toEqual({ key: 'mcp:sa:svc-fast', limit: 99, scope: 'mcp' });
    expect(mcpLimitCheck('service:svc-unknown', configuration)).toEqual({ key: 'mcp:sa:svc-unknown', limit: 11, scope: 'mcp' });
  });

  it('SEC-10 hashes a subject over 200 characters or with a control character', () => {
    const long = 'a'.repeat(201);
    const sha = (s: string) => createHash('sha256').update(s, 'utf8').digest('hex');
    expect(mcpLimitCheck('a'.repeat(200), configuration).key).toBe(`mcp:user:${'a'.repeat(200)}`);
    expect(mcpLimitCheck(long, configuration)).toEqual({ key: `mcp:user:sha256:${sha(long)}`, limit: 7, scope: 'mcp' });
    expect(mcpLimitCheck('ali\nce', configuration).key).toBe(`mcp:user:sha256:${sha('ali\nce')}`);
    expect(mcpLimitCheck('ali\u007fce', configuration).key).toBe(`mcp:user:sha256:${sha('ali\u007fce')}`);
    const longClient = `service:${'s'.repeat(250)}`;
    expect(mcpLimitCheck(longClient, configuration).key).toBe(`mcp:sa:sha256:${sha('s'.repeat(250))}`);
  });
});
