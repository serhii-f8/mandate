// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Mandate Authors
/**
 * Audit search and JSON Lines export on the trusted page (AUD-6, NFR-8). Denied by default
 * (`@PageAccess`, SEC-1); the `view_audit` role flag is checked before the query is parsed, and
 * every answer writes exactly one audit row before its first byte (AUD-1). The rows record the
 * filter names, never their values (SEC-3).
 */
import { randomUUID } from 'node:crypto';
import { Controller, Get, Inject, Query, Req, Res } from '@nestjs/common';
import type { Response } from 'express';
import type { Logger } from 'pino';
import type { ConfigurationHolder } from '@mandate/config';
import type { AuditLog, AuditReader, AuditSearchFilter } from '@mandate/core';
import { pageAnswer, pageViewer } from '../approvals/changeset-pages.controller.js';
import { pageRefuser, type Refuser } from '../approvals/refusals.js';
import type { PageViewer } from '../approvals/detail.js';
import { streamTo } from '../export/export.controller.js';
import { AUDIT_LOG, AUDIT_READER, CONFIGURATION, LOGGER, PAGE_CHECKS } from '../tokens.js';
import { pageCorrelation } from '../web/correlation.js';
import { PageAccess, type PageChecks, type PageRequest } from '../web/access.js';
import { mayViewAudit } from './access.js';
import { encodeAuditCursor, parseAuditExportQuery, parseAuditSearchQuery } from './audit-query.js';

/** Rows per database page of the export. */
const EXPORT_PAGE = 1000;

/** `2026-11-19T12:00:00.123Z` → `20261119T120000Z`. */
function fileStamp(at: Date): string {
  return at.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z');
}

/** Every match of `filter`, newest first, as JSON Lines: one chunk per database page. */
async function* jsonLines(reader: AuditReader, filter: AuditSearchFilter): AsyncIterable<string> {
  let beforeSeq: string | undefined;
  for (;;) {
    const { events, more } = await reader.search(filter, beforeSeq === undefined ? { limit: EXPORT_PAGE } : { limit: EXPORT_PAGE, beforeSeq });
    if (events.length > 0) yield events.map((e) => `${JSON.stringify(e)}\n`).join('');
    const last = events.at(-1);
    if (!more || last === undefined) return;
    beforeSeq = last.seq;
  }
}

@Controller('api/v1/audit')
export class AuditController {
  constructor(
    @Inject(AUDIT_READER) private readonly reader: AuditReader,
    @Inject(AUDIT_LOG) private readonly audit: AuditLog,
    @Inject(CONFIGURATION) private readonly configuration: ConfigurationHolder,
    @Inject(PAGE_CHECKS) private readonly checks: PageChecks,
    @Inject(LOGGER) private readonly logger: Logger,
  ) {}

  /** Check order: role flag (403) → query (400) → search → audit → answer. */
  @Get()
  @PageAccess()
  async search(@Req() req: PageRequest, @Res() res: Response, @Query() query: Record<string, unknown>): Promise<void> {
    const { viewer, correlationId, refuser } = this.begin(req, res, 'audit.search');
    if (!mayViewAudit(this.configuration.current, viewer.roles)) {
      await refuser('forbidden');
      return;
    }
    const parsed = parseAuditSearchQuery(query);
    if (!parsed.ok) {
      await refuser('invalid_query');
      return;
    }
    const { filter, filterNames, limit, beforeSeq } = parsed.value;
    const { events, more } = await this.reader.search(filter, beforeSeq === undefined ? { limit } : { limit, beforeSeq });
    await this.audit.append({
      id: randomUUID(),
      actor: viewer.subject,
      clientId: viewer.clientId,
      action: 'audit.search',
      outcome: 'ok',
      correlationId,
      details: { filters: filterNames, count: events.length, channel: 'page' },
    });
    const last = events.at(-1);
    res.status(200).json({ events, ...(more && last !== undefined ? { nextCursor: encodeAuditCursor(last.seq) } : {}) });
  }

  /** Check order: role flag (403) → query (400) → audit → headers → stream. */
  @Get('export')
  @PageAccess()
  async export(@Req() req: PageRequest, @Res() res: Response, @Query() query: Record<string, unknown>): Promise<void> {
    const { viewer, correlationId, refuser } = this.begin(req, res, 'audit.export');
    if (!mayViewAudit(this.configuration.current, viewer.roles)) {
      await refuser('forbidden');
      return;
    }
    const parsed = parseAuditExportQuery(query);
    if (!parsed.ok) {
      await refuser('invalid_query');
      return;
    }
    const { filter, filterNames } = parsed.value;
    await this.audit.append({
      id: randomUUID(),
      actor: viewer.subject,
      clientId: viewer.clientId,
      action: 'audit.export',
      outcome: 'ok',
      correlationId,
      details: { filters: filterNames, channel: 'page' },
    });
    res.status(200);
    res.setHeader('content-type', 'application/x-ndjson; charset=utf-8');
    res.setHeader('content-disposition', `attachment; filename="audit-${fileStamp(new Date())}.jsonl"`);
    res.setHeader('x-content-type-options', 'nosniff');
    await streamTo(res, jsonLines(this.reader, filter), (error) => {
      // The error's name only: a message may quote row content (SEC-3).
      this.logger.error({ correlationId, error: error instanceof Error ? error.name : typeof error }, 'audit export failed');
    });
  }

  /** `no-store`, the correlation ID, the viewer and the refuser of `action` (no change-set: `id: ''`). */
  private begin(req: PageRequest, res: Response, action: 'audit.search' | 'audit.export'): { viewer: PageViewer; correlationId: string; refuser: Refuser } {
    pageAnswer(req, res);
    const correlationId = pageCorrelation(req, res);
    const viewer = pageViewer(req, this.checks);
    return { viewer, correlationId, refuser: pageRefuser({ audit: this.audit, action, viewer, id: '', correlationId, res }) };
  }
}
