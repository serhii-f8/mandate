import { HttpException, SetMetadata, type CanActivate, type ExecutionContext } from '@nestjs/common';
import type { Reflector } from '@nestjs/core';
import type { Request, Response } from 'express';
import type { SessionRow } from '@aiops/db';
import { pageCorrelation } from './correlation.js';
import { csrfAllowed } from './csrf.js';
import { parseCookies, SESSION_COOKIE, type SessionLookup } from './session.service.js';

export const PUBLIC_KEY = 'aiops:public';
export const PAGE_ACCESS_KEY = 'aiops:page-access';

export interface PageAccessOptions {
  /** Mutations: `X-CSRF-Token` and `Origin` must match (SEC-8). */
  readonly csrf?: boolean;
  /** `now − auth_time ≤ AIOPS_FRESH_AUTH_SECONDS` (SEC-8). */
  readonly fresh?: boolean;
}

/** What the guard puts on a page request it let through. */
export interface PageContext {
  readonly session: SessionRow;
  readonly roles: readonly string[];
}

export type PageRequest = Request & { page?: PageContext };

/** No session needed: health, well-known documents, `/auth/*`, static files, and MCP (its own bearer gate). */
export const Public = (): ClassDecorator & MethodDecorator => SetMetadata(PUBLIC_KEY, true);

/** A trusted-page route: needs a page session; options add CSRF and freshness checks. */
export const PageAccess = (options: PageAccessOptions = {}): ClassDecorator & MethodDecorator => SetMetadata(PAGE_ACCESS_KEY, options);

/** The guard's result on a `@PageAccess` route; refuses (401) if the guard did not run, so a wiring mistake fails closed. */
export function pageOf(req: PageRequest): PageContext {
  if (req.page === undefined) throw new HttpException({ error: 'unauthenticated' }, 401);
  return req.page;
}

type RouteTarget = Parameters<Reflector['get']>[1];

/**
 * How a route is marked. The handler's own marker wins over its class's, so a
 * `@PageAccess` method in a `@Public` controller still needs a session.
 */
export function routeAccess(reflector: Reflector, handler: RouteTarget, cls: RouteTarget): 'public' | 'none' | PageAccessOptions {
  for (const target of [handler, cls]) {
    const access = reflector.get<PageAccessOptions | undefined>(PAGE_ACCESS_KEY, target);
    if (access !== undefined) return access;
    if (reflector.get<boolean | undefined>(PUBLIC_KEY, target) === true) return 'public';
  }
  return 'none';
}

export interface PageAccessGuardOptions {
  /** `AIOPS_PUBLIC_URL`'s origin. */
  readonly publicOrigin: string;
  readonly freshAuthSeconds: number;
  readonly now?: () => number;
}

const deny = (status: 401 | 403, error: 'unauthenticated' | 'forbidden' | 'csrf' | 'reauthentication_required'): HttpException =>
  new HttpException({ error }, status);

/**
 * Global guard (SEC-1): every route is denied unless marked `@Public()` or
 * `@PageAccess()`. Page routes need a session found by the cookie in the shared store
 * (NFR-3); roles come from the session's groups through `role_mapping`, like MCP (AUTH-3).
 */
export class PageAccessGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly sessions: SessionLookup,
    private readonly rolesFor: (groups: readonly string[]) => readonly string[],
    private readonly options: PageAccessGuardOptions,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const access = routeAccess(this.reflector, context.getHandler(), context.getClass());
    if (access === 'public') return true;

    const http = context.switchToHttp();
    const req = http.getRequest<PageRequest>();
    const res = http.getResponse<Response>();
    pageCorrelation(req, res);
    if (access === 'none') throw deny(403, 'forbidden');

    const cookieValue = parseCookies(req.headers.cookie).get(SESSION_COOKIE);
    const session = cookieValue === undefined || cookieValue === '' ? undefined : await this.sessions.find(cookieValue);
    if (session === undefined) throw deny(401, 'unauthenticated');

    if (access.csrf === true && !csrfAllowed(req.headers, session.csrfToken, this.options.publicOrigin)) throw deny(403, 'csrf');
    if (access.fresh === true) {
      const now = this.options.now?.() ?? Date.now();
      if (now - session.authTime.getTime() > this.options.freshAuthSeconds * 1000) throw deny(403, 'reauthentication_required');
    }
    req.page = { session, roles: this.rolesFor(session.groups) };
    return true;
  }
}
