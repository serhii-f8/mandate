import { constants } from 'node:fs';
import { access } from 'node:fs/promises';
import path from 'node:path';
import { GENESIS_HASH, type AuditLog, type ChainHead } from '@aiops/core';
import type pg from 'pg';
import { writeAuditArchive } from './audit-archive.js';
import { SEAL_BATCH, sealAuditChain } from './audit-chain.js';
import { guarded } from './errors.js';
import { AUDIT_RETENTION_LOCK_KEY } from './locks.js';
import type { PostgresRateCounter } from './rate-counter.js';

/** `rate_bucket` rows whose window started more than this long ago are pruned on every run. */
const RATE_BUCKET_MAX_AGE_MS = 48 * 60 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;

export type RetentionReport =
  | { readonly kind: 'not_configured' | 'nothing_due' | 'locked'; readonly rateBucketsDeleted: number }
  | { readonly kind: 'refused'; readonly reason: 'archive_unavailable' | 'chain_invalid'; readonly rateBucketsDeleted: number }
  | {
      readonly kind: 'archived';
      readonly first: number;
      readonly last: number;
      readonly count: number;
      readonly archive: string;
      readonly rateBucketsDeleted: number;
    };

export interface RetentionDeps {
  readonly pool: pg.Pool;
  readonly audit: AuditLog;
  /** Prunes `rate_bucket` (ruling T8/F6). */
  readonly rateCounter: Pick<PostgresRateCounter, 'prune'>;
  /** `audit.retention_days`; undefined keeps audit rows forever. */
  readonly retentionDays: number | undefined;
  /** `AIOPS_AUDIT_ARCHIVE_DIR`. */
  readonly archiveDir: string | undefined;
  readonly actor: string;
  readonly now: () => Date;
  readonly newId: () => string;
}

/** A bigint read as decimal text, as a safe JS number. */
function position(value: string, what: string): number {
  const pos = Number(value);
  if (!/^[0-9]+$/.test(value) || !Number.isSafeInteger(pos)) throw new Error(`${what} is not a safe chain position`);
  return pos;
}

async function writable(dir: string): Promise<boolean> {
  try {
    await access(dir, constants.W_OK);
    return true;
  } catch (error) {
    // Only the file-system answer (ENOENT, EACCES, ENOTDIR, ...) means "unavailable".
    if (typeof error === 'object' && error !== null && typeof (error as { code?: unknown }).code === 'string') return false;
    throw error;
  }
}

/**
 * One run of the retention job (design §5, AUD-7), under the session advisory lock
 * `AUDIT_RETENTION_LOCK_KEY` held on one dedicated connection for the whole run: prune
 * `rate_bucket`; seal; find P, the highest sealed position older than the cutoff; archive
 * (anchor + 1 .. P] with every link checked; then, in one transaction with the retention setting
 * on, anchor P and delete the rows up to it. Nothing is deleted unless its archive was written,
 * fsynced and its chain verified. `locked` (another run holds the lock) writes no audit row; the
 * caller logs it (ruling T8/F16). Refusals and successes are audited as `audit.retention`.
 */
export async function runAuditRetention(deps: RetentionDeps): Promise<RetentionReport> {
  const client = await deps.pool.connect();
  let broken: Error | undefined;
  try {
    const lock = await guarded('audit retention', () =>
      client.query<{ locked: boolean }>('SELECT pg_try_advisory_lock($1) AS locked', [AUDIT_RETENTION_LOCK_KEY.toString()]),
    );
    if (lock.rows[0]?.locked !== true) return { kind: 'locked', rateBucketsDeleted: 0 };
    try {
      return await locked(deps, client);
    } finally {
      try {
        await client.query('SELECT pg_advisory_unlock($1)', [AUDIT_RETENTION_LOCK_KEY.toString()]);
      } catch (unlockError) {
        // Discarding the connection ends its session and so releases the lock.
        broken = unlockError instanceof Error ? unlockError : new Error('advisory unlock failed');
      }
    }
  } finally {
    client.release(broken);
  }
}

async function locked(deps: RetentionDeps, client: pg.PoolClient): Promise<RetentionReport> {
  const now = deps.now();
  const rateBucketsDeleted = await deps.rateCounter.prune(new Date(now.getTime() - RATE_BUCKET_MAX_AGE_MS));
  if (deps.retentionDays === undefined) return { kind: 'not_configured', rateBucketsDeleted };

  for (;;) {
    const round = await sealAuditChain(deps.pool);
    if (!round.locked || round.sealed < SEAL_BATCH) break;
  }

  const cutoff = new Date(now.getTime() - deps.retentionDays * DAY_MS);
  const due = await guarded('audit retention', () =>
    client.query<{ p: string | null }>(
      'SELECT max(chain_pos)::text AS p FROM audit_event WHERE chain_pos IS NOT NULL AND ts < $1',
      [cutoff],
    ),
  );
  const anchor = await guarded('audit retention', () =>
    client.query<{ pos: string; hash: string }>(
      'SELECT chain_pos::text AS pos, hash FROM audit_anchor ORDER BY chain_pos DESC LIMIT 1',
    ),
  );
  const newest = anchor.rows[0];
  const start: ChainHead = newest === undefined ? { pos: 0, hash: GENESIS_HASH } : { pos: position(newest.pos, 'anchor'), hash: newest.hash };
  const p = due.rows[0]?.p;
  if (p === null || p === undefined) return { kind: 'nothing_due', rateBucketsDeleted };
  const last = position(p, 'retention cutoff position');
  if (last <= start.pos) return { kind: 'nothing_due', rateBucketsDeleted };

  const dir = deps.archiveDir;
  if (dir === undefined || !(await writable(dir))) {
    await audit(deps, 'error', { reason: 'archive_unavailable' });
    return { kind: 'refused', reason: 'archive_unavailable', rateBucketsDeleted };
  }

  const written = await writeAuditArchive(deps.pool, dir, start, last);
  if (!written.ok) {
    await audit(deps, 'error', { reason: 'chain_invalid', chainPos: written.chainPos });
    return { kind: 'refused', reason: 'chain_invalid', rateBucketsDeleted };
  }
  const { manifest } = written;
  const archive = path.basename(written.file);

  await guarded('audit retention', async () => {
    await client.query('BEGIN');
    try {
      await client.query("SELECT set_config('aiops.audit_retention', 'on', true)");
      await client.query('INSERT INTO audit_anchor (chain_pos, hash, archive, sha256, count) VALUES ($1, $2, $3, $4, $5)', [
        String(manifest.last),
        manifest.lastHash,
        archive,
        manifest.sha256,
        String(manifest.count),
      ]);
      const deleted = await client.query('DELETE FROM audit_event WHERE chain_pos IS NOT NULL AND chain_pos <= $1', [
        String(manifest.last),
      ]);
      // Fail closed: exactly the archived rows go, or nothing does.
      if (deleted.rowCount !== manifest.count) throw new Error('audit retention deleted an unexpected row count');
      await client.query('COMMIT');
    } catch (error) {
      // A failed rollback leaves the transaction aborted: the unlock then fails and the
      // connection is discarded, so the original error is the one that leaves.
      await client.query('ROLLBACK').catch(() => undefined);
      throw error;
    }
  });

  const details = { first: manifest.first, last: manifest.last, count: manifest.count, archive };
  await audit(deps, 'ok', details);
  return { kind: 'archived', ...details, rateBucketsDeleted };
}

async function audit(deps: RetentionDeps, outcome: 'ok' | 'error', details: Readonly<Record<string, unknown>>): Promise<void> {
  await deps.audit.append({
    id: deps.newId(),
    actor: deps.actor,
    action: 'audit.retention',
    outcome,
    correlationId: deps.newId(),
    details,
  });
}
