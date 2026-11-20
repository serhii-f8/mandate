import { randomUUID } from 'node:crypto';
import { All, Controller, Inject, Post, Req, Res } from '@nestjs/common';
import { SpanKind, type Tracer } from '@opentelemetry/api';
import { toNodeHandler } from '@modelcontextprotocol/node';
import type { McpHttpHandler } from '@modelcontextprotocol/server';
import type { Request, Response } from 'express';
import type { Logger } from 'pino';
import type { ApiEnv, ConfigurationHolder } from '@aiops/config';
import type { AuditLog } from '@aiops/core';
import type { BearerGate } from '../auth/bearer-gate.js';
import { clientAddress } from '../http/client-address.js';
import { hostAllowed, originAllowed } from '../http/host-origin.js';
import { rateLimitedBody, rateLimitUnavailableBody, requestId, UNAVAILABLE_RETRY_AFTER_SECONDS } from '../http/rate-limit-answer.js';
import { mcpLimitCheck, type EndpointRateLimiter, type LimitCheck, type LimitContext } from '../http/rate-limiter.js';
import { API_ENV, AUDIT_LOG, BEARER_GATE, CONFIGURATION, LOGGER, MCP_HANDLER, RATE_LIMITER, TRACER } from '../tokens.js';
import { authInfoFor } from './mcp-server-factory.js';
import { Public } from '../web/access.js';

async function sendWebResponse(res: Response, response: globalThis.Response): Promise<void> {
  response.headers.forEach((value, key) => {
    res.setHeader(key, value);
  });
  res.status(response.status).send(await response.text());
}

/** The single MCP endpoint (MCP-1): stateless Streamable HTTP, POST only, a protected resource (AUTH-1). */
@Controller('mcp')
// Bearer-protected by its own gate (AUTH-1), not by page sessions.
@Public()
export class McpController {
  constructor(
    @Inject(MCP_HANDLER) private readonly handler: McpHttpHandler,
    @Inject(BEARER_GATE) private readonly gate: BearerGate,
    @Inject(AUDIT_LOG) private readonly audit: AuditLog,
    @Inject(API_ENV) private readonly env: ApiEnv,
    @Inject(LOGGER) private readonly logger: Logger,
    @Inject(TRACER) private readonly tracer: Tracer,
    @Inject(RATE_LIMITER) private readonly limiter: EndpointRateLimiter,
    @Inject(CONFIGURATION) private readonly configuration: ConfigurationHolder,
  ) {}

  @Post()
  async handle(@Req() req: Request, @Res() res: Response): Promise<void> {
    if (!hostAllowed(req.headers.host, this.env.allowedHosts) || !originAllowed(req.headers.origin, this.env.allowedHosts)) {
      res.status(403).json({ error: 'forbidden host or origin' });
      return;
    }
    const correlationId = randomUUID();
    // NFR-11: one server span per request; its only attribute is the correlation ID (SEC-3).
    await this.tracer.startActiveSpan('mcp.request', { kind: SpanKind.SERVER, attributes: { 'aiops.correlation_id': correlationId } }, async (span) => {
      try {
        await this.serve(req, res, correlationId);
      } finally {
        span.end();
      }
    });
  }

  private async serve(req: Request, res: Response, correlationId: string): Promise<void> {
    res.setHeader('x-correlation-id', correlationId);

    const auth = await this.gate.authenticate(req.headers.authorization);
    // Read per request: the configurationGate lets no request through while none is active (CFG-2).
    const current = this.configuration.current;
    if (!auth.ok) {
      // SEC-10: refused requests are limited per client address before anything is audited.
      const anonymous: LimitCheck = { key: `anon:${clientAddress(req)}`, limit: current.rateLimits.unauthenticatedPerMinute, scope: 'unauthenticated' };
      if (await this.refusedByLimit(req, res, anonymous, { actor: 'unknown', correlationId })) return;
      if (auth.reason !== undefined) {
        // Part of AUD-1: a presented token was refused. The reason is fixed text, never token content.
        await this.audit
          .append({ id: randomUUID(), actor: 'unknown', action: 'auth.rejected', outcome: 'denied', correlationId, details: { reason: auth.reason } })
          .catch((error: unknown) => {
            this.logger.warn({ correlationId, err: error instanceof Error ? error.message : 'unknown' }, 'audit of rejected token failed');
          });
      }
      await sendWebResponse(res, auth.response);
      return;
    }

    // SEC-10: the caller's budget is spent before the SDK runs; a refused request reaches no handler.
    const callerContext: LimitContext = {
      actor: auth.caller.subject,
      ...(auth.caller.clientId === undefined ? {} : { clientId: auth.caller.clientId }),
      correlationId,
    };
    if (await this.refusedByLimit(req, res, mcpLimitCheck(auth.caller.subject, current), callerContext)) return;

    const authInfo = authInfoFor({ caller: auth.caller, correlationId }, auth.expiresAt);
    const node = toNodeHandler(
      { fetch: (request) => this.handler.fetch(request, { authInfo }) },
      {
        onerror: (error) => {
          this.logger.error({ correlationId, err: error.message }, 'mcp adapter error');
        },
      },
    );
    await node(req, res, req.body);
  }

  /** Counts the request against `check`; answers 429 (over the limit) or 503 (counter unavailable) and returns true when refused. */
  private async refusedByLimit(req: Request, res: Response, check: LimitCheck, ctx: LimitContext): Promise<boolean> {
    const result = await this.limiter.check(check, ctx);
    if (result.allowed) return false;
    // A parsed body (express.json); only its JSON-RPC id is echoed.
    const id = requestId(req.body);
    if ('unavailable' in result) {
      res.setHeader('retry-after', String(UNAVAILABLE_RETRY_AFTER_SECONDS));
      res.status(503).json(rateLimitUnavailableBody(id));
    } else {
      res.setHeader('retry-after', String(result.retryAfterSeconds));
      res.status(429).json(rateLimitedBody(id, result.retryAfterSeconds));
    }
    return true;
  }

  /** Stateless serving: no SSE stream to open (GET) and no session to end (DELETE). */
  @All()
  methodNotAllowed(@Res() res: Response): void {
    res.setHeader('allow', 'POST');
    res.status(405).json({ error: 'method not allowed' });
  }
}
