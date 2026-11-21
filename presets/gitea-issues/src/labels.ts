// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The AI Operations Layer Authors
/**
 * Code writer `set_labels` (OPS-5, OPS-6). Gitea's `PUT …/issues/{n}/labels` drops unknown names
 * and ids with a 200, so a declarative mapping would report a partial write as success. This
 * writer resolves names to ids from the repository's own label list (exact match, repository
 * labels only) and refuses a record with an unknown name without sending anything. A 2xx PUT has
 * landed, so it is `ok` whatever the answer holds: `failed` means a definite refusal, and core's
 * verify read marks a partial write as drift. Upstream content is data (SEC-5): only label ids and
 * names are read from it.
 */
import type { CodeArgs, CodeContext, CodeHttpResponse, RecordOutcome, WriteRecord } from '@aiops/connector-sdk';
import { repoPath } from './issue.js';

/** Gitea's `max_response_items`: a shorter page is the last one. */
const PAGE_SIZE = 50;
/** 1000 labels; an upstream that never answers a short page is refused rather than paged forever. */
const MAX_LABEL_PAGES = 20;
/** The owner/repo name pattern of the input schema (args.ts `NAME`), checked again on carried values. */
const NAME = /^[A-Za-z0-9_.-]{1,100}$/;
const RETRIABLE_CODES: ReadonlySet<string> = new Set(['timeout', 'network', 'busy']);

/** Rate limits, server errors and transport trouble are worth another attempt; anything else is not (F3). */
function isRetriable(res: Extract<CodeHttpResponse, { ok: false }>): boolean {
  if (res.status !== undefined && (res.status === 429 || res.status >= 500)) return true;
  return RETRIABLE_CODES.has(res.code);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isName(value: unknown): value is string {
  return typeof value === 'string' && NAME.test(value) && value !== '.' && value !== '..';
}

interface Target {
  readonly number: number;
  readonly labels: readonly string[];
  readonly owner: string;
  readonly repo: string;
}

/** The record as a write target; undefined when a field core should have built is missing or malformed. */
function toTarget(record: WriteRecord): Target | undefined {
  const { number, labels, owner, repo } = record;
  if (typeof number !== 'number' || !Number.isSafeInteger(number) || number < 1) return undefined;
  if (!Array.isArray(labels) || !labels.every((l): l is string => typeof l === 'string')) return undefined;
  if (!isName(owner) || !isName(repo)) return undefined;
  return { number, labels, owner, repo };
}

/** `{ id, name }` pairs of a Label array; undefined when the body is not one. */
function parseLabels(body: unknown): { id: number; name: string }[] | undefined {
  if (!Array.isArray(body)) return undefined;
  const out: { id: number; name: string }[] = [];
  for (const entry of body as unknown[]) {
    if (!isRecord(entry) || typeof entry.id !== 'number' || !Number.isSafeInteger(entry.id) || typeof entry.name !== 'string') return undefined;
    out.push({ id: entry.id, name: entry.name });
  }
  return out;
}

/** A label map, or the outcome every record of the repository gets when the list cannot be read. */
type Resolution = { readonly ok: true; readonly ids: ReadonlyMap<string, number> } | { readonly ok: false; readonly outcome: RecordOutcome };

/** Pages `GET <repo>/labels` until a short page and maps each exact name to its id. */
async function readLabels(ctx: CodeContext, base: string): Promise<Resolution> {
  const ids = new Map<string, number>();
  for (let page = 1; page <= MAX_LABEL_PAGES; page += 1) {
    const res = await ctx.http.send({ method: 'GET', path: `${base}/labels`, query: { page, limit: PAGE_SIZE } });
    if (!res.ok) return { ok: false, outcome: isRetriable(res) ? 'retriable' : 'failed' };
    const labels = parseLabels(res.json);
    if (labels === undefined) return { ok: false, outcome: 'failed' };
    // The first id wins for a repeated name; either one carries the requested name.
    for (const { id, name } of labels) if (!ids.has(name)) ids.set(name, id);
    if (labels.length < PAGE_SIZE) return { ok: true, ids };
  }
  return { ok: false, outcome: 'failed' };
}

/**
 * Replaces the labels of each record's issue. Outcomes have the records' length and order. A
 * retriable answer stops sending: that record and every later unsent record are `retriable`, so
 * read-before-write decides on the retry what is already applied (OPS-6).
 */
// eslint-disable-next-line @typescript-eslint/no-unused-vars -- the CodeWriteOperation shape (F2); owner and repo come from carried fields
export async function setLabels(ctx: CodeContext, records: readonly WriteRecord[], _args: CodeArgs): Promise<readonly RecordOutcome[]> {
  const outcomes: RecordOutcome[] = [];
  const resolutions = new Map<string, Resolution>();
  let stopped = false;
  for (const record of records) {
    const target = toTarget(record);
    if (target === undefined) {
      outcomes.push('failed');
      continue;
    }
    if (stopped) {
      outcomes.push('retriable');
      continue;
    }
    const base = repoPath(target.owner, target.repo);
    let resolution = resolutions.get(base);
    if (resolution === undefined) {
      resolution = await readLabels(ctx, base);
      resolutions.set(base, resolution);
      if (!resolution.ok && resolution.outcome === 'retriable') stopped = true;
    }
    if (!resolution.ok) {
      outcomes.push(resolution.outcome);
      continue;
    }
    const ids: number[] = [];
    for (const name of target.labels) {
      const id = resolution.ids.get(name);
      if (id === undefined) break;
      ids.push(id);
    }
    if (ids.length !== target.labels.length) {
      outcomes.push('failed');
      continue;
    }
    const res = await ctx.http.send({ method: 'PUT', path: `${base}/issues/${String(target.number)}/labels`, body: { labels: ids } });
    if (!res.ok) {
      const retriable = isRetriable(res);
      if (retriable) stopped = true;
      outcomes.push(retriable ? 'retriable' : 'failed');
      continue;
    }
    // Landed: never `failed`, even when the answer names other labels; core's verify read checks it.
    outcomes.push('ok');
  }
  return outcomes;
}
