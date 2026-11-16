import { drizzle, type NodePgDatabase } from 'drizzle-orm/node-postgres';
import pg from 'pg';
import * as schema from './schema.js';

export type Db = NodePgDatabase<typeof schema>;

export interface Database {
  readonly db: Db;
  readonly pool: pg.Pool;
  close(): Promise<void>;
}

export function createDb(databaseUrl: string): Database {
  const pool = new pg.Pool({ connectionString: databaseUrl });
  return {
    db: drizzle(pool, { schema }),
    pool,
    close: () => pool.end(),
  };
}
