import type { AuditEventInput, AuditLog } from '@aiops/core';
import type { Db, DbExecutor } from './client.js';
import { guarded } from './errors.js';
import { auditEvent } from './schema.js';

/**
 * PostgreSQL implementation of the core `AuditLog` port. Insert only (AUD-3). Built on a
 * transaction, its appends are part of that transaction. A failure leaves as a fixed message
 * with the SQLSTATE only: drizzle's error quotes the actor, correlation ID and details (SEC-3).
 */
export class DrizzleAuditLog implements AuditLog {
  constructor(private readonly db: Db | DbExecutor) {}

  async append(event: AuditEventInput): Promise<void> {
    await guarded('audit append', async () => {
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
    });
  }
}
