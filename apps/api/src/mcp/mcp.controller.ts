import { randomUUID } from 'node:crypto';
import { All, Controller, Inject, Post, Req, Res } from '@nestjs/common';
import { toNodeHandler } from '@modelcontextprotocol/node';
import type { McpHttpHandler } from '@modelcontextprotocol/server';
import type { Request, Response } from 'express';
import type { Logger } from 'pino';
import type { ApiEnv } from '@aiops/config';
import type { AuditLog } from '@aiops/core';
import type { BearerGate } from '../auth/bearer-gate.js';
import { hostAllowed, originAllowed } from '../http/host-origin.js';
import { API_ENV, AUDIT_LOG, BEARER_GATE, LOGGER, MCP_HANDLER } from '../tokens.js';
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
  ) {}

  @Post()
  async handle(@Req() req: Request, @Res() res: Response): Promise<void> {
    if (!hostAllowed(req.headers.host, this.env.allowedHosts) || !originAllowed(req.headers.origin, this.env.allowedHosts)) {
      res.status(403).json({ error: 'forbidden host or origin' });
      return;
    }
    const correlationId = randomUUID();
    res.setHeader('x-correlation-id', correlationId);

    const auth = await this.gate.authenticate(req.headers.authorization);
    if (!auth.ok) {
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

  /** Stateless serving: no SSE stream to open (GET) and no session to end (DELETE). */
  @All()
  methodNotAllowed(@Res() res: Response): void {
    res.setHeader('allow', 'POST');
    res.status(405).json({ error: 'method not allowed' });
  }
}
