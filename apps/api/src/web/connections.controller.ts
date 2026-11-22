// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Mandate Authors
import { Controller, Inject, Param, Post, Req, Res } from '@nestjs/common';
import type { Response } from 'express';
import type { ConfigurationHolder } from '@mandate/config';
import type { AuditLog } from '@mandate/core';
import { AUDIT_LOG, CONFIGURATION, CONNECTION_TEST, PAGE_CHECKS } from '../tokens.js';
import type { ConnectionTestService } from '../upstream/connection-test.js';
import { PageAccess, type PageChecks, type PageRequest } from './access.js';
import { auditedId, credentialRequest, enforce, mayTestConnection } from './credential-access.js';

/** The connection test of the credential page (CONN-7): for who manages the connection's credential. */
@Controller('api/v1/connections')
export class ConnectionsController {
  constructor(
    @Inject(CONFIGURATION) private readonly configuration: ConfigurationHolder,
    @Inject(CONNECTION_TEST) private readonly tests: ConnectionTestService,
    @Inject(AUDIT_LOG) private readonly audit: AuditLog,
    @Inject(PAGE_CHECKS) private readonly checks: PageChecks,
  ) {}

  /** Checks: permission → Origin + CSRF (SEC-8); no fresh login needed, nothing is stored. */
  @Post(':id/test')
  @PageAccess()
  async test(@Req() req: PageRequest, @Res() res: Response, @Param('id') id: string): Promise<void> {
    const request = credentialRequest(req, res, this.configuration.current);
    const permitted = mayTestConnection(request.configuration, request.access, id);
    await enforce(this.audit, req, request, { permitted, csrf: true }, this.checks, { action: 'connection.test', subject: auditedId(id), details: { connection: auditedId(id) } });
    const { session } = request.page;
    const report = await this.tests.run(id, session.subject, session.clientId, request.correlationId, request.configuration);
    res.setHeader('cache-control', 'no-store');
    res.status(200).json(report);
  }
}
