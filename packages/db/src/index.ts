/** PostgreSQL persistence: Drizzle schema, SQL migrations, migrator and repository implementations. */
export { DrizzleAuditLog } from './audit-log.js';
export { PostgresCredentialVault } from './credential-vault.js';
export { openSealed, rewrap, seal, type SealedCredential } from './envelope.js';
export { parseMasterKeys, type KeyProvider } from './keyring.js';
export { createDb, type Database, type Db } from './client.js';
export { MIGRATION_LOCK_KEY, runMigrations } from './migrate.js';
export { auditEvent, credential, webLogin, webSession } from './schema.js';
