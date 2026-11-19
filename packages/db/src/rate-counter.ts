import { lt, sql } from 'drizzle-orm';
import type { RateCounter } from '@aiops/core';
import { guarded } from './errors.js';
import type { Db } from './client.js';
import { rateBucket } from './schema.js';

/**
 * Fixed-window counters in `rate_bucket` (POL-4 calls_per_minute). One upsert-and-return statement:
 * parallel hits of one key and window get distinct counts. Errors carry codes only (SEC-3), as the
 * key names a caller.
 */
export class PostgresRateCounter implements RateCounter {
  constructor(private readonly db: Db) {}

  async hit(key: string, windowStart: Date): Promise<number> {
    const [row] = await guarded('rate counter hit', () =>
      this.db
        .insert(rateBucket)
        .values({ key, windowStart, count: 1 })
        .onConflictDoUpdate({
          target: [rateBucket.key, rateBucket.windowStart],
          set: { count: sql`${rateBucket.count} + 1` },
        })
        .returning({ count: rateBucket.count }),
    );
    if (row === undefined) throw new Error('rate counter upsert returned no row');
    return row.count;
  }

  /** Deletes every bucket whose window started before `before` (AUD-7 retention job); the number deleted. */
  async prune(before: Date): Promise<number> {
    const result = await guarded('rate counter prune', () => this.db.delete(rateBucket).where(lt(rateBucket.windowStart, before)));
    return result.rowCount ?? 0;
  }
}
