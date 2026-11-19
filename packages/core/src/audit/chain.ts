import { createHash } from 'node:crypto';
import { canonicalJson } from '../changeset/canonical.js';

/** Format tag hashed into every sealed audit row (AUD-3). Changing it breaks every existing chain. */
export const AUDIT_CHAIN_FORMAT = 'aiops.audit.v1';

/** `prev` of the first row of a chain. */
export const GENESIS_HASH = `sha256:${'0'.repeat(64)}`;

/** The hashed content of one audit row. An absent optional column is `null`; `ts` is microsecond UTC ISO. */
export interface ChainRow {
  readonly pos: number;
  readonly id: string;
  readonly ts: string;
  readonly actor: string;
  readonly clientId: string | null;
  readonly action: string;
  readonly subject: string | null;
  readonly decision: string | null;
  readonly outcome: string;
  readonly correlationId: string;
  readonly changesetId: string | null;
  readonly details: unknown;
}

/** A row as stored: `prevHash` and `hash` are null until the sealer reaches it. */
export interface SealedChainRow extends ChainRow {
  readonly prevHash: string | null;
  readonly hash: string | null;
}

export interface ChainHead {
  readonly pos: number;
  readonly hash: string;
}

export type ChainBreak = 'gap' | 'prev_mismatch' | 'hash_mismatch';

/**
 * `sha256:<hex>` over the canonical JSON of the 12 named row fields plus `v` and `prev` (AUD-3).
 * The input is built field by field, never spread, so extra properties (`prevHash`, `hash`, `seq`,
 * `chainPos`) never enter the hash.
 */
export function auditRowHash(row: ChainRow, prev: string): string {
  const input = {
    v: AUDIT_CHAIN_FORMAT,
    prev,
    pos: row.pos,
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
  };
  return `sha256:${createHash('sha256').update(canonicalJson(input), 'utf8').digest('hex')}`;
}

/** Checks in order gap → prev_mismatch → hash_mismatch; undefined when the row links to `previous` (AUD-5). */
export function checkLink(previous: ChainHead, row: SealedChainRow): ChainBreak | undefined {
  if (row.pos !== previous.pos + 1) return 'gap';
  if (row.prevHash !== previous.hash) return 'prev_mismatch';
  if (row.hash === null || row.hash !== auditRowHash(row, previous.hash)) return 'hash_mismatch';
  return undefined;
}
