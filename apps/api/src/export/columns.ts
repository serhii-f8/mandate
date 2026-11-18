/**
 * Columns and cell text of a change-set export (CS-8). The writers in `csv.ts` and `xlsx.ts`
 * apply the per-format cell safety (SEC-5); this module holds the pieces they share.
 */
import { canonicalJson, compareTargetIds, type ChangeItemRecord, type ChangeSetRepository } from '@aiops/core';

export const EXPORT_PAGE = 500;
export const CELL_LIMIT = 32_767;
export const CELL_CUT = 32_750;
export const TRUNCATED = '…[truncated]';

const FIXED_COLUMNS = ['target_id', 'status', 'reason', 'error'] as const;

/** Pages of a change-set's items in target order (NFR-7). */
export async function* itemPages(
  repo: Pick<ChangeSetRepository, 'itemsPage'>,
  id: string,
): AsyncIterable<readonly ChangeItemRecord[]> {
  let after: string | undefined;
  for (;;) {
    const page = await repo.itemsPage(id, { limit: EXPORT_PAGE, ...(after === undefined ? {} : { after }) });
    if (page.length > 0) yield page;
    const last = page.at(-1);
    if (last === undefined || page.length < EXPORT_PAGE) return;
    after = last.targetId;
  }
}

function fieldsOf(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
}

/** First pass: the field names of every before/after object, sorted by compareTargetIds. */
export async function collectFields(pages: AsyncIterable<readonly ChangeItemRecord[]>): Promise<readonly string[]> {
  const names = new Set<string>();
  for await (const page of pages) {
    for (const item of page) {
      for (const side of [item.before, item.after]) {
        const record = fieldsOf(side);
        if (record !== undefined) for (const key of Object.keys(record)) names.add(key);
      }
    }
  }
  return [...names].sort(compareTargetIds);
}

/** target_id, status, reason, error, then before.f and after.f per field (interleaved). */
export function headerRow(fields: readonly string[]): readonly string[] {
  return [...FIXED_COLUMNS, ...fields.flatMap((f) => [`before.${f}`, `after.${f}`])];
}

function fieldValue(side: unknown, field: string): unknown {
  const record = fieldsOf(side);
  return record !== undefined && Object.hasOwn(record, field) ? record[field] : undefined;
}

/** Raw cell text of one item, in header order; no truncation or formula safety yet. */
export function itemRow(item: ChangeItemRecord, fields: readonly string[]): readonly string[] {
  return [
    item.targetId,
    item.status,
    item.reason ?? '',
    item.error ?? '',
    ...fields.flatMap((f) => [cellText(fieldValue(item.before, f)), cellText(fieldValue(item.after, f))]),
  ];
}

/** Missing → empty, a string as it is, anything else as canonical JSON. */
export function cellText(value: unknown): string {
  if (value === undefined) return '';
  if (typeof value === 'string') return value;
  return canonicalJson(value);
}

/** Cuts a cell over CELL_LIMIT UTF-16 units to CELL_CUT (one less when that would split a pair) plus the marker. */
export function truncateCell(text: string): string {
  if (text.length <= CELL_LIMIT) return text;
  const lastKept = text.charCodeAt(CELL_CUT - 1);
  const cut = lastKept >= 0xd800 && lastKept <= 0xdbff ? CELL_CUT - 1 : CELL_CUT;
  return text.slice(0, cut) + TRUNCATED;
}

const FORMULA_START = /^[=+\-@\t\r]/;

/** SEC-5: a cell starting with = + - @ tab or CR gets a leading quote, so it is never a formula. */
export function formulaSafe(text: string): string {
  return FORMULA_START.test(text) ? `'${text}` : text;
}

// Everything outside XML 1.0's Char production; with the `u` flag a lone surrogate is one code point and matches.
const XML_ILLEGAL = /[^\t\n\r -퟿-�\u{10000}-\u{10FFFF}]/gu;

/** Drops characters XML 1.0 does not allow; keeps tab, LF, CR, U+0020–U+D7FF, U+E000–U+FFFD and astral. */
export function stripXmlIllegal(text: string): string {
  return text.replace(XML_ILLEGAL, '');
}
