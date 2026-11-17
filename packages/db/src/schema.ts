import { sql } from 'drizzle-orm';
import {
  bigint,
  boolean,
  check,
  customType,
  index,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uuid,
} from 'drizzle-orm/pg-core';
import type { ChangeSetStats, ChangeSetStatus, ExclusionReason, ItemStatus } from '@aiops/core';

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

/**
 * Change-sets (CS-2, CS-4, CS-6). Immutability after `prepared` is enforced by triggers of
 * migration `0004_change_set_immutability`; status transitions are compare-and-set in the
 * repository and checked in core.
 */
export const changeSet = pgTable(
  'change_set',
  {
    id: uuid('id').primaryKey(),
    operation: text('operation').notNull(),
    connection: text('connection').notNull(),
    requester: text('requester').notNull(),
    clientId: text('client_id'),
    args: jsonb('args').$type<Record<string, unknown>>().notNull(),
    hash: text('hash'),
    status: text('status').$type<ChangeSetStatus>().notNull(),
    stats: jsonb('stats').$type<ChangeSetStats>().notNull(),
    errorCode: text('error_code'),
    configHash: text('config_hash').notNull(),
    correlationId: text('correlation_id').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull(),
    preparedAt: timestamp('prepared_at', { withTimezone: true }),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('change_set_requester_created_at_idx').on(t.requester, t.createdAt),
    check(
      'change_set_status_check',
      sql`${t.status} IN ('preparing', 'prepared', 'pending_approval', 'approved', 'executing', 'completed', 'completed_with_errors', 'failed', 'rejected', 'expired', 'cancelled', 'rolling_back', 'rolled_back')`,
    ),
  ],
);

/**
 * Items of a change-set. `target_id` is `COLLATE "C"` (set by migration
 * `0004_change_set_immutability`, drizzle-kit cannot express it), so the primary key orders
 * by code point like `compareTargetIds` and serves the keyset scans (NFR-7).
 */
export const changeItem = pgTable(
  'change_item',
  {
    changesetId: uuid('changeset_id')
      .notNull()
      .references(() => changeSet.id),
    targetId: text('target_id').notNull(),
    status: text('status').$type<ItemStatus>().notNull(),
    reason: text('reason').$type<ExclusionReason>(),
    before: jsonb('before').$type<unknown>().notNull(),
    after: jsonb('after').$type<unknown>().notNull(),
    error: text('error'),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    primaryKey({ columns: [t.changesetId, t.targetId] }),
    check('change_item_status_check', sql`${t.status} IN ('pending', 'excluded', 'written', 'failed', 'skipped')`),
  ],
);
