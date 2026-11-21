// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The AI Operations Layer Authors
import { HttpException, SetMetadata, type CanActivate, type ExecutionContext } from '@nestjs/common';
import type { Reflector } from '@nestjs/core';
import type { Request, Response } from 'express';
import type { SessionRow } from '@aiops/db';
import { pageCorrelation } from './correlation.js';
import { csrfAllowed } from './csrf.js';
import { sessionCookieValue, type SessionLookup } from './session.service.js';

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

/** The settings of the SEC-8 checks, shared by the guard and the controllers that run them themselves. */
export interface PageChecks {
  /** `AIOPS_PUBLIC_URL`'s origin. */
  readonly publicOrigin: string;
  readonly freshAuthSeconds: number;
  readonly now?: () => number;
}

export type PageAccessGuardOptions = PageChecks;

/** Why a page request with a valid session is refused (403). */
export type PageDenial = 'forbidden' | 'csrf' | 'reauthentication_required';

export interface RequiredChecks extends PageAccessOptions {
  /** The route's permission, when it depends on the request (e.g. on `:ref`); `false` is `forbidden`. */
  readonly permitted?: boolean;
}

/**
 * The checks of a page request after its session was found, in one fixed order:
 * permission → `Origin` + CSRF → fresh session (SEC-1, SEC-8). A forged request learns
 * neither the session age nor whether the body would be accepted. `undefined` = allowed.
 */
export function pageDenial(
  headers: PageRequest['headers'],
  session: Pick<SessionRow, 'csrfToken' | 'authTime'>,
  required: RequiredChecks,
  checks: PageChecks,
): PageDenial | undefined {
  if (required.permitted === false) return 'forbidden';
  if (required.csrf === true && !csrfAllowed(headers, session.csrfToken, checks.publicOrigin)) return 'csrf';
  if (required.fresh === true) {
    const now = checks.now?.() ?? Date.now();
    if (now - session.authTime.getTime() > checks.freshAuthSeconds * 1000) return 'reauthentication_required';
  }
  return undefined;
}

export const deny = (status: 401 | 403, error: 'unauthenticated' | PageDenial): HttpException => new HttpException({ error }, status);

/**
 * Global guard (SEC-1): every route is denied unless marked `@Public()` or
 * `@PageAccess()`. Page routes need a session found by the cookie in the shared store
 * (NFR-3); roles come from the session's groups through `role_mapping`, like MCP (AUTH-3).
 */
export class PageAccessGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly sessions: SessionLookup,
    private readonly rolesFor: (session: { subject: string; groups: readonly string[] }) => readonly string[],
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

    const cookieValue = sessionCookieValue(req.headers.cookie, this.options.publicOrigin.startsWith('https:'));
    const session = cookieValue === undefined ? undefined : await this.sessions.find(cookieValue);
    if (session === undefined) throw deny(401, 'unauthenticated');

    const denial = pageDenial(req.headers, session, access, this.options);
    if (denial !== undefined) throw deny(403, denial);
    req.page = { session, roles: this.rolesFor(session) };
    return true;
  }
}
