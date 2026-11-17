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
import type { ChangeSetStats, ChangeSetStatus, ExclusionReason, ItemStatus, PlanEntry, TaskKind } from '@aiops/core';

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
    // Upstream HTTP status of a failed preparation read (a number only, SEC-3).
    errorStatus: integer('error_status'),
    configHash: text('config_hash').notNull(),
    correlationId: text('correlation_id').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull(),
    preparedAt: timestamp('prepared_at', { withTimezone: true }),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
    // Execution request (POL-6) and cancel request (EXE-7): each group is written once, fixed by
    // migration `0006_execution_guards`.
    executionActor: text('execution_actor'),
    executionGroups: jsonb('execution_groups').$type<string[]>(),
    executionClientId: text('execution_client_id'),
    executionCorrelationId: text('execution_correlation_id'),
    executionStartedAt: timestamp('execution_started_at', { withTimezone: true }),
    cancelRequestedBy: text('cancel_requested_by'),
    cancelCorrelationId: text('cancel_correlation_id'),
    cancelRequestedAt: timestamp('cancel_requested_at', { withTimezone: true }),
  },
  (t) => [
    index('change_set_requester_created_at_idx').on(t.requester, t.createdAt),
    index('change_set_requester_status_idx').on(t.requester, t.status),
    index('change_set_requester_execution_started_at_idx').on(t.requester, t.executionStartedAt),
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

/**
 * Write batches of an execution (EXE-3). One row per batch attempt; a `done` row is frozen by
 * migration `0006_execution_guards`. `last_target` is `COLLATE "C"` (set by that migration) so it
 * compares by code point like `target_id`. `plan` holds target IDs, actions and codes, no values.
 */
export const changeBatch = pgTable(
  'change_batch',
  {
    changesetId: uuid('changeset_id')
      .notNull()
      .references(() => changeSet.id),
    batchNo: integer('batch_no').notNull(),
    attempt: integer('attempt').notNull(),
    state: text('state').$type<'open' | 'done'>().notNull(),
    targetIds: jsonb('target_ids').$type<string[]>().notNull(),
    lastTarget: text('last_target').notNull(),
    upstreamBatchId: text('upstream_batch_id'),
    plan: jsonb('plan').$type<PlanEntry[]>(),
    written: integer('written').notNull().default(0),
    failed: integer('failed').notNull().default(0),
    skipped: integer('skipped').notNull().default(0),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    primaryKey({ columns: [t.changesetId, t.batchNo] }),
    check('change_batch_state_check', sql`${t.state} IN ('open', 'done')`),
  ],
);

/**
 * MCP Tasks (MCP-7): binds a task ID to its owner and change-set; the task state is derived from
 * the change-set. Looked up by `(task_id, owner)` so a foreign ID is indistinguishable from an unknown one.
 */
export const mcpTask = pgTable(
  'mcp_task',
  {
    taskId: uuid('task_id').primaryKey(),
    owner: text('owner').notNull(),
    clientId: text('client_id'),
    changesetId: uuid('changeset_id')
      .notNull()
      .references(() => changeSet.id),
    kind: text('kind').$type<TaskKind>().notNull(),
    tool: text('tool').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull(),
    ttlMs: integer('ttl_ms').notNull(),
  },
  (t) => [
    index('mcp_task_task_id_owner_idx').on(t.taskId, t.owner),
    check('mcp_task_kind_check', sql`${t.kind} IN ('prepare', 'execute')`),
  ],
);

/** Fixed-window counters for operation rate limits (POL-4). */
export const rateBucket = pgTable(
  'rate_bucket',
  {
    key: text('key').notNull(),
    windowStart: timestamp('window_start', { withTimezone: true }).notNull(),
    count: integer('count').notNull(),
  },
  (t) => [primaryKey({ columns: [t.key, t.windowStart] })],
);
