import { randomUUID } from 'node:crypto';
import { Controller, Get, Inject, Param, Query, Req, Res } from '@nestjs/common';
import type { Response } from 'express';
import type { ConfigurationHolder } from '@aiops/config';
import { canView, type ApprovalRecord, type ChangeItemRecord, type ChangeSetExecutor, type ChangeSetRecord, type ChangeSetRepository } from '@aiops/core';
import { progressOf } from '../mcp/changeset-tools.js';
import { CHANGESET_EXECUTOR, CHANGESET_REPOSITORY, CONFIGURATION, PAGE_CHECKS } from '../tokens.js';
import { PageAccess, pageDenial, pageOf, type PageChecks, type PageRequest } from '../web/access.js';
import { pageCorrelation } from '../web/correlation.js';
import { changesetDetail, type PageViewer } from './detail.js';
import { CHANGESET_ID, encodeItemCursor, newSeed, parseItemsQuery, parseSampleQuery } from './page-query.js';
import { refuse } from './refusals.js';

/** Every page answer is per user and changes with the change-set: never cached (design part 2 §3). */
export function pageAnswer(req: PageRequest, res: Response): void {
  pageCorrelation(req, res);
  res.setHeader('cache-control', 'no-store');
}

/** The signed-in page user as the approval checks see them; `fresh` per SEC-8. */
export function pageViewer(req: PageRequest, checks: PageChecks): PageViewer {
  const { session, roles } = pageOf(req);
  return {
    subject: session.subject,
    ...(session.username === undefined ? {} : { name: session.username }),
    roles,
    clientId: session.clientId,
    authTime: session.authTime,
    fresh: pageDenial(req.headers, session, { fresh: true }, checks) === undefined,
  };
}

function itemOf(i: ChangeItemRecord): Record<string, unknown> {
  return {
    targetId: i.targetId,
    status: i.status,
    ...(i.reason === undefined ? {} : { reason: i.reason }),
    before: i.before,
    after: i.after,
    ...(i.error === undefined ? {} : { error: i.error }),
  };
}

/**
 * The change-set view of the trusted pages (UI-2, APR-5): detail, item pages (NFR-8) and a seeded
 * sample. One visibility function (`canView`, UI-7) guards every route, checked before anything
 * is built; unknown, foreign and malformed IDs all answer the same 404.
 */
@Controller('api/v1/changesets')
export class ChangeSetPagesController {
  constructor(
    @Inject(CHANGESET_REPOSITORY) private readonly repository: ChangeSetRepository,
    @Inject(CHANGESET_EXECUTOR) private readonly executor: ChangeSetExecutor,
    @Inject(CONFIGURATION) private readonly configuration: ConfigurationHolder,
    @Inject(PAGE_CHECKS) private readonly checks: PageChecks,
  ) {}

  /** The change-set and its approvals when the viewer may see it; otherwise the 404 is already sent. */
  private async visible(
    id: string,
    viewer: PageViewer,
    res: Response,
  ): Promise<{ changeset: ChangeSetRecord; approvals: readonly ApprovalRecord[] } | undefined> {
    if (CHANGESET_ID.test(id)) {
      const changeset = await this.repository.get(id);
      if (changeset !== undefined) {
        const approvals = await this.repository.approvals(id);
        if (canView(changeset, approvals, viewer)) return { changeset, approvals };
      }
    }
    await refuse(res, 'not_found');
    return undefined;
  }

  @Get(':id')
  @PageAccess()
  async detail(@Req() req: PageRequest, @Res() res: Response, @Param('id') id: string): Promise<void> {
    pageAnswer(req, res);
    const viewer = pageViewer(req, this.checks);
    const found = await this.visible(id, viewer, res);
    if (found === undefined) return;
    const { changeset, approvals } = found;
    const operation = this.configuration.current.policy.operations.find((op) => op.id === changeset.operation);
    const progress = await progressOf({ repository: this.repository, executor: this.executor, newId: randomUUID, now: () => new Date() }, changeset);
    res.status(200).json(
      changesetDetail({
        changeset,
        approvals,
        ...(operation === undefined ? {} : { operation }),
        ...(progress === undefined ? {} : { progress }),
        viewer,
        now: new Date(),
      }),
    );
  }

  @Get(':id/items')
  @PageAccess()
  async items(@Req() req: PageRequest, @Res() res: Response, @Param('id') id: string, @Query() query: Record<string, unknown>): Promise<void> {
    pageAnswer(req, res);
    const found = await this.visible(id, pageViewer(req, this.checks), res);
    if (found === undefined) return;
    const parsed = parseItemsQuery(query);
    if (!parsed.ok) {
      await refuse(res, 'invalid_query');
      return;
    }
    const { limit, after, status } = parsed.value;
    const rows = await this.repository.itemsPage(found.changeset.id, {
      limit: limit + 1,
      ...(after === undefined ? {} : { after }),
      ...(status === undefined ? {} : { status }),
    });
    const page = rows.slice(0, limit);
    const last = page.at(-1);
    res.status(200).json({
      items: page.map(itemOf),
      ...(rows.length > limit && last !== undefined ? { next: encodeItemCursor(last.targetId) } : {}),
    });
  }

  @Get(':id/sample')
  @PageAccess()
  async sample(@Req() req: PageRequest, @Res() res: Response, @Param('id') id: string, @Query() query: Record<string, unknown>): Promise<void> {
    pageAnswer(req, res);
    const found = await this.visible(id, pageViewer(req, this.checks), res);
    if (found === undefined) return;
    const parsed = parseSampleQuery(query);
    if (!parsed.ok) {
      await refuse(res, 'invalid_query');
      return;
    }
    const seed = parsed.value.seed ?? newSeed();
    const items = await this.repository.sampleItems(found.changeset.id, seed, parsed.value.size);
    res.status(200).json({ seed, items: items.map(itemOf) });
  }
}
