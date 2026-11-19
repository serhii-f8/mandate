import { createHash } from 'node:crypto';
import { open, readFile, rename, rm, type FileHandle } from 'node:fs/promises';
import path from 'node:path';
import { createInterface } from 'node:readline';
import { CanonicalJsonError, checkLink, GENESIS_HASH, type ChainBreak, type ChainHead, type SealedChainRow } from '@aiops/core';
import type pg from 'pg';
import { CHAIN_COLUMNS, toSealedChainRow } from './audit-chain.js';
import { guarded } from './errors.js';

/** Sealed rows read per page while archiving (design §5). */
export const ARCHIVE_PAGE = 1000;

/**
 * One line of an archive file: every hashed field except `pos`, which is `chainPos`, plus `seq`
 * (decimal text) and both chain hashes (Global Constraints "Archive").
 */
export interface ArchivedRow extends Omit<SealedChainRow, 'pos'> {
  readonly seq: string;
  readonly chainPos: number;
}

export interface ArchiveManifest {
  readonly first: number;
  readonly last: number;
  readonly count: number;
  readonly prevHash: string;
  readonly lastHash: string;
  readonly sha256: string;
  readonly createdAt: string;
}

export type ArchiveReport =
  | { readonly ok: true; readonly first: number; readonly last: number; readonly count: number }
  | {
      readonly ok: false;
      readonly reason: 'manifest_unreadable' | 'archive_unreadable' | 'sha256_mismatch' | 'count_mismatch' | 'range_mismatch' | 'no_anchor' | ChainBreak;
      readonly chainPos?: number;
    };

export type ArchiveWriteResult =
  | { readonly ok: true; readonly file: string; readonly manifest: ArchiveManifest }
  | { readonly ok: false; readonly chainPos: number; readonly reason: ChainBreak };

const HASH = /^sha256:[0-9a-f]{64}$/;

/** `audit-<first>-<last>`: the shared stem of an archive and its manifest. */
function stem(first: number, last: number): string {
  return `audit-${first}-${last}`;
}

/** The manifest path of an archive path: `….jsonl` → `….manifest.json`. */
function manifestPath(file: string): string {
  return file.endsWith('.jsonl') ? `${file.slice(0, -'.jsonl'.length)}.manifest.json` : `${file}.manifest.json`;
}

/** `checkLink`, with a row whose content cannot be canonicalised counted as a hash mismatch (as verify does). */
function linkBreak(previous: ChainHead, row: SealedChainRow): ChainBreak | undefined {
  try {
    return checkLink(previous, row);
  } catch (error) {
    if (error instanceof CanonicalJsonError) return 'hash_mismatch';
    throw error;
  }
}

function toArchivedRow(row: ReturnType<typeof toSealedChainRow>): ArchivedRow {
  return {
    seq: row.seq,
    chainPos: row.pos,
    id: row.id,
    ts: row.ts,
    actor: row.actor,
    clientId: row.clientId,
    action: row.action,
    subject: row.subject,
    decision: row.decision,
    outcome: row.outcome,
    correlationId: row.correlationId,
    changesetId: row.changesetId,
    details: row.details,
    prevHash: row.prevHash,
    hash: row.hash,
  };
}

/** Writes `bytes`-producing `fill` to `tmp`, fsyncs it and closes it. */
async function writeSynced(tmp: string, fill: (handle: FileHandle) => Promise<void>): Promise<void> {
  const handle = await open(tmp, 'w', 0o600);
  try {
    await fill(handle);
    await handle.sync();
  } finally {
    await handle.close();
  }
}

/**
 * Steps 6–7 of the retention job (design §5, AUD-7): streams the sealed rows `(start.pos, last]` in
 * `chain_pos` order, one REPEATABLE READ snapshot, checking every link from `start`; writes
 * `audit-<first>-<last>.jsonl` and its manifest each to `.<name>.tmp`, fsyncs and renames them.
 * The first break returns before any rename, and every `.tmp` file opened is removed on a break
 * or an error (ruling T8/F7). An existing archive of the same name is replaced (a rerun after a
 * crash between archive and delete). `options.now` stamps `createdAt` (default: the wall clock).
 * Errors carry no row content (SEC-3).
 */
export async function writeAuditArchive(
  pool: pg.Pool,
  dir: string,
  start: ChainHead,
  last: number,
  options?: { readonly now?: () => Date },
): Promise<ArchiveWriteResult> {
  if (!Number.isSafeInteger(last) || last <= start.pos) throw new Error('archive range is empty');
  const first = start.pos + 1;
  const name = stem(first, last);
  const file = path.join(dir, `${name}.jsonl`);
  const manifestFile = path.join(dir, `${name}.manifest.json`);
  const tmpFile = path.join(dir, `.${name}.jsonl.tmp`);
  const tmpManifest = path.join(dir, `.${name}.manifest.json.tmp`);
  let renamed = false;
  try {
    const digest = createHash('sha256');
    let previous = start;
    let count = 0;
    let broken: { chainPos: number; reason: ChainBreak } | undefined;
    await writeSynced(tmpFile, async (handle) => {
      broken = await streamRange(pool, start, last, async (row) => {
        const line = `${JSON.stringify(toArchivedRow(row))}\n`;
        digest.update(line, 'utf8');
        await handle.write(line, null, 'utf8');
        // streamRange only passes rows whose link checked, so the hash is non-null.
        previous = { pos: row.pos, hash: row.hash ?? '' };
        count += 1;
      });
    });
    if (broken !== undefined) return { ok: false, ...broken };
    const manifest: ArchiveManifest = {
      first,
      last,
      count,
      prevHash: start.hash,
      lastHash: previous.hash,
      sha256: `sha256:${digest.digest('hex')}`,
      createdAt: (options?.now ?? (() => new Date()))().toISOString(),
    };
    await writeSynced(tmpManifest, async (handle) => {
      await handle.write(`${JSON.stringify(manifest, null, 2)}\n`, null, 'utf8');
    });
    await rename(tmpFile, file);
    await rename(tmpManifest, manifestFile);
    renamed = true;
    // The renames are durable only once the directory entry is.
    const dirHandle = await open(dir, 'r');
    try {
      await dirHandle.sync();
    } finally {
      await dirHandle.close();
    }
    return { ok: true, file, manifest };
  } finally {
    if (!renamed) {
      // Cleanup is best effort: its failure must not mask the error or break that got us here.
      await rm(tmpFile, { force: true }).catch(() => undefined);
      await rm(tmpManifest, { force: true }).catch(() => undefined);
    }
  }
}

/** Calls `onRow` for each linked row of `(start.pos, last]`; the first break, else undefined. */
async function streamRange(
  pool: pg.Pool,
  start: ChainHead,
  last: number,
  onRow: (row: ReturnType<typeof toSealedChainRow>) => Promise<void>,
): Promise<{ chainPos: number; reason: ChainBreak } | undefined> {
  const client = await pool.connect();
  let broken: Error | undefined;
  try {
    await guarded('audit archive', () => client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY'));
    try {
      let previous = start;
      while (previous.pos < last) {
        const page = await guarded('audit archive', () =>
          client.query<Record<string, unknown>>(
            `SELECT ${CHAIN_COLUMNS} FROM audit_event
             WHERE chain_pos IS NOT NULL AND chain_pos > $1 AND chain_pos <= $2 ORDER BY chain_pos LIMIT $3`,
            [String(previous.pos), String(last), ARCHIVE_PAGE],
          ),
        );
        // Rows missing up to `last` (none left in the range) are a gap at the next position.
        if (page.rows.length === 0) return { chainPos: previous.pos + 1, reason: 'gap' };
        for (const raw of page.rows) {
          const row = toSealedChainRow(raw);
          const reason = linkBreak(previous, row);
          if (reason !== undefined) return { chainPos: row.pos, reason };
          if (row.hash === null) return { chainPos: row.pos, reason: 'hash_mismatch' };
          await onRow(row);
          previous = { pos: row.pos, hash: row.hash };
        }
      }
      return undefined;
    } finally {
      try {
        await client.query('ROLLBACK');
      } catch (rollbackError) {
        broken = rollbackError instanceof Error ? rollbackError : new Error('rollback failed');
      }
    }
  } finally {
    // A connection whose rollback failed is discarded, never returned to the pool mid-transaction.
    client.release(broken);
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

const isPosition = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value >= 1;
const isHash = (value: unknown): value is string => typeof value === 'string' && HASH.test(value);
const isText = (value: unknown): value is string => typeof value === 'string';
const isNullableText = (value: unknown): value is string | null => value === null || typeof value === 'string';

function parseManifest(text: string): ArchiveManifest | undefined {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch (error) {
    if (error instanceof SyntaxError) return undefined;
    throw error;
  }
  if (!isRecord(value)) return undefined;
  const { first, last, count, prevHash, lastHash, sha256, createdAt } = value;
  if (!isPosition(first) || !isPosition(last) || !isPosition(count) || last < first) return undefined;
  if (!isHash(prevHash) || !isHash(lastHash) || !isHash(sha256) || !isText(createdAt)) return undefined;
  return { first, last, count, prevHash, lastHash, sha256, createdAt };
}

/** One archive line as a sealed row (`chainPos` back to `pos`); undefined when it is not one. */
function parseLine(line: string): (SealedChainRow & { readonly prevHash: string; readonly hash: string }) | undefined {
  let value: unknown;
  try {
    value = JSON.parse(line);
  } catch (error) {
    if (error instanceof SyntaxError) return undefined;
    throw error;
  }
  if (!isRecord(value)) return undefined;
  const v = value;
  if (!isText(v.seq) || !isPosition(v.chainPos) || !isHash(v.prevHash) || !isHash(v.hash)) return undefined;
  if (!isText(v.id) || !isText(v.ts) || !isText(v.actor) || !isText(v.action) || !isText(v.outcome) || !isText(v.correlationId)) {
    return undefined;
  }
  if (!isNullableText(v.clientId) || !isNullableText(v.subject) || !isNullableText(v.decision) || !isNullableText(v.changesetId)) {
    return undefined;
  }
  if (!('details' in v)) return undefined;
  return {
    pos: v.chainPos,
    id: v.id,
    ts: v.ts,
    actor: v.actor,
    clientId: v.clientId,
    action: v.action,
    subject: v.subject,
    decision: v.decision,
    outcome: v.outcome,
    correlationId: v.correlationId,
    changesetId: v.changesetId,
    details: v.details,
    prevHash: v.prevHash,
    hash: v.hash,
  };
}

/**
 * `aiops audit verify --archive <file>` (design §3, AUD-5, AUD-7). Checks in order: the manifest
 * next to `file` parses; the archive opens (else `archive_unreadable`); the file's SHA-256 is the manifest's; the line count is the manifest's;
 * the first and last positions are the manifest's range; the chain inside links from the
 * manifest's `prevHash` and ends at its `lastHash`; and the database holds the anchors at both
 * ends: genesis or an anchor at `first − 1` with `prevHash`, and an anchor at `last` with
 * `lastHash` and the file's SHA-256 (else `no_anchor`, as for an orphan of a crashed run). The
 * archive is read once as a stream, so memory stays bounded whatever its size. The report
 * carries positions only, never row content (SEC-3).
 */
export async function verifyAuditArchive(pool: pg.Pool, file: string): Promise<ArchiveReport> {
  let manifest: ArchiveManifest | undefined;
  try {
    manifest = parseManifest(await readFile(manifestPath(file), 'utf8'));
  } catch (error) {
    if (!isFsError(error)) throw error;
    manifest = undefined;
  }
  if (manifest === undefined) return { ok: false, reason: 'manifest_unreadable' };
  let handle: FileHandle;
  try {
    handle = await open(file, 'r');
  } catch (error) {
    if (!isFsError(error)) throw error;
    return { ok: false, reason: 'archive_unreadable' };
  }
  let scan: Scan;
  try {
    scan = await scanArchive(handle, manifest);
  } finally {
    await handle.close();
  }
  if (scan.sha256 !== manifest.sha256) return { ok: false, reason: 'sha256_mismatch' };
  if (scan.lines !== manifest.count) return { ok: false, reason: 'count_mismatch' };
  if (scan.unparsable !== undefined) return { ok: false, reason: 'hash_mismatch', chainPos: scan.unparsable };
  if (scan.firstPos !== manifest.first || scan.lastPos !== manifest.last || manifest.last - manifest.first + 1 !== manifest.count) {
    return { ok: false, reason: 'range_mismatch' };
  }
  if (scan.broken !== undefined) return { ok: false, ...scan.broken };
  if (scan.head.hash !== manifest.lastHash) return { ok: false, reason: 'hash_mismatch', chainPos: manifest.last };
  if (!(await anchored(pool, manifest))) return { ok: false, reason: 'no_anchor' };
  return { ok: true, first: manifest.first, last: manifest.last, count: manifest.count };
}

/** An error the file system raised (it carries a string `code`, such as ENOENT or EACCES). */
function isFsError(error: unknown): boolean {
  return isRecord(error) && typeof error.code === 'string';
}

/** What one pass over an archive found; each finding is the first of its kind. */
interface Scan {
  readonly sha256: string;
  readonly lines: number;
  /** Expected position of the first line that is not an archived row. */
  readonly unparsable: number | undefined;
  readonly firstPos: number | undefined;
  readonly lastPos: number | undefined;
  readonly broken: { readonly chainPos: number; readonly reason: ChainBreak } | undefined;
  /** The last row whose link checked. */
  readonly head: ChainHead;
}

/**
 * Reads the archive once in bounded memory: hashes the bytes as they stream, and checks each line's
 * link as it is read, keeping only the findings `verifyAuditArchive` ranks.
 */
async function scanArchive(handle: FileHandle, manifest: ArchiveManifest): Promise<Scan> {
  const digest = createHash('sha256');
  const input = handle.createReadStream({ autoClose: false });
  input.on('data', (chunk) => digest.update(chunk));
  const reader = createInterface({ input, crlfDelay: Infinity });
  let lines = 0;
  let unparsable: number | undefined;
  let firstPos: number | undefined;
  let lastPos: number | undefined;
  let broken: Scan['broken'];
  let head: ChainHead = { pos: manifest.first - 1, hash: manifest.prevHash };
  for await (const line of reader) {
    lines += 1;
    if (unparsable !== undefined) continue;
    const row = parseLine(line);
    if (row === undefined) {
      unparsable = manifest.first + lines - 1;
      continue;
    }
    firstPos ??= row.pos;
    lastPos = row.pos;
    if (broken !== undefined) continue;
    const reason = linkBreak(head, row);
    if (reason === undefined) head = { pos: row.pos, hash: row.hash };
    else broken = { chainPos: row.pos, reason };
  }
  return { sha256: `sha256:${digest.digest('hex')}`, lines, unparsable, firstPos, lastPos, broken, head };
}

/** True when the database's anchors fix both ends of the archive. */
async function anchored(pool: pg.Pool, manifest: ArchiveManifest): Promise<boolean> {
  const end = await guarded('audit archive verify', () =>
    pool.query('SELECT 1 FROM audit_anchor WHERE chain_pos = $1 AND hash = $2 AND sha256 = $3 AND count = $4', [
      String(manifest.last),
      manifest.lastHash,
      manifest.sha256,
      String(manifest.count),
    ]),
  );
  if (end.rowCount !== 1) return false;
  if (manifest.first === 1) return manifest.prevHash === GENESIS_HASH;
  const start = await guarded('audit archive verify', () =>
    pool.query('SELECT 1 FROM audit_anchor WHERE chain_pos = $1 AND hash = $2', [String(manifest.first - 1), manifest.prevHash]),
  );
  return start.rowCount === 1;
}

/** The one output line of `aiops audit verify --archive` (Global Constraints); positions only. */
export function formatArchiveReport(report: ArchiveReport): string {
  if (report.ok) return `ok archive count=${report.count} first=${report.first} last=${report.last}`;
  return `failed archive reason=${report.reason}${report.chainPos === undefined ? '' : ` chain_pos=${report.chainPos}`}`;
}
