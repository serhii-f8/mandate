// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Mandate Authors
/**
 * Preparation checks (CS-3, ADR 0072): a closed set of predicates over an item's values, the current
 * upstream record, the call arguments and lookup results. Pure and deterministic; no expressions.
 * The inputs are only read here: what leaves is the code of the first failing check (SEC-3).
 */
import type { CheckPredicate, CheckRef, ManifestCheck } from '../policy-model.js';
import { CanonicalJsonError, canonicalJson } from './canonical.js';

type Fields = Readonly<Record<string, unknown>>;

export interface CheckContext {
  /** The item's `before` side; `null` for a create. */
  readonly before: Fields | null;
  /** The item's `after` side; `null` for a delete. */
  readonly after: Fields | null;
  /** The current upstream record; `undefined` for a create. */
  readonly record: Fields | undefined;
  readonly args: Fields;
  /** Each declared lookup's result for this item; `undefined` when it found nothing (OPS-7). */
  readonly lookups: Readonly<Record<string, Fields | undefined>>;
}

function field(source: Fields | null | undefined, name: string): unknown {
  return source !== null && source !== undefined && Object.hasOwn(source, name) ? source[name] : undefined;
}

function resolve(ref: CheckRef, ctx: CheckContext): unknown {
  if ('after' in ref) return field(ctx.after, ref.after);
  if ('before' in ref) return field(ctx.before, ref.before);
  if ('record' in ref) return field(ctx.record, ref.record);
  if ('arg' in ref) return field(ctx.args, ref.arg);
  return field(lookupResult(ctx, ref.lookup), ref.field);
}

function lookupResult(ctx: CheckContext, name: string): Fields | undefined {
  return Object.hasOwn(ctx.lookups, name) ? ctx.lookups[name] : undefined;
}

/** Not `null`, not missing and not `''`. */
function present(value: unknown): boolean {
  return value !== undefined && value !== null && value !== '';
}

/** Canonical JSON with `null` and missing equal; a value canonical JSON cannot encode compares false. */
function equal(a: unknown, b: unknown): boolean {
  try {
    return canonicalJson(a ?? null) === canonicalJson(b ?? null);
  } catch (err) {
    if (err instanceof CanonicalJsonError) return false;
    throw err;
  }
}

function lookupFound(ctx: CheckContext, name: string): boolean {
  return lookupResult(ctx, name) !== undefined;
}

function holds(p: CheckPredicate, ctx: CheckContext): boolean {
  if ('present' in p) return present(resolve(p.present, ctx));
  if ('absent' in p) return !present(resolve(p.absent, ctx));
  if ('equals' in p) {
    const [left, right] = p.equals;
    return equal(resolve(left, ctx), 'value' in right ? right.value : resolve(right, ctx));
  }
  if ('in' in p) {
    const value = resolve(p.in, ctx);
    // Strict: no coercion between types; NaN matches nothing.
    return p.values.some((v) => v === value);
  }
  if ('found' in p) return lookupFound(ctx, p.found);
  return !lookupFound(ctx, p.not_found);
}

/** The `code` of the first check with a predicate that does not hold, or `undefined` when all hold. */
export function failedCheck(checks: readonly ManifestCheck[], ctx: CheckContext): string | undefined {
  return checks.find((check) => !check.require.every((p) => holds(p, ctx)))?.code;
}

function refsOf(p: CheckPredicate): CheckRef[] {
  if ('present' in p) return [p.present];
  if ('absent' in p) return [p.absent];
  if ('equals' in p) {
    const [left, right] = p.equals;
    return 'value' in right ? [left] : [left, right];
  }
  if ('in' in p) return [p.in];
  return [];
}

/** The distinct `{ record }` fields of the checks, in order of appearance, to add to the `read_before` fields. */
export function checkRecordFields(checks: readonly ManifestCheck[]): string[] {
  const out = new Set<string>();
  for (const check of checks) {
    for (const p of check.require) {
      for (const ref of refsOf(p)) if ('record' in ref) out.add(ref.record);
    }
  }
  return [...out];
}
