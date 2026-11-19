/**
 * The requester's actions on the trusted page (UI-3, CS-5, EXE-8): submit a prepared change-set,
 * derive a new one with exclusions, and roll an executed one back. Submit and exclusions use the
 * services of the MCP tools (`SubmitService`, `excludeItems`), so one request yields one outcome on
 * either channel (MCP-8); the rollback uses the one eligibility function of `core` (design §2).
 * Checks in the fixed order of SEC-8: ID shape and requester (404) → Origin + CSRF (403) → fresh
 * login, for the rollback only (403) → body (400) → the service. Every refusal writes one audit row
 * of the route's action first (AUD-1, SEC-11); rows carry counts and change-set IDs only, never
 * target IDs or hashes (SEC-3).
 */
import { randomUUID } from 'node:crypto';
import { Body, Controller, Inject, Param, Post, Req, Res } from '@nestjs/common';
import type { Response } from 'express';
import type { Logger } from 'pino';
import type { z } from 'zod';
import type { ApiEnv, ConfigurationHolder } from '@aiops/config';
import {
  ExecutorUnavailable,
  isExpiryDue,
  rollbackEligibility,
  type AuditAction,
  type AuditLog,
  type Caller,
  type ChangeSetExecutor,
  type ChangeSetRecord,
  type ChangeSetRepository,
  type ChangeSetStatus,
  type DeriveRefusal,
  type RollbackRequestOutcome,
  type WorkflowStarter,
} from '@aiops/core';
import { pageAnswer } from '../approvals/changeset-pages.controller.js';
import { CHANGESET_ID, exclusionBodySchema, rollbackBodySchema, submitBodySchema } from '../approvals/page-query.js';
import { pageRefuser, type Refuser } from '../approvals/refusals.js';
import { snapshotOf } from '../mcp/tool-pipeline.js';
import { API_ENV, AUDIT_LOG, CHANGESET_EXECUTOR, CHANGESET_REPOSITORY, CONFIGURATION, LOGGER, PAGE_CHECKS, SUBMIT_SERVICE, WORKFLOW_STARTER } from '../tokens.js';
import { PageAccess, pageDenial, pageOf, type PageChecks, type PageRequest } from '../web/access.js';
import { pageCorrelation } from '../web/correlation.js';
import { excludeItems } from './exclusions.js';
import { eligibilityDeps } from './rollback.js';
import type { SubmitOutcome, SubmitService } from './submit-service.js';

/** A request that passed the checks before the service. */
interface Checked<T> {
  readonly changeset: ChangeSetRecord;
  readonly caller: Caller & { readonly clientId: string };
  readonly correlationId: string;
  readonly refuser: Refuser;
  /** The route's refuser with further non-sensitive audit details (SEC-3). */
  readonly refuserWith: (details: Readonly<Record<string, unknown>>) => Refuser;
  readonly body: T;
}

/** A change-set that is not (or no longer) `prepared`: an expired one reads as expired, as on the decision route. */
const notPrepared = (status: ChangeSetStatus): 'expired' | 'not_prepared' => (status === 'expired' ? 'expired' : 'not_prepared');

@Controller('api/v1/changesets')
export class ChangeSetActionsController {
  constructor(
    @Inject(CHANGESET_REPOSITORY) private readonly repository: ChangeSetRepository,
    @Inject(PAGE_CHECKS) private readonly checks: PageChecks,
    @Inject(AUDIT_LOG) private readonly audit: AuditLog,
    @Inject(SUBMIT_SERVICE) private readonly submitter: SubmitService,
    @Inject(WORKFLOW_STARTER) private readonly starter: WorkflowStarter,
    @Inject(CHANGESET_EXECUTOR) private readonly executor: ChangeSetExecutor,
    @Inject(CONFIGURATION) private readonly configuration: ConfigurationHolder,
    @Inject(API_ENV) private readonly env: ApiEnv,
    @Inject(LOGGER) private readonly logger: Logger,
  ) {}

  /**
   * The checks every action runs before its service, in the SEC-8 order; on a refusal the audited
   * answer is already sent and the result is undefined. `fresh` adds the fresh-login check after
   * CSRF (SEC-8).
   */
  private async check<T>(
    req: PageRequest,
    res: Response,
    id: string,
    action: AuditAction,
    schema: z.ZodType<T>,
    body: unknown,
    o: { readonly fresh?: boolean } = {},
  ): Promise<Checked<T> | undefined> {
    pageAnswer(req, res);
    const correlationId = pageCorrelation(req, res);
    const { session } = pageOf(req);
    const refuserWith = (details: Readonly<Record<string, unknown>>): Refuser =>
      pageRefuser({ audit: this.audit, action, viewer: session, id, correlationId, res, details });
    const refuser = pageRefuser({ audit: this.audit, action, viewer: session, id, correlationId, res });
    // 1. Unknown, foreign and malformed IDs look the same (SEC-1); approvers do not act for the requester.
    const changeset = CHANGESET_ID.test(id) ? await this.repository.get(id) : undefined;
    if (changeset?.requester !== session.subject) {
      await refuser('not_found');
      return undefined;
    }
    // 2. Origin + CSRF, then 3. a fresh login when the action asks for it (SEC-8).
    const denial = pageDenial(req.headers, session, { csrf: true, fresh: o.fresh === true }, this.checks);
    if (denial !== undefined) {
      await refuser(denial);
      return undefined;
    }
    // 4. The body.
    const parsed = schema.safeParse(body);
    if (!parsed.success) {
      await refuser('invalid_body');
      return undefined;
    }
    const caller = { subject: session.subject, groups: session.groups, clientId: session.clientId, authTime: session.authTime };
    return { changeset, caller, correlationId, refuser, refuserWith, body: parsed.data };
  }

  /** The `ok` row of a successful action, written before the answer (AUD-1). */
  private audited(action: AuditAction, c: Checked<unknown>, details: Readonly<Record<string, unknown>>): Promise<void> {
    return this.audit.append({
      id: randomUUID(),
      actor: c.caller.subject,
      clientId: c.caller.clientId,
      action,
      outcome: 'ok',
      correlationId: c.correlationId,
      changesetId: c.changeset.id,
      subject: c.changeset.id,
      details,
    });
  }

  /**
   * Submits a prepared change-set (UI-3, MCP-8): it starts, or goes to approval (POL-5). Only
   * `prepared` is accepted here: an approved change-set is started on `POST :id/start`, which needs
   * a fresh login (ruling F3).
   */
  @Post(':id/submit')
  @PageAccess()
  async submit(@Req() req: PageRequest, @Res() res: Response, @Param('id') id: string, @Body() body: unknown): Promise<void> {
    const c = await this.check(req, res, id, 'changeset.submit', submitBodySchema, body);
    if (c === undefined) return;
    const { changeset, refuser } = c;
    if (changeset.status !== 'prepared') {
      await refuser(isExpiryDue(changeset, new Date()) ? 'expired' : notPrepared(changeset.status));
      return;
    }
    const outcome = await this.submitter.submit({
      caller: c.caller,
      correlationId: c.correlationId,
      changesetId: changeset.id,
      hash: c.body.hash,
      snapshot: snapshotOf(this.configuration.current),
      // Re-checked by the service on the row it reads, so a change-set approved meanwhile is not started (F3).
      statuses: ['prepared'],
    });
    await this.answerSubmit(c, res, outcome);
  }

  private async answerSubmit(c: Checked<unknown>, res: Response, outcome: SubmitOutcome): Promise<void> {
    const { refuser } = c;
    switch (outcome.kind) {
      case 'started':
        await this.audited('changeset.submit', c, { channel: 'page', status: 'executing' });
        res.status(200).json({ status: 'executing' });
        return;
      case 'pending_approval': {
        await this.audited('changeset.submit', c, { channel: 'page', status: 'pending_approval' });
        const url = new URL(`/app/changesets/${outcome.changeset.id}`, this.env.publicUrl).href;
        res.status(200).json({ status: 'pending_approval', approval: { step: 1, steps: outcome.plan.steps, url } });
        return;
      }
      case 'refused':
        break;
    }
    switch (outcome.reason) {
      case 'wrong_status':
      case 'not_prepared':
        return refuser(notPrepared(outcome.status));
      case 'start_refused': {
        const { refusal } = outcome;
        return refusal.reason === 'limit_exceeded' ? refuser('limit_exceeded', { limit: refusal.limit }) : refuser(refusal.reason);
      }
      case 'audit_unavailable':
        // The decision row could not be written: nothing was changed, and no answer without its row (500).
        throw new Error('audit log unavailable');
      case 'not_found':
      case 'hash_mismatch':
      case 'expired':
      case 'approval_unroutable':
      case 'executor_unavailable':
      case 'policy_denied':
        return refuser(outcome.reason);
    }
  }

  /** Derives a new change-set without the excluded items, or with re-included ones (CS-5); the source stays unchanged. */
  @Post(':id/exclusions')
  @PageAccess()
  async exclude(@Req() req: PageRequest, @Res() res: Response, @Param('id') id: string, @Body() body: unknown): Promise<void> {
    const c = await this.check(req, res, id, 'changeset.exclude', exclusionBodySchema, body);
    if (c === undefined) return;
    const exclude = c.body.exclude ?? [];
    const include = c.body.include ?? [];
    const outcome = await excludeItems(
      {
        repository: this.repository,
        starter: this.starter,
        newId: randomUUID,
        now: () => new Date(),
        // The derived change-set stays prepared; submitting it starts the workflow anyway (signalWithStart).
        onStartFailure: (changesetId, e) => {
          this.logger.warn({ changesetId, err: e instanceof Error ? e.name : 'unknown' }, 'workflow start after derivation failed');
        },
      },
      { sourceId: c.changeset.id, hash: c.body.hash, exclude, include, caller: c.caller, correlationId: c.correlationId },
    );
    if (!outcome.ok) {
      await this.refuseExclusion(c.refuser, outcome);
      return;
    }
    const derived = outcome.changeset;
    const derivedFrom = c.changeset.id;
    await this.audited('changeset.exclude', c, {
      channel: 'page',
      changesetId: derived.id,
      derivedFrom,
      excludeCount: exclude.length,
      includeCount: include.length,
    });
    res.status(201).json({ id: derived.id, hash: derived.hash, stats: derived.stats, derivedFrom });
  }

  private refuseExclusion(refuser: Refuser, refusal: DeriveRefusal): Promise<void> {
    switch (refusal.reason) {
      case 'invalid_request':
        return refuser('invalid_body');
      case 'unknown_items':
        return refuser('unknown_items', { count: refusal.count });
      case 'not_prepared':
        return refuser(notPrepared(refusal.status));
      case 'not_found':
      case 'expired':
      case 'hash_mismatch':
      case 'empty_request':
      case 'nothing_left':
        return refuser(refusal.reason);
    }
  }

  /**
   * Rolls an executed change-set back (EXE-8, UI-4): the only place a rollback starts. Fresh login
   * and CSRF, the shared eligibility check (hash, status, strategy, window, POL-6), then the
   * executor's request. The `ok` rows come from the executor's transaction (ruling R5); this route
   * writes only refusals.
   */
  @Post(':id/rollback')
  @PageAccess()
  async rollback(@Req() req: PageRequest, @Res() res: Response, @Param('id') id: string, @Body() body: unknown): Promise<void> {
    const c = await this.check(req, res, id, 'changeset.rollback', rollbackBodySchema, body, { fresh: true });
    if (c === undefined) return;
    const { changeset, caller, refuser } = c;
    const notRollbackable = (reason: string | undefined): Promise<void> =>
      reason === undefined ? refuser('not_rollbackable') : c.refuserWith({ rollbackReason: reason })('not_rollbackable', { reason });
    const snapshot = snapshotOf(this.configuration.current);
    const e = await rollbackEligibility(eligibilityDeps(this.repository, snapshot, () => new Date()), { changesetId: changeset.id, caller, hash: c.body.hash });
    if (!e.ok) {
      await (e.refusal === 'not_rollbackable' ? notRollbackable(e.reason) : refuser(e.refusal));
      return;
    }
    let outcome: RollbackRequestOutcome;
    try {
      outcome = await this.executor.requestRollback({
        changesetId: changeset.id,
        actor: caller.subject,
        clientId: caller.clientId,
        correlationId: c.correlationId,
        count: e.count,
      });
    } catch (error) {
      // The run could not be described: nothing was changed (ruling R3).
      if (!(error instanceof ExecutorUnavailable)) throw error;
      await refuser('executor_unavailable');
      return;
    }
    if (!outcome.ok) {
      await (outcome.reason === 'not_rollbackable' ? notRollbackable(outcome.detail) : refuser(outcome.reason));
      return;
    }
    res.status(200).json({ status: outcome.status });
  }
}
