import { randomUUID } from 'node:crypto';
import { Body, Controller, Get, Inject, Param, Post, Query, Req, Res } from '@nestjs/common';
import type { Response } from 'express';
import type { ConfigurationHolder } from '@aiops/config';
import {
  canView,
  type ApprovalRecord,
  type AuditAction,
  type AuditLog,
  type ChangeItemRecord,
  type ChangeSetExecutor,
  type ChangeSetRecord,
  type ChangeSetRepository,
  type StartOutcome,
} from '@aiops/core';
import { progressOf } from '../mcp/changeset-tools.js';
import { APPROVAL_SERVICE, AUDIT_LOG, CHANGESET_EXECUTOR, CHANGESET_REPOSITORY, CONFIGURATION, PAGE_CHECKS } from '../tokens.js';
import { PageAccess, pageDenial, pageOf, type PageChecks, type PageRequest } from '../web/access.js';
import { pageCorrelation } from '../web/correlation.js';
import type { ApprovalService } from './approval-service.js';
import { isSummarised } from '../mcp/changeset-tools.js';
import { changesetDetail, checkPageStart, toApprover, type PageViewer } from './detail.js';
import { CHANGESET_ID, decisionBodySchema, encodeItemCursor, newSeed, parseItemsQuery, parseSampleQuery } from './page-query.js';
import { refuse, REFUSAL_STATUS, type PageRefusal } from './refusals.js';

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

/** The decision answer's `start`: `'started'`, or why the start was refused (ruling D4). */
function startAnswer(start: StartOutcome | 'executor_unavailable'): string {
  if (start === 'executor_unavailable') return start;
  return start.ok ? 'started' : start.reason;
}

/** Audits a refusal the controller finds itself, under the route's action, then answers it (AUD-1). */
type Refuser = (reason: PageRefusal) => Promise<void>;

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
    @Inject(AUDIT_LOG) private readonly audit: AuditLog,
    @Inject(APPROVAL_SERVICE) private readonly approvals: ApprovalService,
  ) {}

  /**
   * The change-set and its approvals when the viewer may see it; otherwise the 404 is already sent
   * (through `refuser` on the mutation routes, so it is audited).
   */
  private async visible(
    id: string,
    viewer: PageViewer,
    res: Response,
    refuser?: Refuser,
  ): Promise<{ changeset: ChangeSetRecord; approvals: readonly ApprovalRecord[] } | undefined> {
    if (CHANGESET_ID.test(id)) {
      const changeset = await this.repository.get(id);
      if (changeset !== undefined) {
        const approvals = await this.repository.approvals(id);
        if (canView(changeset, approvals, viewer)) return { changeset, approvals };
      }
    }
    await (refuser === undefined ? refuse(res, 'not_found') : refuser('not_found'));
    return undefined;
  }

  /** Refusals of a mutation route found here: one denied row of `action`, written before the answer. */
  private refuser(action: AuditAction, viewer: PageViewer, id: string, correlationId: string, res: Response): Refuser {
    // Only a UUID-shaped path value is recorded as the change-set; anything else is not stored.
    const changesetId = CHANGESET_ID.test(id) ? id.toLowerCase() : undefined;
    return (reason) =>
      refuse(res, reason, {
        log: this.audit,
        event: {
          id: randomUUID(),
          actor: viewer.subject,
          clientId: viewer.clientId,
          action,
          outcome: 'denied',
          correlationId,
          ...(changesetId === undefined ? {} : { changesetId, subject: changesetId }),
          details: { reason },
        },
      });
  }

  /**
   * Decides the awaited step (APR-2, APR-4, APR-6, SEC-9). Checks in the fixed order of SEC-8:
   * visibility (404) → Origin + CSRF → fresh session → body → the approval checks of part 1.
   */
  @Post(':id/decision')
  @PageAccess()
  async decide(@Req() req: PageRequest, @Res() res: Response, @Param('id') id: string, @Body() body: unknown): Promise<void> {
    pageAnswer(req, res);
    const correlationId = pageCorrelation(req, res);
    const viewer = pageViewer(req, this.checks);
    const refuser = this.refuser('approval.decision', viewer, id, correlationId, res);
    const found = await this.visible(id, viewer, res, refuser);
    if (found === undefined) return;
    const denial = pageDenial(req.headers, pageOf(req).session, { csrf: true, fresh: true }, this.checks);
    if (denial !== undefined) {
      await refuser(denial);
      return;
    }
    const parsed = decisionBodySchema.safeParse(body);
    if (!parsed.success) {
      await refuser('invalid_body');
      return;
    }
    const { decision, hash, count, comment } = parsed.data;
    const result = await this.approvals.decide({
      changesetId: found.changeset.id,
      decision,
      hash,
      count,
      ...(comment === undefined ? {} : { comment }),
      approver: toApprover(viewer),
      channel: 'page',
      correlationId,
      snapshot: this.configuration.current,
    });
    // The service audited its own refusal.
    if (!result.ok) {
      res.status(REFUSAL_STATUS[result.reason]).json({ error: result.reason });
      return;
    }
    res.status(200).json({ status: result.status, ...(result.start === undefined ? {} : { start: startAnswer(result.start) }) });
  }

  /**
   * Starts an approved change-set (APR-7): the same SEC-8 order, then the page start check
   * (`not_approved_status`, `not_permitted`), then the service's start with the requester's identity.
   */
  @Post(':id/start')
  @PageAccess()
  async start(@Req() req: PageRequest, @Res() res: Response, @Param('id') id: string): Promise<void> {
    pageAnswer(req, res);
    const correlationId = pageCorrelation(req, res);
    const viewer = pageViewer(req, this.checks);
    const refuser = this.refuser('changeset.start', viewer, id, correlationId, res);
    const found = await this.visible(id, viewer, res, refuser);
    if (found === undefined) return;
    const denial = pageDenial(req.headers, pageOf(req).session, { csrf: true, fresh: true }, this.checks);
    if (denial !== undefined) {
      await refuser(denial);
      return;
    }
    const refusal = checkPageStart(found.changeset, found.approvals, viewer, new Date());
    if (refusal !== undefined) {
      await refuser(refusal);
      return;
    }
    const changesetId = found.changeset.id;
    const result = await this.approvals.startApproved({ changesetId, actor: viewer.subject, clientId: viewer.clientId, correlationId, snapshot: this.configuration.current });
    // The service audited its own refusal.
    if (!result.ok) {
      res.status(REFUSAL_STATUS[result.reason]).json({ error: result.reason });
      return;
    }
    const after = await this.repository.get(changesetId);
    res.status(200).json({ status: after?.status ?? found.changeset.status });
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
    const drift = isSummarised(changeset) ? ((await this.repository.errorCounts(changeset.id)).drift ?? 0) : undefined;
    res.status(200).json(
      changesetDetail({
        changeset,
        ...(drift === undefined ? {} : { drift }),
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
