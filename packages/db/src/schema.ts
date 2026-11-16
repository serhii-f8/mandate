import { bigint, boolean, customType, index, integer, jsonb, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core';

const bytea = customType<{ data: Buffer; driverData: Buffer }>({
  dataType: () => 'bytea',
});

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

/**
 * Envelope-encrypted upstream credentials (SEC-2, ADR 0019). Plaintext and data keys are
 * never stored; see `envelope.ts` for the AAD bindings.
 */
export const credential = pgTable('credential', {
  ref: text('ref').primaryKey(),
  scheme: text('scheme').notNull(),
  ciphertext: bytea('ciphertext').notNull(),
  nonce: bytea('nonce').notNull(),
  wrappedKey: bytea('wrapped_key').notNull(),
  keyNonce: bytea('key_nonce').notNull(),
  keyVersion: integer('key_version').notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  updatedBy: text('updated_by').notNull(),
});

/** Single-use OIDC login state for trusted pages (AUTH-5). Keyed by the SHA-256 of `state`. */
export const webLogin = pgTable('web_login', {
  stateHash: text('state_hash').primaryKey(),
  codeVerifier: text('code_verifier').notNull(),
  nonce: text('nonce').notNull(),
  returnTo: text('return_to').notNull(),
  fresh: boolean('fresh').notNull(),
  expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
});

/** Trusted-page sessions shared by every `api` instance (NFR-3). Keyed by the SHA-256 of the cookie. */
export const webSession = pgTable(
  'web_session',
  {
    idHash: text('id_hash').primaryKey(),
    subject: text('subject').notNull(),
    username: text('username'),
    clientId: text('client_id').notNull(),
    groups: jsonb('groups').$type<string[]>().notNull(),
    authTime: timestamp('auth_time', { withTimezone: true }).notNull(),
    csrfToken: text('csrf_token').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
  },
  (t) => [index('web_session_expires_at_idx').on(t.expiresAt)],
);
