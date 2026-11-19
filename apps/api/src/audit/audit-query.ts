/**
 * Query-string parsing for the audit search and export routes (AUD-6, NFR-8). Every value is
 * checked here so a malformed query is a 400, never a database error: only strings are accepted
 * (an array is a repeated parameter, an object is what qs builds from `actor[a]=1`), unknown keys
 * are refused, text filters have bounded length and no control characters, dates must round-trip
 * through `toISOString`, and the cursor is a canonical `seq` within PostgreSQL's bigint range.
 */
import { AUDIT_ACTIONS, type AuditAction, type AuditOutcome, type AuditSearchFilter } from '@aiops/core';
import { CHANGESET_ID, decodeCursor, encodeItemCursor, type Parsed } from '../approvals/page-query.js';

export interface AuditQuery {
  readonly filter: AuditSearchFilter;
  /** The filter keys of the query, sorted; recorded on the `audit.search` row instead of values. */
  readonly filterNames: readonly string[];
  readonly limit: number;
  /** Decimal `seq`: only rows older than it are answered. */
  readonly beforeSeq?: string;
}

const FILTER_KEYS = ['actor', 'action', 'outcome', 'changeset', 'correlation', 'from', 'to'] as const;
const PAGE_KEYS = ['cursor', 'limit'] as const;
const OUTCOMES: readonly AuditOutcome[] = ['ok', 'error', 'denied'];
const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 100;
const MAX_ACTOR = 255;
const MAX_CORRELATION = 128;
const MAX_BIGINT = 9223372036854775807n;
/** C0, DEL and C1 control characters. */
const CONTROL = /\p{Cc}/u;
/** Four-digit years only: expanded years round-trip through Date but lie outside timestamptz. */
const ISO_INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

const fail = { ok: false } as const;

export const encodeAuditCursor = (seq: string): string => encodeItemCursor(seq);

/** Bounded text without control characters (PostgreSQL refuses NUL in a text parameter). */
function boundedText(raw: string, max: number): string | undefined {
  return raw.length >= 1 && raw.length <= max && !CONTROL.test(raw) ? raw : undefined;
}

/** An instant with a four-digit year, written exactly as `toISOString` writes it. */
function isoDate(raw: string): Date | undefined {
  if (!ISO_INSTANT.test(raw)) return undefined;
  const at = new Date(raw);
  return !Number.isNaN(at.getTime()) && at.toISOString() === raw ? at : undefined;
}

/** A positive `seq` from a cursor, canonical decimal within bigint (ruling T11/T12/F2). */
function seqCursor(raw: string): string | undefined {
  const decoded = decodeCursor(raw);
  if (decoded === undefined || !/^[1-9][0-9]{0,18}$/.test(decoded)) return undefined;
  return BigInt(decoded) <= MAX_BIGINT ? decoded : undefined;
}

function limitParam(raw: string | undefined): number | undefined {
  if (raw === undefined) return DEFAULT_LIMIT;
  if (!/^[0-9]{1,3}$/.test(raw)) return undefined;
  const n = Number(raw);
  return n >= 1 && n <= MAX_LIMIT ? n : undefined;
}

/** The query as string values, or undefined for an unknown key or a non-string value. */
function strings(q: Record<string, unknown>, allowed: readonly string[]): Map<string, string> | undefined {
  const values = new Map<string, string>();
  for (const [key, value] of Object.entries(q)) {
    if (!allowed.includes(key) || typeof value !== 'string') return undefined;
    values.set(key, value);
  }
  return values;
}

function parseFilter(values: Map<string, string>): Parsed<{ filter: AuditSearchFilter; filterNames: string[] }> {
  const filter: {
    actor?: string;
    action?: AuditAction;
    outcome?: AuditOutcome;
    changesetId?: string;
    correlationId?: string;
    from?: Date;
    to?: Date;
  } = {};
  const filterNames: string[] = [];
  for (const key of FILTER_KEYS) {
    const raw = values.get(key);
    if (raw === undefined) continue;
    filterNames.push(key);
    switch (key) {
      case 'actor': {
        const actor = boundedText(raw, MAX_ACTOR);
        if (actor === undefined) return fail;
        filter.actor = actor;
        break;
      }
      case 'action': {
        const action = AUDIT_ACTIONS.find((a) => a === raw);
        if (action === undefined) return fail;
        filter.action = action;
        break;
      }
      case 'outcome': {
        const outcome = OUTCOMES.find((o) => o === raw);
        if (outcome === undefined) return fail;
        filter.outcome = outcome;
        break;
      }
      case 'changeset':
        if (!CHANGESET_ID.test(raw)) return fail;
        filter.changesetId = raw.toLowerCase();
        break;
      case 'correlation': {
        const correlationId = boundedText(raw, MAX_CORRELATION);
        if (correlationId === undefined) return fail;
        filter.correlationId = correlationId;
        break;
      }
      case 'from':
      case 'to': {
        const at = isoDate(raw);
        if (at === undefined) return fail;
        filter[key] = at;
        break;
      }
    }
  }
  filterNames.sort();
  return { ok: true, value: { filter, filterNames } };
}

/** `GET /api/v1/audit`: the filters, `cursor` and `limit` (1–100, default 50). */
export function parseAuditSearchQuery(q: Record<string, unknown>): Parsed<AuditQuery> {
  const values = strings(q, [...FILTER_KEYS, ...PAGE_KEYS]);
  if (values === undefined) return fail;
  const parsed = parseFilter(values);
  if (!parsed.ok) return fail;
  const limit = limitParam(values.get('limit'));
  if (limit === undefined) return fail;
  const rawCursor = values.get('cursor');
  if (rawCursor === undefined) return { ok: true, value: { ...parsed.value, limit } };
  const beforeSeq = seqCursor(rawCursor);
  return beforeSeq === undefined ? fail : { ok: true, value: { ...parsed.value, limit, beforeSeq } };
}

/** `GET /api/v1/audit/export`: the filters only; the export streams every matching row. */
export function parseAuditExportQuery(q: Record<string, unknown>): Parsed<Omit<AuditQuery, 'limit' | 'beforeSeq'>> {
  const values = strings(q, FILTER_KEYS);
  return values === undefined ? fail : parseFilter(values);
}
