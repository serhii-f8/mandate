// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Mandate Authors
/** PostgreSQL persistence: Drizzle schema, SQL migrations, migrator and repository implementations. */
export { DrizzleAuditLog, type AuditLogOptions } from './audit-log.js';
export { CHAIN_COLUMNS, chainHead, SEAL_BATCH, sealAuditChain, toSealedChainRow, type SealResult } from './audit-chain.js';
export {
  ARCHIVE_PAGE,
  formatArchiveReport,
  verifyAuditArchive,
  writeAuditArchive,
  type ArchivedRow,
  type ArchiveManifest,
  type ArchiveReport,
  type ArchiveWriteResult,
} from './audit-archive.js';
export { runAuditRetention, type RetentionDeps, type RetentionReport } from './audit-retention.js';
export { PostgresAuditReader } from './audit-search.js';
export { countChangeSetsByStatus } from './metrics-queries.js';
export { formatVerifyReport, VERIFY_PAGE, verifyAuditChain, type VerifyReport } from './audit-verify.js';
export { AUDIT_RETENTION_LOCK_KEY, AUDIT_SEAL_LOCK_KEY, CONFIG_LOCK_KEY, FILE_STAGE_LOCK_NAMESPACE, START_LOCK_NAMESPACE } from './locks.js';
export { CONFIG_CHANNEL, PostgresConfigRevisionStore, type PostgresConfigRevisionStoreOptions } from './config-revision-store.js';
export { PostgresChangeSetRepository, type PostgresChangeSetRepositoryOptions } from './changeset-repository.js';
export { insertNotifications, PostgresNotificationOutbox } from './notification-outbox.js';
export { PostgresCredentialVault } from './credential-vault.js';
export { PostgresFileStore } from './file-store.js';
export { PostgresTaskRepository } from './task-repository.js';
export { PostgresRateCounter } from './rate-counter.js';
export { PostgresSessionStore, type LoginRow, type SessionRow } from './web-sessions.js';
export type { SealedCredential } from './envelope.js';
export { parseMasterKeys, type KeyProvider } from './keyring.js';
export { createDb, type Database, type Db, type DbExecutor } from './client.js';
export { MIGRATION_LOCK_KEY, assertMigrated, migrationState, runMigrations } from './migrate.js';
export {
  auditAnchor,
  auditEvent,
  changeBatch,
  changeItem,
  changeSet,
  changeSetFile,
  credential,
  mcpTask,
  notificationOutbox,
  rateBucket,
  stagedFile,
  webLogin,
  webSession,
} from './schema.js';
