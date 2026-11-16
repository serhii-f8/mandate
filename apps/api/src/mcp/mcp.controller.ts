import { randomUUID } from 'node:crypto';
import { All, Controller, Inject, Post, Req, Res } from '@nestjs/common';
import { toNodeHandler } from '@modelcontextprotocol/node';
import type { McpHttpHandler } from '@modelcontextprotocol/server';
import type { Request, Response } from 'express';
import type { Logger } from 'pino';
import type { ApiEnv } from '@aiops/config';
import { hostAllowed, originAllowed } from '../http/host-origin.js';
import { API_ENV, LOGGER, MCP_HANDLER } from '../tokens.js';
import { CALLER_RESOLVER, type CallerResolver } from './caller-resolver.js';
import { authInfoFor } from './mcp-server-factory.js';

/** The single MCP endpoint (MCP-1): stateless Streamable HTTP, POST only. */
@Controller('mcp')
export class McpController {
  constructor(
    @Inject(MCP_HANDLER) private readonly handler: McpHttpHandler,
    @Inject(CALLER_RESOLVER) private readonly callers: CallerResolver,
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
    const caller = await this.callers.resolve(req);
    const authInfo = authInfoFor({ caller, correlationId });
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
