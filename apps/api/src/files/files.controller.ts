// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Mandate Authors
import { randomUUID } from 'node:crypto';
import { Controller, Get, Inject, Post, Req, Res } from '@nestjs/common';
import type { Response } from 'express';
import type { ConfigurationHolder, LoadedConfiguration } from '@mandate/config';
import { filePreviewKind, parseFileName, parseMediaType, sha256Of, type AuditLog, type FileStore } from '@mandate/core';
import { AUDIT_LOG, CONFIGURATION, FILE_STORE } from '../tokens.js';
import { PageAccess, pageOf, type PageRequest } from '../web/access.js';
import { pageCorrelation } from '../web/correlation.js';
import { fileView, mayStageFiles } from './access.js';

/** The own-file listing is at most this long (spec 4.2 "Listing"). */
const LISTING_LIMIT = 200;

type Checked = { ok: true; name: string; mediaType: string; content: Buffer } | { ok: false; status: 400 | 403 | 413; error: string };

/** The upload's checks in their fixed order: permission, name, media type, non-empty, size. */
function checkUpload(req: PageRequest & { body?: unknown }, roles: readonly string[], configuration: LoadedConfiguration): Checked {
  if (!mayStageFiles(roles, configuration)) return { ok: false, status: 403, error: 'forbidden' };
  const rawName = req.headers['x-file-name'];
  const name = typeof rawName === 'string' ? parseFileName(rawName) : undefined;
  if (name === undefined) return { ok: false, status: 400, error: 'invalid_name' };
  const mediaType = parseMediaType(req.headers['content-type']);
  if (mediaType === undefined) return { ok: false, status: 400, error: 'invalid_media_type' };
  const content: unknown = req.body;
  if (!Buffer.isBuffer(content) || content.length < 1) return { ok: false, status: 400, error: 'empty_file' };
  if (content.length > configuration.files.maxBytes) return { ok: false, status: 413, error: 'payload_too_large' };
  return { ok: true, name, mediaType, content };
}

/**
 * Staging of files for operations with file arguments (CS-10): upload and the caller's own files.
 * The body of an upload is the raw bytes (parsed in `app.ts`); the file name is user text and goes
 * nowhere but the stored row: not into a log, not into the audit (SEC-3).
 */
@Controller('api/v1/files')
export class FilesController {
  constructor(
    @Inject(CONFIGURATION) private readonly configuration: ConfigurationHolder,
    @Inject(FILE_STORE) private readonly store: FileStore,
    @Inject(AUDIT_LOG) private readonly audit: AuditLog,
  ) {}

  /** Checks in order: permission, name, media type, non-empty, size, quota. Refusals after the permission check are not audited. */
  @Post()
  @PageAccess({ csrf: true })
  async upload(@Req() req: PageRequest & { body?: unknown }, @Res() res: Response): Promise<void> {
    const { session, roles } = pageOf(req);
    const correlationId = pageCorrelation(req, res);
    const configuration = this.configuration.current;
    const checked = checkUpload(req, roles, configuration);
    if (!checked.ok) {
      res.status(checked.status).json({ error: checked.error });
      return;
    }
    const { name, mediaType, content } = checked;
    const settings = configuration.files;
    const sha256 = sha256Of(content);
    const id = randomUUID();
    const staged = await this.store.stage(
      {
        id,
        owner: session.subject,
        ...(session.clientId === '' ? {} : { clientId: session.clientId }),
        name,
        mediaType,
        content,
        sha256,
        preview: filePreviewKind(mediaType, content),
        createdAt: new Date(),
        quota: { count: settings.perUserCount, bytes: settings.perUserBytes },
      },
      {
        id: randomUUID(),
        actor: session.subject,
        ...(session.clientId === '' ? {} : { clientId: session.clientId }),
        action: 'file.staged',
        subject: id,
        outcome: 'ok',
        correlationId,
        details: { size: content.length, mediaType, sha256 },
      },
    );
    if (!staged.ok) {
      res.status(409).json({ error: staged.code });
      return;
    }
    res.status(201).json(fileView(staged.file, settings));
  }

  /** The caller's own files that still have content, newest first. */
  @Get()
  @PageAccess()
  async list(@Req() req: PageRequest, @Res() res: Response): Promise<void> {
    const { session, roles } = pageOf(req);
    pageCorrelation(req, res);
    const configuration = this.configuration.current;
    if (!mayStageFiles(roles, configuration)) {
      res.status(403).json({ error: 'forbidden' });
      return;
    }
    const files = await this.store.ownedBy(session.subject, LISTING_LIMIT);
    res.setHeader('cache-control', 'no-store');
    res.status(200).json(files.map((file) => fileView(file, configuration.files)));
  }
}
