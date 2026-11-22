// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Mandate Authors
import { desc, sql } from 'drizzle-orm';
import pg from 'pg';
import type {
  ApplyRevisionResult,
  AuditEventInput,
  ConfigListener,
  ConfigListenerHandlers,
  ConfigRevision,
  ConfigRevisionStore,
  NewConfigRevision,
} from '@mandate/core';
import { DrizzleAuditLog } from './audit-log.js';
import type { Db, DbExecutor } from './client.js';
import { guarded } from './errors.js';
import { CONFIG_LOCK_KEY } from './locks.js';
import { configRevision } from './schema.js';

/** The LISTEN/NOTIFY channel of applied revisions (CFG-3); the payload is the new `seq` as text. */
export const CONFIG_CHANNEL = 'mandate_config';

/** The listener's `application_name`, so operators and tests can find its backend. */
export const CONFIG_LISTENER_APPLICATION_NAME = 'mandate-config-listener';

/** The only text `onError` and a failed first `listen` carry: driver errors may quote the host or user (SEC-3). */
const LISTENER_FAILED = 'configuration listener connection failed';

const DEFAULT_BACKOFF = { initialMs: 1_000, maxMs: 30_000 } as const;
const LISTENER_CONNECT_TIMEOUT_MS = 5_000;

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

  /**
   * CFG-3: one dedicated `pg.Client` on `options.databaseUrl` (not a pool connection) runs
   * `LISTEN mandate_config`. Resolves once the first LISTEN succeeded and rejects when it fails.
   * On `error` or `end` it reports `onError` and reconnects after the back-off delay, doubling up
   * to the maximum; a successful LISTEN resets the delay and reports `onReconnect`.
   */
  async listen(handlers: ConfigListenerHandlers): Promise<ConfigListener> {
    const listener = new ConfigChannelListener(this.options.databaseUrl, this.options.backoff ?? DEFAULT_BACKOFF, handlers);
    await listener.start();
    return listener;
  }
}

class ConfigChannelListener implements ConfigListener {
  /** The client whose LISTEN succeeded and has not failed yet; its first error or end schedules one reconnect. */
  private live: pg.Client | undefined;
  private timer: NodeJS.Timeout | undefined;
  private delayMs: number;
  private closed = false;

  constructor(
    private readonly databaseUrl: string,
    private readonly backoff: { readonly initialMs: number; readonly maxMs: number },
    private readonly handlers: ConfigListenerHandlers,
  ) {
    this.delayMs = backoff.initialMs;
  }

  async start(): Promise<void> {
    if (!(await this.connect())) throw new Error(LISTENER_FAILED);
  }

  async close(): Promise<void> {
    this.closed = true;
    if (this.timer !== undefined) clearTimeout(this.timer);
    this.timer = undefined;
    const client = this.live;
    this.live = undefined;
    if (client !== undefined) await client.end().catch(() => undefined);
  }

  /** One attempt: true when LISTEN succeeded and the client is live. */
  private async connect(): Promise<boolean> {
    const client = new pg.Client({
      connectionString: this.databaseUrl,
      application_name: CONFIG_LISTENER_APPLICATION_NAME,
      connectionTimeoutMillis: LISTENER_CONNECT_TIMEOUT_MS,
      keepAlive: true,
    });
    // Always attached: an 'error' without a listener would crash the process.
    client.on('error', () => { this.failed(client); });
    client.on('end', () => { this.failed(client); });
    client.on('notification', (message) => {
      if (this.live === client && message.channel === CONFIG_CHANNEL) this.handlers.onChange();
    });
    try {
      await client.connect();
      await client.query(`LISTEN ${CONFIG_CHANNEL}`);
    } catch {
      await client.end().catch(() => undefined);
      return false;
    }
    if (this.closed) {
      await client.end().catch(() => undefined);
      return false;
    }
    this.live = client;
    this.delayMs = this.backoff.initialMs;
    return true;
  }

  /** The live client broke: report once, drop it and schedule one reconnect, however many events it emits. */
  private failed(client: pg.Client): void {
    if (this.closed || this.live !== client) return;
    this.live = undefined;
    client.end().catch(() => undefined);
    this.handlers.onError(LISTENER_FAILED);
    this.schedule();
  }

  private schedule(): void {
    if (this.closed) return;
    const delay = this.delayMs;
    this.delayMs = Math.min(this.delayMs * 2, this.backoff.maxMs);
    this.timer = setTimeout(() => {
      this.timer = undefined;
      void this.reconnect();
    }, delay);
    this.timer.unref();
  }

  private async reconnect(): Promise<void> {
    if (await this.connect()) {
      this.handlers.onReconnect();
      return;
    }
    if (this.closed) return;
    this.handlers.onError(LISTENER_FAILED);
    this.schedule();
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
