// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Mandate Authors
/**
 * Hand-written narrowing of the code reads' arguments (OPS-5). The input schema already ran, but
 * Ajv applies no defaults (F13) and the connection test passes declared arguments unchecked, so
 * every value is checked here before any request; a bad value throws `TypeError`.
 */

/** Owner and repository names (input schema pattern); `.` and `..` are refused as path segments. */
const NAME = /^[A-Za-z0-9_.-]{1,100}$/;
/** An issue number as core passes target IDs: a decimal string. */
const NUMBER = /^[1-9][0-9]{0,9}$/;
const STATES = ['open', 'closed', 'all'] as const;
const FIELDS: ReadonlySet<string> = new Set(['number', 'title', 'state', 'labels', 'owner', 'repo', 'updated_at']);
const MAX_LABELS = 10;
const MAX_LABEL_LENGTH = 50;
const MAX_Q_LENGTH = 255;
const MAX_LIMIT = 50;
const MAX_NUMBERS = 50;

export type IssueState = (typeof STATES)[number];

export interface SearchArgs {
  readonly owner: string;
  readonly repo: string;
  readonly state: IssueState;
  readonly labels?: readonly string[];
  readonly q?: string;
  readonly page: number;
  readonly limit: number;
}

export interface GetManyArgs {
  readonly owner: string;
  readonly repo: string;
  /** Issue numbers, in argument order. */
  readonly numbers: readonly number[];
}

function fail(what: string): never {
  throw new TypeError(`invalid argument: ${what}`);
}

/** The arguments as an object with no key outside `allowed`; an `undefined` value counts as absent. */
function record(args: unknown, allowed: readonly string[]): Record<string, unknown> {
  if (typeof args !== 'object' || args === null || Array.isArray(args)) fail('arguments');
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(args)) {
    if (!allowed.includes(key)) fail('unknown key');
    if (value !== undefined) out[key] = value;
  }
  return out;
}

function name(value: unknown, what: string): string {
  if (typeof value !== 'string' || !NAME.test(value) || value === '.' || value === '..') fail(what);
  return value;
}

function integer(value: unknown, min: number, max: number, what: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < min || value > max) fail(what);
  return value;
}

function uniqueStrings(value: unknown, min: number, max: number, what: string): string[] {
  if (!Array.isArray(value) || value.length < min || value.length > max) fail(what);
  if (!value.every((v): v is string => typeof v === 'string') || new Set(value).size !== value.length) fail(what);
  return value;
}

function fields(value: unknown): void {
  const list = uniqueStrings(value, 1, FIELDS.size, 'fields');
  if (!list.every((f) => FIELDS.has(f))) fail('fields');
}

/** A label name: printable, no comma (the list is sent comma-joined, so a comma would widen the match). */
function labelName(value: string): boolean {
  // eslint-disable-next-line no-control-regex -- control characters are exactly what is refused
  return value.length >= 1 && value.length <= MAX_LABEL_LENGTH && !value.includes(',') && !/[\u0000-\u001f\u007f]/.test(value);
}

export function parseSearchArgs(args: unknown): SearchArgs {
  const a = record(args, ['owner', 'repo', 'fields', 'state', 'labels', 'q', 'page', 'limit']);
  const owner = name(a.owner, 'owner');
  const repo = name(a.repo, 'repo');
  fields(a.fields);
  const state = a.state === undefined ? 'open' : STATES.find((s) => s === a.state);
  if (state === undefined) fail('state');
  let labels: string[] | undefined;
  if (a.labels !== undefined) {
    labels = uniqueStrings(a.labels, 0, MAX_LABELS, 'labels');
    if (!labels.every(labelName)) fail('labels');
  }
  let q: string | undefined;
  if (a.q !== undefined) {
    if (typeof a.q !== 'string' || a.q.length < 1 || a.q.length > MAX_Q_LENGTH) fail('q');
    q = a.q;
  }
  const page = a.page === undefined ? 1 : integer(a.page, 1, Number.MAX_SAFE_INTEGER, 'page');
  const limit = a.limit === undefined ? 30 : integer(a.limit, 1, MAX_LIMIT, 'limit');
  return { owner, repo, state, page, limit, ...(labels === undefined ? {} : { labels }), ...(q === undefined ? {} : { q }) };
}

export function parseGetManyArgs(args: unknown): GetManyArgs {
  const a = record(args, ['owner', 'repo', 'numbers', 'fields']);
  const owner = name(a.owner, 'owner');
  const repo = name(a.repo, 'repo');
  fields(a.fields);
  const raw = uniqueStrings(a.numbers, 1, MAX_NUMBERS, 'numbers');
  if (!raw.every((n) => NUMBER.test(n))) fail('numbers');
  return { owner, repo, numbers: raw.map(Number) };
}
