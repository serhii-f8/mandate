// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Mandate Authors
import { Controller, Get, Inject, Param, Req, Res } from '@nestjs/common';
import type { Response } from 'express';
import type { ChangeSetRepository, FileStore, StagedFile } from '@mandate/core';
import { imageTypeOf, TEXT_PREVIEW_BYTES } from '@mandate/core';
import { pageAnswer, pageViewer, visibleChangeset } from '../approvals/changeset-pages.controller.js';
import { refuse } from '../approvals/refusals.js';
import { CHANGESET_REPOSITORY, FILE_STORE, PAGE_CHECKS } from '../tokens.js';
import { PageAccess, type PageChecks, type PageRequest } from '../web/access.js';

/** RFC 5987 `attr-char`: `encodeURIComponent` leaves `'()*` alone, which the header grammar does not allow, and throws on a lone surrogate (the round trip through UTF-8 replaces it). */
function encodeFilename(name: string): string {
  return encodeURIComponent(Buffer.from(name, 'utf8').toString('utf8')).replace(/['()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
}

/**
 * The files of a change-set on the trusted pages (APR-5, UI-7): the content as a download and a
 * preview that is safe to show. Visibility is the change-set's (`visibleChangeset`); a file not
 * linked to it answers like an unknown one. Every answer is `no-store`, `nosniff` and sandboxed, so
 * nothing a user uploaded renders on the platform's origin (SEC-3).
 */
@Controller('api/v1/changesets')
export class ChangeSetFilesController {
  constructor(
    @Inject(CHANGESET_REPOSITORY) private readonly repository: ChangeSetRepository,
    @Inject(FILE_STORE) private readonly files: Pick<FileStore, 'ofChangeSet' | 'content'>,
    @Inject(PAGE_CHECKS) private readonly checks: PageChecks,
  ) {}

  /** The linked file when the viewer may see the change-set and the file belongs to it; otherwise the 404 is sent. */
  private async linked(req: PageRequest, res: Response, id: string, fileId: string): Promise<StagedFile | undefined> {
    pageAnswer(req, res);
    res.setHeader('x-content-type-options', 'nosniff');
    res.setHeader('content-security-policy', "sandbox; default-src 'none'");
    const found = await visibleChangeset(this.repository, id, pageViewer(req, this.checks));
    const wanted = fileId.toLowerCase();
    const link = found === undefined ? undefined : (await this.files.ofChangeSet(found.changeset.id)).find((l) => l.file.id === wanted);
    if (link === undefined) {
      await refuse(res, 'not_found');
      return undefined;
    }
    return link.file;
  }

  @Get(':id/files/:fileId/content')
  @PageAccess()
  async content(@Req() req: PageRequest, @Res() res: Response, @Param('id') id: string, @Param('fileId') fileId: string): Promise<void> {
    const file = await this.linked(req, res, id, fileId);
    if (file === undefined) return;
    const bytes = await this.files.content(file.id);
    if (bytes === undefined) {
      res.status(410).json({ error: 'purged' });
      return;
    }
    res.status(200);
    res.setHeader('content-type', 'application/octet-stream');
    res.setHeader('content-disposition', `attachment; filename*=UTF-8''${encodeFilename(file.name)}`);
    res.setHeader('content-length', String(bytes.byteLength));
    res.end(Buffer.from(bytes));
  }

  @Get(':id/files/:fileId/preview')
  @PageAccess()
  async preview(@Req() req: PageRequest, @Res() res: Response, @Param('id') id: string, @Param('fileId') fileId: string): Promise<void> {
    const file = await this.linked(req, res, id, fileId);
    if (file === undefined) return;
    if (file.preview === 'none') {
      res.status(404).json({ error: 'no_preview' });
      return;
    }
    const bytes = await this.files.content(file.id);
    if (bytes === undefined) {
      res.status(410).json({ error: 'purged' });
      return;
    }
    if (file.preview === 'image') {
      // Decided again on the bytes now: only a recognised image type is ever served as an image.
      const type = imageTypeOf(bytes);
      if (type === undefined) {
        res.status(404).json({ error: 'no_preview' });
        return;
      }
      res.status(200);
      res.setHeader('content-type', type);
      res.setHeader('content-length', String(bytes.byteLength));
      res.end(Buffer.from(bytes));
      return;
    }
    res.status(200).json({ text: new TextDecoder('utf-8').decode(bytes.subarray(0, TEXT_PREVIEW_BYTES)), truncated: bytes.byteLength > TEXT_PREVIEW_BYTES });
  }
}
