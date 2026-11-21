// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The AI Operations Layer Authors
import type { Database } from './client.js';
import { guarded } from './errors.js';

/** `SELECT status, count(*) FROM change_set GROUP BY status` (NFR-12): counts only, no row content. */
export function countChangeSetsByStatus(database: Database): Promise<ReadonlyMap<string, number>> {
  return guarded('change-set counts', async () => {
    const result = await database.pool.query<{ status: string; n: string }>(
      'SELECT status, count(*)::text AS n FROM change_set GROUP BY status',
    );
    const counts = new Map<string, number>();
    for (const row of result.rows) {
      const n = Number(row.n);
      if (!Number.isSafeInteger(n)) throw new Error('change-set count is not a safe integer');
      counts.set(row.status, n);
    }
    return counts;
  });
}
