/**
 * Query-string and body parsing for the approval page routes (NFR-8, APR-5, SEC-8). Only a string
 * query value is accepted: an array means a repeated parameter and is refused. Cursors are opaque
 * base64url text and are accepted only if decoding and re-encoding gives back the same text.
 */
import { randomBytes } from 'node:crypto';
import { z } from 'zod';
import type { DecisionRequest, ItemStatus } from '@aiops/core';

export const CHANGESET_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export type Parsed<T> = { ok: true; value: T } | { ok: false };

const MAX_CURSOR_LENGTH = 1024;
const ITEM_STATUSES: readonly ItemStatus[] = ['pending', 'excluded', 'written', 'failed', 'skipped'];
const SEED = /^[0-9a-f]{32}$/;

const fail = { ok: false } as const;
const ok = <T>(value: T): Parsed<T> => ({ ok: true, value });

export function encodeItemCursor(targetId: string): string {
  return Buffer.from(targetId, 'utf8').toString('base64url');
}

export function encodeQueueCursor(c: { submittedAt: Date; id: string }): string {
  return Buffer.from(JSON.stringify([c.submittedAt.toISOString(), c.id]), 'utf8').toString(
    'base64url',
  );
}

/** The decoded text of a canonical base64url cursor, or undefined. */
function decodeCursor(text: string): string | undefined {
  if (text.length === 0 || text.length > MAX_CURSOR_LENGTH) return undefined;
  const decoded = Buffer.from(text, 'base64url').toString('utf8');
  // Control characters (NUL included) would fail later as a PostgreSQL text parameter (500).
  // eslint-disable-next-line no-control-regex -- rejecting control characters is the point
  if (/[\u0000-\u001f\u007f]/.test(decoded)) return undefined;
  return Buffer.from(decoded, 'utf8').toString('base64url') === text ? decoded : undefined;
}

const INVALID = Symbol('invalid');
type Raw = string | undefined | typeof INVALID;

/** One string value, absent, or 'invalid' for an array, object or other shape. */
function single(q: Record<string, unknown>, key: string): Raw {
  const v = q[key];
  if (v === undefined) return undefined;
  return typeof v === 'string' ? v : INVALID;
}

function intParam(raw: Raw, def: number, min: number, max: number): number | undefined {
  if (raw === undefined) return def;
  if (raw === INVALID || !/^\d{1,4}$/.test(raw)) return undefined;
  const n = Number(raw);
  return n >= min && n <= max ? n : undefined;
}

function parseQueueCursor(text: string): { submittedAt: Date; id: string } | undefined {
  const decoded = decodeCursor(text);
  if (decoded === undefined) return undefined;
  let json: unknown;
  try {
    json = JSON.parse(decoded);
  } catch {
    return undefined;
  }
  if (!Array.isArray(json) || json.length !== 2) return undefined;
  const [iso, id] = json as unknown[];
  if (typeof iso !== 'string' || typeof id !== 'string' || !CHANGESET_ID.test(id) || id !== id.toLowerCase()) {
    return undefined;
  }
  const at = new Date(iso);
  if (Number.isNaN(at.getTime()) || at.toISOString() !== iso) return undefined;
  return { submittedAt: at, id };
}

export function parseQueueQuery(
  q: Record<string, unknown>,
): Parsed<{ limit: number; after?: { submittedAt: Date; id: string } }> {
  const limit = intParam(single(q, 'limit'), 25, 1, 100);
  if (limit === undefined) return fail;
  const rawAfter = single(q, 'after');
  if (rawAfter === undefined) return ok({ limit });
  if (rawAfter === INVALID) return fail;
  const after = parseQueueCursor(rawAfter);
  return after === undefined ? fail : ok({ limit, after });
}

export function parseItemsQuery(
  q: Record<string, unknown>,
): Parsed<{ limit: number; after?: string; status?: ItemStatus }> {
  const limit = intParam(single(q, 'limit'), 50, 1, 100);
  if (limit === undefined) return fail;
  const value: { limit: number; after?: string; status?: ItemStatus } = { limit };
  const rawAfter = single(q, 'after');
  if (rawAfter !== undefined) {
    const after = rawAfter === INVALID ? undefined : decodeCursor(rawAfter);
    if (after === undefined) return fail;
    value.after = after;
  }
  const rawStatus = single(q, 'status');
  if (rawStatus !== undefined) {
    const status = ITEM_STATUSES.find((s) => s === rawStatus);
    if (status === undefined) return fail;
    value.status = status;
  }
  return ok(value);
}

export function parseSampleQuery(
  q: Record<string, unknown>,
): Parsed<{ size: number; seed?: string | undefined }> {
  const size = intParam(single(q, 'size'), 10, 1, 50);
  if (size === undefined) return fail;
  const rawSeed = single(q, 'seed');
  if (rawSeed === undefined) return ok({ size, seed: undefined });
  if (rawSeed === INVALID || !SEED.test(rawSeed)) return fail;
  return ok({ size, seed: rawSeed });
}

export const newSeed = (): string => randomBytes(16).toString('hex');

export const decisionBodySchema: z.ZodType<{
  decision: DecisionRequest;
  hash: string;
  count: number;
  comment?: string | undefined;
}> = z.strictObject({
  decision: z.enum(['approve', 'reject', 'return']),
  hash: z.string().regex(/^sha256:[0-9a-f]{64}$/),
  count: z.number().int().min(0).max(100_000_000),
  comment: z.string().max(10_000).optional(),
});
