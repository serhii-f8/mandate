import { Controller, Get, Inject, Query, Req, Res } from '@nestjs/common';
import type { Response } from 'express';
import type { ConfigurationHolder } from '@aiops/config';
import { currentStep, type ChangeSetRepository } from '@aiops/core';
import { CHANGESET_REPOSITORY, CONFIGURATION } from '../tokens.js';
import { PageAccess, pageOf, type PageRequest } from '../web/access.js';
import { pageAnswer } from './changeset-pages.controller.js';
import { encodeQueueCursor, parseQueueQuery } from './page-query.js';
import { refuse } from './refusals.js';

/**
 * The approval queue (UI-7): change-sets the user can decide now — awaiting one of their roles,
 * not their own, not expired — newest submission first, keyset-paged (NFR-8).
 */
@Controller('api/v1/approvals')
export class ApprovalsController {
  constructor(
    @Inject(CHANGESET_REPOSITORY) private readonly repository: ChangeSetRepository,
    @Inject(CONFIGURATION) private readonly configuration: ConfigurationHolder,
  ) {}

  @Get()
  @PageAccess()
  async queue(@Req() req: PageRequest, @Res() res: Response, @Query() query: Record<string, unknown>): Promise<void> {
    pageAnswer(req, res);
    const { session, roles } = pageOf(req);
    const parsed = parseQueueQuery(query);
    if (!parsed.ok) {
      await refuse(res, 'invalid_query');
      return;
    }
    const { limit, after } = parsed.value;
    const rows = await this.repository.pendingApprovals({
      roles,
      excludeRequester: session.subject,
      ...(after === undefined ? {} : { after }),
      limit: limit + 1,
    });
    const now = Date.now();
    const operations = this.configuration.current.policy.operations;
    const page = rows.slice(0, limit);
    // The cursor follows the query's order, so it is taken before expired rows are dropped.
    const last = page.at(-1);
    const live = page.filter((cs) => cs.status === 'pending_approval' && cs.expiresAt.getTime() > now);
    // One approvals read per row (at most 100 per page, indexed by change-set).
    const items = await Promise.all(
      live.map(async (cs) => {
        const approvals = await this.repository.approvals(cs.id, cs.approvalRound);
        const operation = operations.find((op) => op.id === cs.operation);
        return {
          id: cs.id,
          operation: cs.operation,
          title: operation?.title ?? cs.operation,
          requester: cs.requester,
          total: cs.stats.total,
          step: currentStep(cs, approvals) ?? 1,
          steps: cs.approvalPlan?.steps.length ?? 0,
          ...(cs.submission === undefined ? {} : { submittedAt: cs.submission.at.toISOString() }),
          expiresAt: cs.expiresAt.toISOString(),
        };
      }),
    );
    res.status(200).json({
      items,
      ...(rows.length > limit && last?.submission !== undefined ? { next: encodeQueueCursor({ submittedAt: last.submission.at, id: last.id }) } : {}),
    });
  }
}
