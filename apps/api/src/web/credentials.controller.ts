// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The AI Operations Layer Authors
import { randomUUID } from 'node:crypto';
import { Body, Controller, Get, Inject, Param, Put, Req, Res } from '@nestjs/common';
import type { Response } from 'express';
import { parseSecret, secretFieldNames } from '@aiops/connector-sdk';
import type { ConfigurationHolder } from '@aiops/config';
import type { AuditLog, CredentialVault } from '@aiops/core';
import { AUDIT_LOG, CONFIGURATION, CREDENTIAL_VAULT, PAGE_CHECKS } from '../tokens.js';
import { deny, PageAccess, type PageChecks, type PageRequest } from './access.js';
import { auditDenied, auditedId, credentialRequest, enforce } from './credential-access.js';

/**
 * Credential entry for the trusted page (UI-5): list the refs the user manages and set a
 * secret. Values go in once and never come back: no route returns or logs them (SEC-3).
 */
@Controller('api/v1/credentials')
export class CredentialsController {
  constructor(
    @Inject(CONFIGURATION) private readonly configuration: ConfigurationHolder,
    @Inject(CREDENTIAL_VAULT) private readonly vault: CredentialVault,
    @Inject(AUDIT_LOG) private readonly audit: AuditLog,
    @Inject(PAGE_CHECKS) private readonly checks: PageChecks,
  ) {}

  /** Only the refs the user's roles manage (UI-7 style), with the form fields of their scheme. */
  @Get()
  @PageAccess()
  async list(@Req() req: PageRequest, @Res() res: Response): Promise<void> {
    const { configuration, access } = credentialRequest(req, res, this.configuration.current);
    const refs = [...access.refs].sort();
    const statuses = new Map((await this.vault.describe(refs)).map((s) => [s.ref, s] as const));
    const rows = refs.flatMap((ref) => {
      const declared = configuration.credentialRefs.get(ref);
      if (declared === undefined) return [];
      const status = statuses.get(ref);
      return [
        {
          ref,
          scheme: declared.scheme,
          connections: [...declared.connections],
          notifications: [...declared.notifications],
          fields: [...secretFieldNames(declared.scheme)],
          set: status?.set ?? false,
          ...(status?.updatedAt === undefined ? {} : { updatedAt: status.updatedAt.toISOString() }),
          ...(status?.updatedBy === undefined ? {} : { updatedBy: status.updatedBy }),
          ...(status?.keyVersion === undefined ? {} : { keyVersion: status.keyVersion }),
        },
      ];
    });
    res.setHeader('cache-control', 'no-store');
    res.status(200).json(rows);
  }

  /** Sets a secret. Checks: permission → Origin + CSRF → fresh session → body (SEC-8). */
  @Put(':ref')
  @PageAccess()
  async put(@Req() req: PageRequest, @Res() res: Response, @Param('ref') ref: string, @Body() body: unknown): Promise<void> {
    const request = credentialRequest(req, res, this.configuration.current);
    const denied = { action: 'credential.set', subject: auditedId(ref), details: { ref: auditedId(ref) } } as const;
    const declared = request.configuration.credentialRefs.get(ref);
    await enforce(this.audit, req, request, { permitted: declared !== undefined && request.access.refs.has(ref), csrf: true, fresh: true }, this.checks, denied);
    // Narrowing only: `enforce` refused an unconfigured ref as forbidden already.
    if (declared === undefined) throw deny(403, 'forbidden');
    const parsed = parseSecret(declared.scheme, body);
    if (!parsed.ok) {
      await auditDenied(this.audit, request, denied, 'invalid_secret');
      // The scheme's field names only: nothing of the body is echoed (SEC-3).
      res.status(400).json({ error: 'invalid_secret', fields: [...secretFieldNames(declared.scheme)] });
      return;
    }
    const { session } = request.page;
    const correlationId = request.correlationId;
    // The vault stores the secret and appends this audit event in one database transaction:
    // a secret whose change cannot be audited is not stored (AUD-1).
    await this.vault.put({
      ref,
      scheme: declared.scheme,
      secret: parsed.secret,
      actor: session.subject,
      audit: {
        event: (keyVersion) => ({
          id: randomUUID(),
          actor: session.subject,
          clientId: session.clientId,
          action: 'credential.set',
          subject: ref,
          outcome: 'ok',
          correlationId,
          details: { ref, scheme: declared.scheme, keyVersion },
        }),
      },
    });
    res.status(204).end();
  }
}
