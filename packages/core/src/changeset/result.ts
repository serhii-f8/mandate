import type { InvocationResult } from '../operation-invoker.js';
import { READ_RESULT_TEXT, readErrorResult } from '../read-result.js';
import type { ChangeItemRecord, ChangeSetRecord, ExclusionReason } from './model.js';

const EXCLUSION_ORDER: readonly ExclusionReason[] = ['not_found', 'out_of_scope', 'missing_data', 'no_change'];

/** Fixed change-set result wording (design §6.1), kept in one place so tests compare the same strings. */
export const CHANGESET_TEXT = {
  nothingWritten: 'Nothing was written upstream.',
  seeAll: 'Use get_changeset to see every item.',
  errors: {
    targets_missing: (op: string) => `${op} could not prepare a change-set: the call names no targets.`,
    too_many_targets: (op: string) =>
      `${op} could not prepare a change-set: it would affect more targets than the operation allows.`,
    incomplete_read: (op: string) =>
      `${op} could not prepare a change-set: the current state could not be read completely.`,
    cancelled: (op: string) =>
      `${op} could not prepare a change-set: it was cancelled or expired during preparation.`,
    internal: (op: string) => `${op} could not be prepared because of an internal error.`,
  },
} as const;

/** MCP-4: counts-only summary text (SEC-5), the change-set summary and first items as structured data and JSON text. */
export function preparedResult(
  cs: ChangeSetRecord,
  items: readonly ChangeItemRecord[],
  nextCursor?: string,
): InvocationResult {
  const reasons = EXCLUSION_ORDER.flatMap((r) => {
    const n = cs.stats.excluded[r] ?? 0;
    return n > 0 ? [`${r} ${String(n)}`] : [];
  });
  const excludedTotal = EXCLUSION_ORDER.reduce((sum, r) => sum + (cs.stats.excluded[r] ?? 0), 0);
  const reasonPart = reasons.length > 0 ? ` (${reasons.join(', ')})` : '';
  const text =
    `${cs.operation} prepared change-set ${cs.id}: ${String(cs.stats.included)} change(s) to apply, ` +
    `${String(excludedTotal)} excluded${reasonPart}. ${CHANGESET_TEXT.nothingWritten} ` +
    `Hash ${cs.hash ?? ''}; expires ${cs.expiresAt.toISOString()}. ${CHANGESET_TEXT.seeAll} ${READ_RESULT_TEXT.dataNote}`;
  const structured: Record<string, unknown> = {
    changeset: {
      id: cs.id,
      operation: cs.operation,
      status: cs.status,
      hash: cs.hash,
      stats: cs.stats,
      createdAt: cs.createdAt.toISOString(),
      expiresAt: cs.expiresAt.toISOString(),
    },
    items: items.slice(0, 20),
    ...(nextCursor !== undefined ? { nextCursor } : {}),
  };
  return { text, structured, dataText: JSON.stringify(structured) };
}

/**
 * A fixed, value-free error result per preparation failure code (SEC-3). When a change-set
 * exists, the text names it and the structured data carries its id, status and code only;
 * an upstream HTTP status (a number, never upstream text) is part of the text.
 */
export function preparationErrorResult(
  operation: string,
  code: string,
  changesetId?: string,
  upstreamStatus?: number,
): InvocationResult {
  const base = Object.hasOwn(CHANGESET_TEXT.errors, code)
    ? CHANGESET_TEXT.errors[code as keyof typeof CHANGESET_TEXT.errors](operation)
    : readErrorResult(operation, code, upstreamStatus).text;
  if (changesetId === undefined) return { text: base, isError: true };
  const text = `${base.replace(/\.$/, '')} (change-set ${changesetId}).`;
  // `cancelled` is the code for a change-set that left preparing under us; every other code marked it failed.
  const status = code === 'cancelled' ? 'cancelled' : 'failed';
  const structured = { changeset: { id: changesetId, status, errorCode: code } };
  return { text, structured, dataText: JSON.stringify(structured), isError: true };
}

/** Opaque item cursor: base64url of the last target id. */
export function encodeCursor(targetId: string): string {
  return Buffer.from(targetId, 'utf8').toString('base64url');
}

const STRICT_UTF8 = new TextDecoder('utf-8', { fatal: true });

/** Inverse of `encodeCursor`; undefined for anything `encodeCursor` cannot have produced. */
export function decodeCursor(cursor: string): string | undefined {
  if (cursor === '' || !/^[A-Za-z0-9_-]+$/.test(cursor)) return undefined;
  const bytes = Buffer.from(cursor, 'base64url');
  if (bytes.toString('base64url') !== cursor) return undefined;
  try {
    return STRICT_UTF8.decode(bytes);
  } catch {
    return undefined;
  }
}
