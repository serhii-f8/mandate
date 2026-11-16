import { bigint, index, jsonb, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core';

/**
 * Audit base table (AUD-1). Append-only: a trigger added by migration
 * `0001_audit_event_append_only` rejects UPDATE, DELETE and TRUNCATE (AUD-3).
 * `prev_hash` and `hash` are filled by the hash chain of Phase 8.
 */
export const auditEvent = pgTable(
  'audit_event',
  {
    seq: bigint('seq', { mode: 'bigint' }).primaryKey().generatedAlwaysAsIdentity(),
    id: uuid('id').notNull().unique(),
    ts: timestamp('ts', { withTimezone: true }).notNull().defaultNow(),
    actor: text('actor').notNull(),
    clientId: text('client_id'),
    action: text('action').notNull(),
    subject: text('subject'),
    decision: text('decision'),
    outcome: text('outcome').notNull(),
    correlationId: text('correlation_id').notNull(),
    changesetId: uuid('changeset_id'),
    details: jsonb('details').$type<Record<string, unknown>>().notNull().default({}),
    prevHash: text('prev_hash'),
    hash: text('hash'),
  },
  (t) => [
    index('audit_event_ts_idx').on(t.ts),
    index('audit_event_correlation_id_idx').on(t.correlationId),
    index('audit_event_changeset_id_idx').on(t.changesetId),
  ],
);
