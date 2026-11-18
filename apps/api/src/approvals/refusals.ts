/**
 * One status per refusal reason, shared by the decision and start routes (SEC-11), and the helper
 * that audits a refusal before answering it (AUD-1).
 */
import { randomUUID } from 'node:crypto';
import type { Response } from 'express';
import type { AuditAction, AuditEventInput, AuditLog, DecisionRefusal } from '@aiops/core';
import { CHANGESET_ID } from './page-query.js';

export type PageRefusal =
  | DecisionRefusal
  | 'csrf'
  | 'reauthentication_required'
  | 'forbidden'
  | 'invalid_body'
  | 'not_approved_status'
  | 'not_permitted'
  | 'not_approved'
  | 'limit_exceeded'
  | 'executor_unavailable'
  | 'not_executable'
  | 'invalid_query'
  | 'not_prepared'
  | 'approval_unroutable'
  | 'empty_request'
  | 'unknown_items'
  | 'nothing_left'
  | 'policy_denied';

export const REFUSAL_STATUS: Readonly<Record<PageRefusal, 400 | 403 | 404 | 409>> = {
  not_found: 404,
  csrf: 403,
  reauthentication_required: 403,
  forbidden: 403,
  not_approver: 403,
  separation_of_duties: 403,
  widget_not_allowed: 403,
  step_up_required: 403,
  not_permitted: 403,
  expired: 409,
  not_pending: 409,
  hash_mismatch: 409,
  count_mismatch: 409,
  not_approved: 409,
  not_approved_status: 409,
  limit_exceeded: 409,
  executor_unavailable: 409,
  not_executable: 409,
  invalid_body: 400,
  invalid_query: 400,
  comment_required: 400,
  comment_invalid: 400,
  not_prepared: 409,
  approval_unroutable: 409,
  empty_request: 409,
  unknown_items: 409,
  nothing_left: 409,
  policy_denied: 403,
};

/** Non-sensitive fields a refusal answer adds beside `error`, e.g. a count or a limit name (SEC-3). */
export type RefusalExtra = Readonly<Record<string, string | number>>;

/** Audits (when `audit` given) then answers `{ error: reason, ...extra }`; an audit failure propagates (500), nothing is sent. */
export async function refuse(
  res: Response,
  reason: PageRefusal,
  audit?: { log: AuditLog; event: AuditEventInput },
  extra?: RefusalExtra,
): Promise<void> {
  if (audit !== undefined) await audit.log.append(audit.event);
  res.status(REFUSAL_STATUS[reason]).json({ error: reason, ...extra });
}

/**
 * Audits a refusal the page route finds itself, under the route's action, then answers it (AUD-1).
 * `extra` goes to the answer only, never to the audit row.
 */
export type Refuser = (reason: PageRefusal, extra?: RefusalExtra) => Promise<void>;

/**
 * The refuser of the Phase 7 page routes: one `denied` row of `action` with
 * `details: { reason, channel: 'page' }`, written before the answer (SEC-11). `details` adds
 * further non-sensitive context; it never replaces `reason` or `channel` (SEC-3).
 */
export function pageRefuser(o: {
  audit: AuditLog;
  action: AuditAction;
  viewer: { readonly subject: string; readonly clientId: string };
  /** The raw path value; only a UUID-shaped one is recorded as the change-set. */
  id: string;
  correlationId: string;
  res: Response;
  details?: Readonly<Record<string, unknown>>;
}): Refuser {
  const changesetId = CHANGESET_ID.test(o.id) ? o.id.toLowerCase() : undefined;
  return (reason, extra) =>
    refuse(
      o.res,
      reason,
      {
        log: o.audit,
        event: {
          id: randomUUID(),
          actor: o.viewer.subject,
          clientId: o.viewer.clientId,
          action: o.action,
          outcome: 'denied',
          correlationId: o.correlationId,
          ...(changesetId === undefined ? {} : { changesetId, subject: changesetId }),
          details: { ...o.details, reason, channel: 'page' },
        },
      },
      // The answer's extra fields never reach the audit row.
      extra,
    );
}
