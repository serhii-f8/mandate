import { randomUUID } from 'node:crypto';
import { Controller, Get, Inject, Post, Req, Res } from '@nestjs/common';
import type { Request, Response } from 'express';
import type { Logger } from 'pino';
import type { ApiEnv } from '@aiops/config';
import type { AuditLog } from '@aiops/core';
import { API_ENV, AUDIT_LOG, LOGGER, OIDC_CLIENT, PAGE_CHECKS, PAGE_SESSIONS } from '../tokens.js';
import { PageAccess, pageDenial, pageOf, Public, type PageChecks, type PageRequest } from './access.js';
import { pageCorrelation } from './correlation.js';
import type { OidcClient } from './oidc-client.js';
import { constantTimeEqual } from './csrf.js';
import { clearedLoginCookie, clearedSessionCookie, LOGIN_COOKIE, loginCookie, parseCookies, sessionCookie, type SessionService } from './session.service.js';

const DEFAULT_RETURN = '/app/';
const MAX_RETURN_LENGTH = 2048;

/** Fixed, value-free reasons of a failed login (design §4, §7). */
export type LoginFailure = 'state_unknown' | 'code_exchange_failed' | 'id_token_invalid' | 'idp_error';

/**
 * `return_to` must name a path under `/app/` on this origin; anything else (absolute or
 * protocol-relative URLs, backslashes, dot segments leaving `/app/`) becomes `/app/`.
 */
export function safeReturnTo(value: unknown, publicUrl: URL): string {
  if (typeof value !== 'string' || value.length > MAX_RETURN_LENGTH) return DEFAULT_RETURN;
  if (!value.startsWith('/') || value.startsWith('//') || value.includes('\\') || hasControlCharacter(value)) return DEFAULT_RETURN;
  let url: URL;
  try {
    url = new URL(value, publicUrl);
  } catch {
    return DEFAULT_RETURN;
  }
  if (url.origin !== publicUrl.origin || !url.pathname.startsWith('/app/')) return DEFAULT_RETURN;
  return `${url.pathname}${url.search}${url.hash}`;
}

function hasControlCharacter(value: string): boolean {
  for (let i = 0; i < value.length; i++) if (value.charCodeAt(i) < 0x20 || value.charCodeAt(i) === 0x7f) return true;
  return false;
}

const single = (value: unknown): string | undefined => (typeof value === 'string' && value !== '' ? value : undefined);

/** OIDC login and logout for the trusted pages (AUTH-5, ADR 0019). */
@Controller('auth')
export class AuthController {
  constructor(
    @Inject(API_ENV) private readonly env: ApiEnv,
    @Inject(OIDC_CLIENT) private readonly oidc: OidcClient,
    @Inject(PAGE_SESSIONS) private readonly sessions: SessionService,
    @Inject(AUDIT_LOG) private readonly audit: AuditLog,
    @Inject(LOGGER) private readonly logger: Logger,
  ) {}

  private get secure(): boolean {
    return this.env.publicUrl.protocol === 'https:';
  }

  @Get('login')
  @Public()
  async login(@Req() req: Request, @Res() res: Response): Promise<void> {
    const correlationId = pageCorrelation(req, res);
    // Housekeeping must never block a login.
    await this.sessions.purgeIfDue().catch((error: unknown) => {
      this.logger.warn({ correlationId, err: error instanceof Error ? error.message : 'unknown' }, 'purge of expired page sessions failed');
    });
    const fresh = req.query.fresh === '1';
    const request = this.oidc.authorizationRequest({ fresh });
    await this.sessions.beginLogin({
      state: request.state,
      codeVerifier: request.codeVerifier,
      nonce: request.nonce,
      returnTo: safeReturnTo(req.query.return_to, this.env.publicUrl),
      fresh,
    });
    res.setHeader('cache-control', 'no-store');
    res.append('set-cookie', loginCookie(request.state, this.secure));
    res.redirect(302, request.url.toString());
  }

  @Get('callback')
  @Public()
  async callback(@Req() req: Request, @Res() res: Response): Promise<void> {
    const correlationId = pageCorrelation(req, res);
    res.setHeader('cache-control', 'no-store');
    // The login cookie is single use too, whatever the outcome.
    res.append('set-cookie', clearedLoginCookie(this.secure));
    const state = single(req.query.state);
    const bound = parseCookies(req.headers.cookie).get(LOGIN_COOKIE);
    // SEC-8 login CSRF: the state must come back in the browser that started the login.
    if (state === undefined || bound === undefined || !constantTimeEqual(bound, state)) {
      await this.failed(res, correlationId, 'state_unknown');
      return;
    }
    const login = await this.sessions.consumeLogin(state);
    if (login === undefined) {
      await this.failed(res, correlationId, 'state_unknown');
      return;
    }
    const code = single(req.query.code);
    if (req.query.error !== undefined || code === undefined) {
      await this.failed(res, correlationId, 'idp_error');
      return;
    }
    const result = await this.oidc.exchange({ code, codeVerifier: login.codeVerifier, nonce: login.nonce });
    if (!result.ok) {
      await this.failed(res, correlationId, result.reason);
      return;
    }
    // Audited before the session exists: a login that cannot be audited does not happen (AUD-1).
    await this.audit.append({
      id: randomUUID(),
      actor: result.identity.subject,
      clientId: this.env.webClientId,
      action: 'auth.login',
      outcome: 'ok',
      correlationId,
      details: { fresh: login.fresh },
    });
    const { cookieValue } = await this.sessions.create(result.identity);
    res.append('set-cookie', sessionCookie(cookieValue, this.env.sessionMaxAgeSeconds, this.secure));
    res.redirect(302, login.returnTo);
  }

  @Post('logout')
  @PageAccess({ csrf: true })
  async logout(@Req() req: PageRequest, @Res() res: Response): Promise<void> {
    const correlationId = pageCorrelation(req, res);
    const { session } = pageOf(req);
    // Audited first: a logout that cannot be audited does not happen (AUD-1).
    await this.audit.append({ id: randomUUID(), actor: session.subject, clientId: session.clientId, action: 'auth.logout', outcome: 'ok', correlationId, details: {} });
    await this.sessions.end(session);
    res.setHeader('set-cookie', clearedSessionCookie(this.secure));
    res.status(204).end();
  }

  @Get('logged-out')
  @Public()
  loggedOut(@Res() res: Response): void {
    res.status(200).type('text/plain').send('You are logged out. Open /app/ to log in again.\n');
  }

  private async failed(res: Response, correlationId: string, reason: LoginFailure): Promise<void> {
    try {
      await this.audit.append({ id: randomUUID(), actor: 'unknown', clientId: this.env.webClientId, action: 'auth.login', outcome: 'error', correlationId, details: { reason } });
    } catch (error) {
      // Like the success path: an outcome that cannot be audited is a server error (AUD-1).
      this.logger.warn({ correlationId, err: error instanceof Error ? error.message : 'unknown' }, 'audit of failed login failed');
      res.status(500).type('text/plain').send('Login could not be completed. Try again later.\n');
      return;
    }
    // A fixed page: nothing from the request or the identity provider is echoed.
    res.status(400).type('text/plain').send('Login failed. Open /app/ to try again.\n');
  }
}

/** The page session as the trusted pages see it (AUTH-5). */
@Controller('api/v1')
export class SessionController {
  constructor(@Inject(PAGE_CHECKS) private readonly checks: PageChecks) {}

  @Get('session')
  @PageAccess()
  current(@Req() req: PageRequest, @Res() res: Response): void {
    const { session, roles } = pageOf(req);
    res.setHeader('cache-control', 'no-store');
    res.status(200).json({
      subject: session.subject,
      ...(session.username === undefined ? {} : { username: session.username }),
      roles,
      csrfToken: session.csrfToken,
      authTime: session.authTime.toISOString(),
      // SEC-8: the same rule the credential change applies, so the page can re-authenticate first.
      fresh: pageDenial(req.headers, session, { fresh: true }, this.checks) === undefined,
      expiresAt: session.expiresAt.toISOString(),
    });
  }
}
