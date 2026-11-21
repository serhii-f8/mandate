// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The AI Operations Layer Authors
import 'reflect-metadata';
import type { Request, Response } from 'express';
import pino from 'pino';
import { describe, expect, it } from 'vitest';
import type { ApiEnv, ConfigurationHolder } from '@aiops/config';
import type { AuditEventInput, AuditLog } from '@aiops/core';
import type { SessionRow } from '@aiops/db';
import type { EndpointRateLimiter, LimitCheck, LimitResult } from '../http/rate-limiter.js';
import type { PageRequest } from './access.js';
import { AuthController } from './auth.controller.js';
import type { OidcClient } from './oidc-client.js';
import type { SessionService } from './session.service.js';

const env = { publicUrl: new URL('https://aiops.example.test'), webClientId: 'aiops-web', sessionMaxAgeSeconds: 600 } as unknown as ApiEnv;

const session: SessionRow = {
  idHash: 'h',
  subject: 'carol-id',
  clientId: 'aiops-web',
  groups: [],
  authTime: new Date(),
  csrfToken: 't',
  expiresAt: new Date(Date.now() + 60_000),
};

class FakeResponse {
  statusCode = 200;
  readonly headers = new Map<string, string[]>();
  body: unknown;
  ended = false;
  status(code: number): this {
    this.statusCode = code;
    return this;
  }
  type(): this {
    return this;
  }
  send(body: unknown): this {
    this.body = body;
    this.ended = true;
    return this;
  }
  json(body: unknown): this {
    return this.send(body);
  }
  end(): this {
    this.ended = true;
    return this;
  }
  setHeader(name: string, value: string): this {
    this.headers.set(name, [value]);
    return this;
  }
  getHeader(name: string): string | undefined {
    return this.headers.get(name)?.[0];
  }
  append(name: string, value: string): this {
    this.headers.set(name, [...(this.headers.get(name) ?? []), value]);
    return this;
  }
  redirect(code: number, url: string): void {
    this.statusCode = code;
    this.setHeader('location', url);
    this.ended = true;
  }
}

const failingAudit: AuditLog = { append: () => Promise.reject(new Error('database down')) };

const configuration = { current: { rateLimits: { unauthenticatedPerMinute: 60 } } } as unknown as ConfigurationHolder;

/** A limiter that answers `result` and records the checks it was asked. */
function limiterAnswering(result: LimitResult, checks: LimitCheck[] = []): EndpointRateLimiter {
  return {
    check: (c: LimitCheck) => {
      checks.push(c);
      return Promise.resolve(result);
    },
  } as unknown as EndpointRateLimiter;
}

const allowing = limiterAnswering({ allowed: true });

function controller(audit: AuditLog, sessions: Partial<SessionService> = {}, limiter: EndpointRateLimiter = allowing, oidc = {} as OidcClient): AuthController {
  return new AuthController(env, oidc, sessions as SessionService, audit, pino({ level: 'silent' }), limiter, configuration);
}

describe('AUD-1 AUTH-5 page logins and logouts are audited before acting', () => {
  it('AUD-1 a failed login whose audit write fails answers 500, not the login error page', async () => {
    const res = new FakeResponse();
    await controller(failingAudit).callback({ query: { state: 's', code: 'c' }, headers: {} } as unknown as Request, res as unknown as Response);
    expect(res.statusCode).toBe(500);
    expect(res.headers.get('set-cookie')).toEqual([expect.stringMatching(/^aiops_login=; /)]);
  });

  it('AUD-1 a failed login is audited, then answered 400', async () => {
    const events: AuditEventInput[] = [];
    const res = new FakeResponse();
    await controller({ append: (e) => Promise.resolve(void events.push(e)) }).callback(
      { query: { state: 's' }, headers: {} } as unknown as Request,
      res as unknown as Response,
    );
    expect(res.statusCode).toBe(400);
    expect(events).toEqual([expect.objectContaining({ action: 'auth.login', outcome: 'error', details: { reason: 'state_unknown' } })]);
  });

  it('AUTH-5 a successful callback that carries a session cookie ends that session (one session per browser)', async () => {
    const ended: string[] = [];
    const created: string[] = [];
    const oidc = {
      exchange: () => Promise.resolve({ ok: true, identity: { subject: 'carol-id', clientId: 'aiops-web', groups: [], authTime: new Date() } }),
    } as unknown as OidcClient;
    const sessions = {
      consumeLogin: () => Promise.resolve({ stateHash: 'x', codeVerifier: 'v', nonce: 'n', returnTo: '/app/credentials', fresh: true, expiresAt: new Date() }),
      create: () => {
        created.push('new');
        return Promise.resolve({ cookieValue: 'new-cookie', session });
      },
      endCookie: (value: string) => Promise.resolve(void ended.push(value)),
    } as unknown as SessionService;
    const audit: AuditLog = { append: () => Promise.resolve() };
    const auth = new AuthController(env, oidc, sessions, audit, pino({ level: 'silent' }), allowing, configuration);
    const res = new FakeResponse();
    // https public URL: the session cookie is `__Host-aiops_session`.
    const req = { query: { state: 's', code: 'c' }, headers: { cookie: 'aiops_login=s; __Host-aiops_session=old-cookie' } } as unknown as Request;
    await auth.callback(req, res as unknown as Response);
    expect(res.statusCode).toBe(302);
    expect(res.headers.get('location')).toEqual(['/app/credentials']);
    expect(created).toEqual(['new']);
    expect(ended).toEqual(['old-cookie']);
    expect(res.headers.get('set-cookie')).toEqual([expect.stringMatching(/^aiops_login=; /), expect.stringMatching(/^__Host-aiops_session=new-cookie; /)]);

    ended.length = 0;
    await auth.callback({ query: { state: 's', code: 'c' }, headers: { cookie: 'aiops_login=s' } } as unknown as Request, new FakeResponse() as unknown as Response);
    expect(ended).toEqual([]);
  });

  it('AUD-1 logout whose audit write fails keeps the session', async () => {
    const ended: SessionRow[] = [];
    const res = new FakeResponse();
    const req = { headers: {}, page: { session, roles: [] } } as unknown as PageRequest;
    await expect(controller(failingAudit, { end: (s) => Promise.resolve(void ended.push(s)) }).logout(req, res as unknown as Response)).rejects.toThrow();
    expect(ended).toEqual([]);
    expect(res.headers.has('set-cookie')).toBe(false);
  });
});

describe('SEC-10 SEC-1 the page login routes are limited per address', () => {
  const untouched = (): Partial<SessionService> => ({
    purgeIfDue: () => Promise.reject(new Error('must not purge')),
    beginLogin: () => Promise.reject(new Error('must not write a login')),
    consumeLogin: () => Promise.reject(new Error('must not read a login')),
  });
  const oidc = { authorizationRequest: () => { throw new Error('must not build a request'); } } as unknown as OidcClient;
  const req = { query: { state: 's', code: 'c', return_to: '/app/' }, headers: { cookie: 'aiops_login=s' }, ip: '192.0.2.5' } as unknown as Request;

  for (const route of ['login', 'callback'] as const) {
    it(`SEC-10 /auth/${route} over the limit answers 429 with Retry-After and touches no login`, async () => {
      const checks: LimitCheck[] = [];
      const res = new FakeResponse();
      await controller(failingAudit, untouched(), limiterAnswering({ allowed: false, retryAfterSeconds: 17 }, checks), oidc)[route](req, res as unknown as Response);
      expect(res.statusCode).toBe(429);
      expect(res.getHeader('retry-after')).toBe('17');
      expect(res.body).toEqual({ error: 'rate_limited', retryAfterSeconds: 17 });
      expect(res.headers.has('set-cookie')).toBe(false);
      expect(res.headers.has('location')).toBe(false);
      expect(checks).toEqual([{ key: 'anon:192.0.2.5', limit: 60, scope: 'unauthenticated' }]);
    });

    it(`SEC-10 /auth/${route} fails closed with 503 and Retry-After 5 when the counter is unavailable`, async () => {
      const res = new FakeResponse();
      await controller(failingAudit, untouched(), limiterAnswering({ allowed: false, unavailable: true }), oidc)[route](req, res as unknown as Response);
      expect(res.statusCode).toBe(503);
      expect(res.getHeader('retry-after')).toBe('5');
      expect(res.body).toEqual({ error: 'rate_limit_unavailable' });
      expect(res.headers.has('set-cookie')).toBe(false);
    });
  }
});
