/**
 * Per-endpoint request limits (SEC-10): a fixed one-minute window per key, counted in the shared
 * `RateCounter` so every api instance sees one budget (NFR-3). A failing counter fails closed.
 */
import { createHash, randomUUID } from 'node:crypto';
import type { Logger } from 'pino';
import type { LoadedConfiguration } from '@aiops/config';
import { serviceClientOf, type AuditLog, type RateCounter } from '@aiops/core';
import { minuteWindow } from './rate-window.js';

export type LimitScope = 'mcp' | 'unauthenticated';

export interface LimitCheck {
  readonly key: string;
  readonly limit: number;
  readonly scope: LimitScope;
}

export type LimitResult =
  | { readonly allowed: true }
  | { readonly allowed: false; readonly retryAfterSeconds: number }
  | { readonly allowed: false; readonly unavailable: true };

export interface LimitContext {
  readonly actor: string;
  readonly clientId?: string;
  readonly correlationId: string;
}

export interface EndpointRateLimiterDeps {
  readonly rateCounter: RateCounter;
  readonly audit: AuditLog;
  /** Wall-clock time; it decides the window and `Retry-After`. */
  readonly wallClock: () => Date;
  readonly logger: Logger;
}

/** Seconds to the next UTC minute, rounded up, at least 1. */
export function retryAfterSeconds(now: Date): number {
  const remainingMs = minuteWindow(now).getTime() + 60_000 - now.getTime();
  return Math.max(1, Math.ceil(remainingMs / 1000));
}

export class EndpointRateLimiter {
  constructor(private readonly deps: EndpointRateLimiterDeps) {}

  /** Counts one request against `c.key`; writes the `rate.limited` row on the first refusal of a window. */
  async check(c: LimitCheck, ctx: LimitContext): Promise<LimitResult> {
    const now = this.deps.wallClock();
    let count: number;
    try {
      count = await this.deps.rateCounter.hit(c.key, minuteWindow(now));
    } catch (error) {
      // Any counter failure fails closed. Neither the key (it can hold an address) nor the message is logged (SEC-3).
      this.deps.logger.error({ err: errorName(error), scope: c.scope, correlationId: ctx.correlationId }, 'rate limit check failed');
      return { allowed: false, unavailable: true };
    }
    if (count <= c.limit) return { allowed: true };
    if (count === c.limit + 1) await this.auditFirstRefusal(c, ctx);
    return { allowed: false, retryAfterSeconds: retryAfterSeconds(now) };
  }

  private async auditFirstRefusal(c: LimitCheck, ctx: LimitContext): Promise<void> {
    try {
      await this.deps.audit.append({
        id: randomUUID(),
        actor: ctx.actor,
        ...(ctx.clientId === undefined ? {} : { clientId: ctx.clientId }),
        action: 'rate.limited',
        outcome: 'denied',
        correlationId: ctx.correlationId,
        details: { scope: c.scope, limit: c.limit },
      });
    } catch (error) {
      // The refusal stands without its audit row; the failure is logged by name only.
      this.deps.logger.warn({ err: errorName(error), scope: c.scope, correlationId: ctx.correlationId }, 'rate.limited audit failed');
    }
  }
}

/** Longest identity kept verbatim in a key; longer ones are hashed so the counter's index key stays small. */
const MAX_KEY_IDENTITY = 200;
// eslint-disable-next-line no-control-regex -- matching control characters is the point.
const CONTROL_CHARACTER = /[\u0000-\u001f\u007f-\u009f]/;

/** The identity as a key part: verbatim, or `sha256:<hex>` when it is too long or has a control character. */
function keyIdentity(identity: string): string {
  if (identity.length <= MAX_KEY_IDENTITY && !CONTROL_CHARACTER.test(identity)) return identity;
  return `sha256:${createHash('sha256').update(identity, 'utf8').digest('hex')}`;
}

/**
 * The MCP limit of an authenticated caller (SEC-10): service accounts by client ID with the
 * service-account limit or their own override, everyone else by subject with the user limit.
 */
export function mcpLimitCheck(subject: string, configuration: Pick<LoadedConfiguration, 'rateLimits' | 'serviceAccounts'>): LimitCheck {
  const clientId = serviceClientOf(subject);
  if (clientId === undefined) {
    return { key: `mcp:user:${keyIdentity(subject)}`, limit: configuration.rateLimits.mcpUserPerMinute, scope: 'mcp' };
  }
  const override = configuration.serviceAccounts.get(clientId)?.rateLimitPerMinute;
  return {
    key: `mcp:sa:${keyIdentity(clientId)}`,
    limit: override ?? configuration.rateLimits.mcpServiceAccountPerMinute,
    scope: 'mcp',
  };
}

function errorName(error: unknown): string {
  return error instanceof Error ? error.name : 'unknown';
}
