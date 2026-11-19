import { CanonicalJsonError, checkLink, GENESIS_HASH, type ChainBreak, type ChainHead } from '@aiops/core';
import type pg from 'pg';
import { CHAIN_COLUMNS, safeInteger, toSealedChainRow } from './audit-chain.js';
import { guarded } from './errors.js';

/** Sealed rows read per page (design §3). */
export const VERIFY_PAGE = 1000;

export type VerifyReport =
  | { readonly ok: true; readonly sealed: number; readonly unsealed: number; readonly from: number; readonly head: ChainHead }
  | { readonly ok: false; readonly chainPos: number; readonly reason: ChainBreak };

/** `checkLink`, with a row whose content cannot be canonicalised counted as a hash mismatch (ruling T7). */
function linkBreak(previous: ChainHead, row: ReturnType<typeof toSealedChainRow>): ChainBreak | undefined {
  try {
    return checkLink(previous, row);
  } catch (error) {
    if (error instanceof CanonicalJsonError) return 'hash_mismatch';
    throw error;
  }
}

/**
 * Walks the sealed chain from the newest anchor (or genesis) in `chain_pos` order and reports the
 * first break: gap, then prev_mismatch, then hash_mismatch per row (design §3, AUD-5). Read-only,
 * in one REPEATABLE READ snapshot so every page sees the same chain. The report carries positions
 * and hashes only, never row content (SEC-3).
 */
export async function verifyAuditChain(pool: pg.Pool, options?: { readonly pageSize?: number }): Promise<VerifyReport> {
  const pageSize = options?.pageSize ?? VERIFY_PAGE;
  if (!Number.isSafeInteger(pageSize) || pageSize < 1) throw new Error('pageSize must be a positive integer');
  const client = await pool.connect();
  let broken: Error | undefined;
  try {
    return await guarded('audit verify', async () => {
      await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
      try {
        const report = await walk(client, pageSize);
        await client.query('COMMIT');
        return report;
      } catch (error) {
        try {
          await client.query('ROLLBACK');
        } catch (rollbackError) {
          broken = rollbackError instanceof Error ? rollbackError : new Error('rollback failed');
        }
        throw error;
      }
    });
  } finally {
    // A connection whose rollback failed is discarded, never returned to the pool mid-transaction.
    client.release(broken);
  }
}

async function walk(client: pg.PoolClient, pageSize: number): Promise<VerifyReport> {
  const anchor = (
    await client.query<{ pos: string; hash: string }>(
      'SELECT chain_pos::text AS pos, hash FROM audit_anchor ORDER BY chain_pos DESC LIMIT 1',
    )
  ).rows[0];
  const start: ChainHead = anchor === undefined ? { pos: 0, hash: GENESIS_HASH } : { pos: safeInteger(anchor.pos, 'anchor'), hash: anchor.hash };
  let previous = start;
  let sealed = 0;
  for (;;) {
    const page = await client.query<Record<string, unknown>>(
      `SELECT ${CHAIN_COLUMNS} FROM audit_event WHERE chain_pos IS NOT NULL AND chain_pos > $1 ORDER BY chain_pos LIMIT $2`,
      [String(previous.pos), pageSize],
    );
    for (const raw of page.rows) {
      const row = toSealedChainRow(raw);
      const reason = linkBreak(previous, row);
      if (reason !== undefined) return { ok: false, chainPos: row.pos, reason };
      // Type narrowing only: checkLink already returned hash_mismatch for a null hash, so this never fires.
      if (row.hash === null) return { ok: false, chainPos: row.pos, reason: 'hash_mismatch' };
      previous = { pos: row.pos, hash: row.hash };
      sealed += 1;
    }
    if (page.rows.length < pageSize) break;
  }
  const unsealed = await client.query<{ count: string }>(
    'SELECT count(*)::text AS count FROM audit_event WHERE chain_pos IS NULL',
  );
  return {
    ok: true,
    sealed,
    unsealed: safeInteger(unsealed.rows[0]?.count ?? '0', 'unsealed count'),
    from: start.pos + 1,
    head: previous,
  };
}

/** The one output line of `aiops audit verify` (Global Constraints); positions and hashes only. */
export function formatVerifyReport(report: VerifyReport): string {
  if (report.ok) {
    return `ok sealed=${report.sealed} unsealed=${report.unsealed} from=${report.from} head=${report.head.pos}:${report.head.hash}`;
  }
  return `failed chain_pos=${report.chainPos} reason=${report.reason}`;
}
