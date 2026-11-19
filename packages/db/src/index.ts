/** PostgreSQL persistence: Drizzle schema, SQL migrations, migrator and repository implementations. */
export { DrizzleAuditLog } from './audit-log.js';
export { PostgresChangeSetRepository, type PostgresChangeSetRepositoryOptions } from './changeset-repository.js';
export { insertNotifications, PostgresNotificationOutbox } from './notification-outbox.js';
export { PostgresCredentialVault } from './credential-vault.js';
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
  credential,
  mcpTask,
  notificationOutbox,
  rateBucket,
  webLogin,
  webSession,
} from './schema.js';
