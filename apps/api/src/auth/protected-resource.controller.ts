// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Mandate Authors
import { Controller, Get, Inject, Req, Res } from '@nestjs/common';
import type { Request, Response } from 'express';
import type { ApiEnv } from '@mandate/config';
import { API_ENV } from '../tokens.js';
import { Public } from '../web/access.js';

export interface ProtectedResourceMetadata {
  readonly resource: string;
  readonly authorization_servers: string[];
  readonly scopes_supported: string[];
  readonly bearer_methods_supported: string[];
  readonly resource_name: string;
}

/** RFC 9728 document for the MCP endpoint (AUTH-2, ADR 0014). */
export function protectedResourceMetadata(env: ApiEnv): ProtectedResourceMetadata {
  return {
    resource: env.mcpResource.href,
    authorization_servers: [env.oidcIssuer],
    scopes_supported: ['mcp:tools'],
    bearer_methods_supported: ['header'],
    resource_name: 'Mandate',
  };
}

const ROOT = '/.well-known/oauth-protected-resource';

/** Served at the root well-known URL and at the one suffixed with the MCP path. */
@Controller()
@Public()
export class ProtectedResourceController {
  constructor(@Inject(API_ENV) private readonly env: ApiEnv) {}

  @Get(['.well-known/oauth-protected-resource', '.well-known/oauth-protected-resource/*rest'])
  serve(@Req() req: Request, @Res() res: Response): void {
    const resourcePath = this.env.mcpResource.pathname === '/' ? '' : this.env.mcpResource.pathname.replace(/\/$/, '');
    if (req.path !== ROOT && req.path !== `${ROOT}${resourcePath}`) {
      res.status(404).json({ error: 'not found' });
      return;
    }
    res.setHeader('cache-control', 'public, max-age=300');
    res.status(200).json(protectedResourceMetadata(this.env));
  }
}
