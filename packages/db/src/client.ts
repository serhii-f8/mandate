import { drizzle, type NodePgDatabase } from 'drizzle-orm/node-postgres';
import pg from 'pg';
import * as schema from './schema.js';

export type Db = NodePgDatabase<typeof schema>;

export interface Database {
  readonly db: Db;
  readonly pool: pg.Pool;
  close(): Promise<void>;
}

export interface CreateDbOptions {
  /**
   * Receives errors of idle pooled connections (for example when PostgreSQL
   * restarts). Without a listener such an error would crash the process. The
   * error message carries no connection string.
   */
  readonly onError: (error: Error) => void;
}

/** Bounds so an unreachable or stuck database fails a request quickly instead of hanging it. */
const CONNECTION_TIMEOUT_MS = 5_000;
const STATEMENT_TIMEOUT_MS = 15_000;

export function createDb(databaseUrl: string, options: CreateDbOptions): Database {
  const pool = new pg.Pool({
    connectionString: databaseUrl,
    connectionTimeoutMillis: CONNECTION_TIMEOUT_MS,
    statement_timeout: STATEMENT_TIMEOUT_MS,
    query_timeout: STATEMENT_TIMEOUT_MS + 1_000,
  });
  pool.on('error', options.onError);
  return {
    db: drizzle(pool, { schema }),
    pool,
    close: () => pool.end(),
  };
}
