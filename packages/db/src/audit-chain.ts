import { auditRowHash, GENESIS_HASH, type ChainHead, type ChainRow, type SealedChainRow } from '@aiops/core';
import type pg from 'pg';
import { guarded } from './errors.js';
import { AUDIT_SEAL_LOCK_KEY } from './locks.js';

/** Rows sealed per transaction (design §2). */
export const SEAL_BATCH = 500;

export interface SealResult {
  readonly sealed: number;
  readonly locked: boolean;
}

/**
 * SELECT list of `audit_event` giving the `SealedChainRow` fields plus `seq`, for `toSealedChainRow`.
 * Integers come as decimal text, `ts` as the microsecond UTC form the row hash uses (AUD-3), and
 * `details` as `pg` parses jsonb. Shared by the sealer, verify, retention and search.
 */
export const CHAIN_COLUMNS = [
  'seq::text AS seq',
  'chain_pos::text AS pos',
  'id::text AS id',
  `to_char(ts AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS ts`,
  'actor',
  'client_id AS "clientId"',
  'action',
  'subject',
  'decision',
  'outcome',
  'correlation_id AS "correlationId"',
  'changeset_id::text AS "changesetId"',
  'details',
  'prev_hash AS "prevHash"',
  'hash',
].join(', ');

type Queryable = Pick<pg.PoolClient, 'query'>;

function text(row: Record<string, unknown>, key: string): string {
  const value = row[key];
  if (typeof value !== 'string') throw new Error(`audit row column ${key} is not text`);
  return value;
}

function nullableText(row: Record<string, unknown>, key: string): string | null {
  const value = row[key];
  if (value === null) return null;
  if (typeof value !== 'string') throw new Error(`audit row column ${key} is not text`);
  return value;
}

/**
 * A non-negative bigint column (a chain position or a count) read as decimal text, as a JS number;
 * refuses anything else and values beyond the safe range. Shared by the chain readers.
 */
export function safeInteger(value: string, what: string): number {
  const n = Number(value);
  if (!/^[0-9]+$/.test(value) || !Number.isSafeInteger(n)) throw new Error(`${what} is not a safe non-negative integer`);
  return n;
}

/**
 * The hashed fields except `pos`, plus `seq`, of a row selected with `CHAIN_COLUMNS`. Shared by the
 * chain readers and the audit search reader.
 */
export function chainFields(row: Record<string, unknown>): Omit<ChainRow, 'pos'> & { readonly seq: string } {
  return {
    seq: text(row, 'seq'),
    id: text(row, 'id'),
    ts: text(row, 'ts'),
    actor: text(row, 'actor'),
    clientId: nullableText(row, 'clientId'),
    action: text(row, 'action'),
    subject: nullableText(row, 'subject'),
    decision: nullableText(row, 'decision'),
    outcome: text(row, 'outcome'),
    correlationId: text(row, 'correlationId'),
    changesetId: nullableText(row, 'changesetId'),
    details: row.details,
  };
}

/** A sealed row selected with `CHAIN_COLUMNS`; throws for a row the sealer has not reached. */
export function toSealedChainRow(row: Record<string, unknown>): SealedChainRow & { readonly seq: string } {
  return {
    ...chainFields(row),
    pos: safeInteger(text(row, 'pos'), 'chain_pos'),
    prevHash: nullableText(row, 'prevHash'),
    hash: nullableText(row, 'hash'),
  };
}

/** Highest sealed row, else newest anchor, else `{ pos: 0, hash: GENESIS_HASH }` (design §2). */
export async function chainHead(client: Queryable): Promise<ChainHead> {
  const sealed = await client.query<{ pos: string; hash: string | null }>(
    'SELECT chain_pos::text AS pos, hash FROM audit_event WHERE chain_pos IS NOT NULL ORDER BY chain_pos DESC LIMIT 1',
  );
  const anchor =
    sealed.rows[0] ??
    (await client.query<{ pos: string; hash: string }>(
      'SELECT chain_pos::text AS pos, hash FROM audit_anchor ORDER BY chain_pos DESC LIMIT 1',
    )).rows[0];
  if (anchor === undefined) return { pos: 0, hash: GENESIS_HASH };
  // The trigger only lets a row gain chain_pos together with a non-null hash.
  if (anchor.hash === null) throw new Error('chain head has no hash');
  return { pos: safeInteger(anchor.pos, 'chain head'), hash: anchor.hash };
}

/**
 * One sealing transaction (design §2, AUD-3). Inserts never wait on it: rows are written unchained
 * and this assigns the next positions, in `seq` order among the rows committed so far, linking each
 * to the one before. A transaction-scoped try-lock serialises sealers (NFR-4); `locked: false`
 * means another sealer holds it and nothing was done. Errors leave without row content (SEC-3).
 */
export async function sealAuditChain(pool: pg.Pool, options?: { readonly batchSize?: number }): Promise<SealResult> {
  const batchSize = options?.batchSize ?? SEAL_BATCH;
  if (!Number.isSafeInteger(batchSize) || batchSize < 1) throw new Error('batchSize must be a positive integer');
  const client = await pool.connect();
  let broken: Error | undefined;
  try {
    return await guarded('audit seal', async () => {
      await client.query('BEGIN');
      try {
        const lock = await client.query<{ locked: boolean }>('SELECT pg_try_advisory_xact_lock($1) AS locked', [
          AUDIT_SEAL_LOCK_KEY.toString(),
        ]);
        if (lock.rows[0]?.locked !== true) {
          await client.query('ROLLBACK');
          return { sealed: 0, locked: false };
        }
        await client.query("SELECT set_config('aiops.audit_seal', 'on', true)");
        const head = await chainHead(client);
        // Qualified: a bare `seq` would bind to the `seq::text` output column and sort as text.
        const pending = await client.query<Record<string, unknown>>(
          `SELECT ${CHAIN_COLUMNS} FROM audit_event WHERE chain_pos IS NULL ORDER BY audit_event.seq LIMIT $1`,
          [batchSize],
        );
        if (pending.rows.length === 0) {
          await client.query('COMMIT');
          return { sealed: 0, locked: true };
        }
        const params: string[] = [];
        const tuples: string[] = [];
        let prev = head.hash;
        let pos = head.pos;
        for (const raw of pending.rows) {
          const { seq, ...fields } = chainFields(raw);
          pos += 1;
          const hash = auditRowHash({ ...fields, pos }, prev);
          const n = params.length;
          tuples.push(`($${n + 1}::bigint, $${n + 2}::bigint, $${n + 3}::text, $${n + 4}::text)`);
          params.push(seq, String(pos), prev, hash);
          prev = hash;
        }
        const updated = await client.query(
          `UPDATE audit_event a SET chain_pos = v.pos, prev_hash = v.prev, hash = v.hash
           FROM (VALUES ${tuples.join(', ')}) AS v(seq, pos, prev, hash) WHERE a.seq = v.seq`,
          params,
        );
        // Fail closed: every selected row must have been sealed, or the chain would skip a position.
        if (updated.rowCount !== pending.rows.length) throw new Error('audit seal updated an unexpected row count');
        await client.query('COMMIT');
        return { sealed: pending.rows.length, locked: true };
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
