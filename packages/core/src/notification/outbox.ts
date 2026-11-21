// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The AI Operations Layer Authors
import type { NotificationKind } from '../approval/model.js';
import type { AuditEventInput } from '../audit.js';

export type NotificationState = 'pending' | 'sent' | 'failed';

/** The closed list of failure codes; the only content of `last_error`, audit and logs (SEC-3). */
export type NotificationError =
  | 'channel_unconfigured'
  | 'target_unknown'
  | 'credential_missing'
  | 'credential_unusable'
  | 'host_not_allowed'
  | 'egress_denied'
  | 'timeout'
  | 'network'
  | 'http_status'
  | 'smtp_rejected'
  | 'internal';

export interface NotificationRow {
  readonly id: string;
  readonly kind: NotificationKind;
  readonly changesetId: string;
  readonly round: number;
  readonly step: number;
  readonly target: string;
  readonly state: NotificationState;
  readonly attempts: number;
  readonly nextAttemptAt: Date;
  readonly lastError?: NotificationError;
  readonly createdAt: Date;
  readonly sentAt?: Date;
}

/** NTF-3 delivery port. Every mark is fenced by `attempt` (= `attempts` returned by the claim) and `state = 'pending'`; false when fenced. */
export interface NotificationOutbox {
  /** Due pending rows (`next_attempt_at <= now`), oldest due first, at most `limit`; each gets attempts + 1 and next_attempt_at = now + leaseMs. */
  claim(req: { now: Date; limit: number; leaseMs: number }): Promise<readonly NotificationRow[]>;
  /** state sent, sent_at = now, and `audit` in one transaction. */
  markSent(req: { id: string; attempt: number; now: Date; audit: AuditEventInput }): Promise<boolean>;
  markRetry(req: { id: string; attempt: number; error: NotificationError; nextAttemptAt: Date }): Promise<boolean>;
  /** state failed, last_error, and `audit` in one transaction. */
  markFailed(req: { id: string; attempt: number; error: NotificationError; audit: AuditEventInput }): Promise<boolean>;
  /** Ordered by created_at, kind, step, target. */
  listFor(changesetId: string): Promise<readonly NotificationRow[]>;
}

export const NOTIFICATION_DISPATCH_INTERVAL_MS = 5_000;
export const NOTIFICATION_CLAIM_LIMIT = 20;
export const NOTIFICATION_LEASE_MS = 120_000;
export const NOTIFICATION_MAX_ATTEMPTS = 8;

const BASE_DELAY_MS = 30_000;
const MAX_DELAY_MS = 3_600_000;

/** Delay after the `attempts`-th failed attempt: min(30 s x 2^(attempts-1), 1 h) (NTF-3). */
export function retryDelayMs(attempts: number): number {
  const exponent = Math.min(Math.max(attempts, 1) - 1, 20);
  return Math.min(BASE_DELAY_MS * 2 ** exponent, MAX_DELAY_MS);
}

export function afterFailure(
  attempts: number,
): { kind: 'retry'; delayMs: number } | { kind: 'failed' } {
  return attempts >= NOTIFICATION_MAX_ATTEMPTS
    ? { kind: 'failed' }
    : { kind: 'retry', delayMs: retryDelayMs(attempts) };
}

/** One audit event per final outcome, never per retry (AUD-1). */
export function notificationAuditEvent(input: {
  id: string;
  row: NotificationRow;
  outcome: 'sent' | 'failed';
  error?: NotificationError;
  correlationId: string;
}): AuditEventInput {
  const { row } = input;
  return {
    id: input.id,
    actor: 'system',
    action: input.outcome === 'sent' ? 'notification.sent' : 'notification.failed',
    subject: row.target,
    outcome: input.outcome === 'sent' ? 'ok' : 'error',
    correlationId: input.correlationId,
    changesetId: row.changesetId,
    details: {
      kind: row.kind,
      target: row.target,
      attempts: row.attempts,
      ...(input.outcome === 'failed' && input.error !== undefined ? { error: input.error } : {}),
    },
  };
}
