import { desc, sql } from 'drizzle-orm';
import type {
  ApplyRevisionResult,
  AuditEventInput,
  ConfigListener,
  ConfigRevision,
  ConfigRevisionStore,
  NewConfigRevision,
} from '@aiops/core';
import { DrizzleAuditLog } from './audit-log.js';
import type { Db, DbExecutor } from './client.js';
import { guarded } from './errors.js';
import { CONFIG_LOCK_KEY } from './locks.js';
import { configRevision } from './schema.js';

/** The LISTEN/NOTIFY channel of applied revisions (CFG-3); the payload is the new `seq` as text. */
export const CONFIG_CHANNEL = 'aiops_config';

export interface PostgresConfigRevisionStoreOptions {
  readonly databaseUrl: string;
  /** Listener reconnect delay (defaults 1000 and 30000). */
  readonly backoff?: { readonly initialMs: number; readonly maxMs: number };
}

const REVISION_COLUMNS = {
  seq: configRevision.seq,
  id: configRevision.id,
  hash: configRevision.hash,
  files: configRevision.files,
  source: configRevision.source,
  actor: configRevision.actor,
  appliedAt: configRevision.appliedAt,
  summary: configRevision.summary,
} as const;

/** The first statement of every writing transaction: serialises bootstrap and apply across instances (NFR-3). */
async function lock(tx: DbExecutor): Promise<void> {
  await tx.execute(sql`SELECT pg_advisory_xact_lock(${CONFIG_LOCK_KEY.toString()}::bigint)`);
}

async function activeOf(db: Db | DbExecutor): Promise<ConfigRevision | undefined> {
  const [row] = await db.select(REVISION_COLUMNS).from(configRevision).orderBy(desc(configRevision.seq)).limit(1);
  return row;
}

/**
 * PostgreSQL implementation of the core `ConfigRevisionStore` port (CFG-4). Append-only table
 * `config_revision`; the active revision is the highest `seq`. `bootstrap` and `apply` each run in
 * one transaction under the advisory lock `CONFIG_LOCK_KEY`, so the revision, its audit row and
 * the notification commit together or not at all. Failures leave as fixed messages with the
 * SQLSTATE only (SEC-3): drizzle's error would quote file text and the actor.
 */
export class PostgresConfigRevisionStore implements ConfigRevisionStore {
  constructor(
    private readonly db: Db,
    private readonly options: PostgresConfigRevisionStoreOptions,
  ) {}

  async active(): Promise<ConfigRevision | undefined> {
    return guarded('config revision read', () => activeOf(this.db));
  }

  async activeSeq(): Promise<number | undefined> {
    const [row] = await guarded('config revision read', () =>
      this.db.select({ seq: sql<string | null>`max(${configRevision.seq})` }).from(configRevision),
    );
    // max(bigint) arrives as text (or null on an empty table).
    return row?.seq === null || row?.seq === undefined ? undefined : Number(row.seq);
  }

  async bootstrap(revision: Omit<NewConfigRevision, 'actor'>): Promise<ConfigRevision> {
    return guarded('config bootstrap', () =>
      this.db.transaction(async (tx) => {
        await lock(tx);
        const existing = await activeOf(tx);
        if (existing !== undefined) return existing;
        const [row] = await tx
          .insert(configRevision)
          .values({ ...revisionValues({ ...revision, actor: 'system' }), source: 'bootstrap' })
          .returning(REVISION_COLUMNS);
        if (row === undefined) throw new Error('config bootstrap returned no row');
        return row;
      }),
    );
  }

  async apply(revision: NewConfigRevision, audit: AuditEventInput, expectedPreviousHash: string | null): Promise<ApplyRevisionResult> {
    return guarded('config apply', () =>
      this.db.transaction(async (tx): Promise<ApplyRevisionResult> => {
        await lock(tx);
        const activeHash = (await activeOf(tx))?.hash ?? null;
        if (activeHash !== expectedPreviousHash) return { ok: false, reason: 'concurrent_apply' };
        if (activeHash === revision.hash) return { ok: false, reason: 'unchanged' };
        const [row] = await tx
          .insert(configRevision)
          .values({ ...revisionValues(revision), source: 'apply' })
          .returning(REVISION_COLUMNS);
        if (row === undefined) throw new Error('config apply returned no row');
        // On the transaction: a failing append rolls the revision back (AUD-1). No sensitive
        // keys: the details carry hashes and counts only, and the key-pattern backstop applies.
        await new DrizzleAuditLog(tx).append(audit);
        // Last statement: delivered to listeners only when the transaction commits (CFG-3).
        await tx.execute(sql`SELECT pg_notify(${CONFIG_CHANNEL}, ${String(row.seq)})`);
        return { ok: true, revision: row };
      }),
    );
  }

  /** The dedicated-client listener on `options.databaseUrl` follows in Task 4. */
  listen(): Promise<ConfigListener> {
    return Promise.reject(new Error('not implemented'));
  }
}

function revisionValues(revision: NewConfigRevision): {
  id: string;
  hash: string;
  files: Record<string, string>;
  actor: string;
  summary: NewConfigRevision['summary'];
} {
  return { id: revision.id, hash: revision.hash, files: { ...revision.files }, actor: revision.actor, summary: revision.summary };
}
