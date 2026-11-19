/**
 * Audit actions (AUD-1), once each. Runtime list for the audit search query parser (AUD-6).
 * Later phases extend it.
 */
export const AUDIT_ACTIONS = [
  'tool.call',
  'tools.list',
  'policy.decision',
  'auth.rejected',
  'auth.login',
  'auth.logout',
  'credential.set',
  'credential.rotate',
  'connection.test',
  'changeset.transition',
  'changeset.batch',
  'task.cancel',
  'approval.requested',
  'approval.decision',
  'changeset.start',
  'changeset.export',
  'changeset.submit',
  'changeset.exclude',
  'changeset.rollback',
  'notification.sent',
  'notification.failed',
  'audit.search',
  'audit.export',
  'audit.retention',
  'config.apply',
  'config.load',
  'upstream.pin',
] as const;

export type AuditAction = (typeof AUDIT_ACTIONS)[number];

export type AuditOutcome = 'ok' | 'error' | 'denied';

/** Policy decision attached to an event (POL-8, from Phase 2). */
export type AuditDecision = 'allow' | 'deny';

/** One audit event as handed to the audit log. The store adds sequence, timestamp and chain hashes. */
export interface AuditEventInput {
  readonly id: string;
  readonly actor: string;
  readonly clientId?: string;
  readonly action: AuditAction;
  readonly subject?: string;
  readonly decision?: AuditDecision;
  readonly outcome: AuditOutcome;
  readonly correlationId: string;
  readonly changesetId?: string;
  /** Structured, non-sensitive context. Never credentials, tokens or call arguments (SEC-3). */
  readonly details: Readonly<Record<string, unknown>>;
}

/** Append-only audit log port (AUD-3). Implemented in `@aiops/db`. */
export interface AuditLog {
  append(event: AuditEventInput): Promise<void>;
}
