import { ANONYMOUS_CALLER, type Caller } from '@aiops/core';

export interface IncomingRequestLike {
  readonly headers: Readonly<Record<string, string | string[] | undefined>>;
}

/**
 * Turns an HTTP request into the caller. The only place identity enters the MCP
 * endpoint; Phase 2 replaces the anonymous resolver with bearer-token
 * validation (AUTH-1, ADR 0013).
 */
export interface CallerResolver {
  resolve(req: IncomingRequestLike): Promise<Caller>;
}

export const CALLER_RESOLVER = Symbol('CallerResolver');

export class AnonymousCallerResolver implements CallerResolver {
  resolve(): Promise<Caller> {
    return Promise.resolve(ANONYMOUS_CALLER);
  }
}
