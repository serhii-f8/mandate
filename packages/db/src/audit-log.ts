import type { AuditEventInput, AuditLog } from '@aiops/core';
import type { Db } from './client.js';
import { auditEvent } from './schema.js';

/** PostgreSQL implementation of the core `AuditLog` port. Insert only (AUD-3). */
export class DrizzleAuditLog implements AuditLog {
  constructor(private readonly db: Db) {}

  async append(event: AuditEventInput): Promise<void> {
    await this.db.insert(auditEvent).values({
      id: event.id,
      actor: event.actor,
      clientId: event.clientId ?? null,
      action: event.action,
      subject: event.subject ?? null,
      decision: event.decision ?? null,
      outcome: event.outcome,
      correlationId: event.correlationId,
      changesetId: event.changesetId ?? null,
      details: { ...event.details },
    });
  }
}
