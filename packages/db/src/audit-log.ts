// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The AI Operations Layer Authors
import { redactAuditDetails, type AuditEventInput, type AuditLog } from '@aiops/core';
import type { Db, DbExecutor } from './client.js';
import { guarded } from './errors.js';
import { auditEvent } from './schema.js';

const NO_KEYS: ReadonlySet<string> = new Set();

export interface AuditLogOptions {
  /** The configuration's `sensitive_fields` (AUD-4), read on every append so a reload applies. */
  readonly sensitiveKeys?: () => ReadonlySet<string>;
}

/**
 * PostgreSQL implementation of the core `AuditLog` port. Insert only (AUD-3). Built on a
 * transaction, its appends are part of that transaction. A failure leaves as a fixed message
 * with the SQLSTATE only: drizzle's error quotes the actor, correlation ID and details (SEC-3).
 * Details are redacted before the insert (AUD-4): the credential key pattern and value shapes
 * always, plus `sensitiveKeys` when given (a log built on a transaction inside this package
 * has none; ADR 0043, R3). Details that cannot be redacted (a cycle) fail closed: the append
 * rejects with `AuditRedactionError` and nothing is stored.
 */
export class DrizzleAuditLog implements AuditLog {
  constructor(
    private readonly db: Db | DbExecutor,
    private readonly options: AuditLogOptions = {},
  ) {}

  async append(event: AuditEventInput): Promise<void> {
    // Outside `guarded`: an AuditRedactionError leaves as itself, before any statement runs.
    const details = redactAuditDetails(event.details, this.options.sensitiveKeys?.() ?? NO_KEYS);
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
        details,
      });
    });
  }
}
