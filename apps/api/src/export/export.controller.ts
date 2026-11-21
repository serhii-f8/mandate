// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The AI Operations Layer Authors
/**
 * Change-set export on the trusted page (CS-8): the items as CSV or XLSX, streamed page by page
 * (NFR-7, NFR-8). Visibility is the detail page's (`canView`, UI-7); every answer is audited
 * before its first byte (AUD-1).
 */
import { randomUUID } from 'node:crypto';
import type { Writable } from 'node:stream';
import { Controller, Get, Inject, Param, Query, Req, Res } from '@nestjs/common';
import type { Response } from 'express';
import type { Logger } from 'pino';
import { canView, type AuditLog, type ChangeSetRepository } from '@aiops/core';
import { pageAnswer, pageViewer } from '../approvals/changeset-pages.controller.js';
import { CHANGESET_ID } from '../approvals/page-query.js';
import { pageRefuser } from '../approvals/refusals.js';
import { AUDIT_LOG, CHANGESET_REPOSITORY, LOGGER, PAGE_CHECKS } from '../tokens.js';
import { pageCorrelation } from '../web/correlation.js';
import { PageAccess, type PageChecks, type PageRequest } from '../web/access.js';
import { collectFields, itemPages } from './columns.js';
import { csvChunks } from './csv.js';
import { xlsxChunks } from './xlsx.js';

type ExportFormat = 'csv' | 'xlsx';

const CONTENT_TYPE: Readonly<Record<ExportFormat, string>> = {
  csv: 'text/csv; charset=utf-8',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
};

/** Resolves once `res` may take more data (`true`), or once it closed without draining (`false`). */
function writable(res: Writable): Promise<boolean> {
  return new Promise((resolve) => {
    const settle = (ok: boolean) => (): void => {
      res.off('drain', onDrain);
      res.off('close', onClose);
      resolve(ok);
    };
    const onDrain = settle(true);
    const onClose = settle(false);
    res.on('drain', onDrain);
    res.on('close', onClose);
  });
}

/**
 * Writes every chunk, honouring back-pressure, then ends `res`. An error from the chunks destroys
 * `res` instead, so the client never sees a clean end of a cut file; it is not rethrown, as the
 * headers are already sent; `onError` gets it after the destroy. A response closed by the client
 * stops the iteration.
 */
export async function streamTo(
  res: Writable,
  chunks: AsyncIterable<string | Uint8Array>,
  onError?: (error: unknown) => void,
): Promise<void> {
  try {
    for await (const chunk of chunks) {
      if (res.destroyed) return;
      if (!res.write(chunk) && !(await writable(res))) return;
    }
    res.end();
  } catch (error) {
    res.destroy(error instanceof Error ? error : new Error(String(error)));
    onError?.(error);
  }
}

/**
 * Logs a failed export stream: the IDs and the error's name only. The message and stack may hold
 * item values or target IDs, so they are never logged (SEC-3).
 */
export function exportFailureLogger(
  logger: Pick<Logger, 'error'>,
  context: { readonly correlationId: string; readonly changesetId: string; readonly format: ExportFormat },
): (error: unknown) => void {
  return (error) => {
    logger.error({ ...context, error: error instanceof Error ? error.name : typeof error }, 'change-set export failed');
  };
}

/** The `format` query value: exactly one of the two strings; a repeated or unknown value is refused. */
function formatOf(query: Record<string, unknown>): ExportFormat | undefined {
  const format = query.format;
  return format === 'csv' || format === 'xlsx' ? format : undefined;
}

@Controller('api/v1/changesets')
export class ChangeSetExportController {
  constructor(
    @Inject(CHANGESET_REPOSITORY) private readonly repository: ChangeSetRepository,
    @Inject(PAGE_CHECKS) private readonly checks: PageChecks,
    @Inject(AUDIT_LOG) private readonly audit: AuditLog,
    @Inject(LOGGER) private readonly logger: Logger,
  ) {}

  /** Check order: ID shape and visibility (404) → `format` (400) → audit → headers → stream. */
  @Get(':id/export')
  @PageAccess()
  async download(@Req() req: PageRequest, @Res() res: Response, @Param('id') id: string, @Query() query: Record<string, unknown>): Promise<void> {
    pageAnswer(req, res);
    const correlationId = pageCorrelation(req, res);
    const viewer = pageViewer(req, this.checks);
    const refuser = pageRefuser({ audit: this.audit, action: 'changeset.export', viewer, id, correlationId, res });

    const changeset = CHANGESET_ID.test(id) ? await this.repository.get(id) : undefined;
    if (changeset === undefined || !canView(changeset, await this.repository.approvals(changeset.id), viewer)) {
      await refuser('not_found');
      return;
    }
    const format = formatOf(query);
    if (format === undefined) {
      await refuser('invalid_query');
      return;
    }

    const fields = await collectFields(itemPages(this.repository, changeset.id));
    await this.audit.append({
      id: randomUUID(),
      actor: viewer.subject,
      clientId: viewer.clientId,
      action: 'changeset.export',
      outcome: 'ok',
      correlationId,
      changesetId: changeset.id,
      subject: changeset.id,
      details: { format, rows: changeset.stats.total, channel: 'page' },
    });

    res.status(200);
    res.setHeader('content-type', CONTENT_TYPE[format]);
    res.setHeader('content-disposition', `attachment; filename="changeset-${changeset.id}.${format}"`);
    res.setHeader('x-content-type-options', 'nosniff');
    const pages = itemPages(this.repository, changeset.id);
    await streamTo(
      res,
      format === 'csv' ? csvChunks(fields, pages) : xlsxChunks(fields, pages),
      exportFailureLogger(this.logger, { correlationId, changesetId: changeset.id, format }),
    );
  }
}
