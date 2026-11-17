/**
 * One status per refusal reason, shared by the decision and start routes (SEC-11), and the helper
 * that audits a refusal before answering it (AUD-1).
 */
import type { Response } from 'express';
import type { AuditEventInput, AuditLog, DecisionRefusal } from '@aiops/core';

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
  | 'invalid_query';

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
};

/** Audits (when `audit` given) then answers `{ error: reason }`; an audit failure propagates (500), nothing is sent. */
export async function refuse(
  res: Response,
  reason: PageRefusal,
  audit?: { log: AuditLog; event: AuditEventInput },
): Promise<void> {
  if (audit !== undefined) await audit.log.append(audit.event);
  res.status(REFUSAL_STATUS[reason]).json({ error: reason });
}
