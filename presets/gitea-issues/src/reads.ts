// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Mandate Authors
/**
 * Code reads `search_issues` and `get_issues` (OPS-5, OPS-6). Code, not a declarative read,
 * because labels arrive as objects but are compared as names. Errors name the response code and
 * status only, never upstream text (SEC-3, SEC-5).
 */
import type { CodeContext, CodeHttpResponse, CodeReadResult, WriteRecord } from '@mandate/connector-sdk';
import { parseGetManyArgs, parseSearchArgs } from './args.js';
import { type GiteaIssue, isPullRequest, repoPath, toIssue } from './issue.js';

function failure(what: string, res: Extract<CodeHttpResponse, { ok: false }>): Error {
  return new Error(`${what} failed (${res.code}${res.status === undefined ? '' : ` ${String(res.status)}`})`);
}

/** The issue, undefined for a pull request; a malformed issue throws rather than vanish from the read. */
function issueOrSkip(raw: unknown, what: string): GiteaIssue | undefined {
  if (isPullRequest(raw)) return undefined;
  const issue = toIssue(raw);
  if (issue === undefined) throw new Error(`${what}: invalid issue in response`);
  return issue;
}

/** `GET /repos/{owner}/{repo}/issues`; no `total`, since the count is only in a header. */
export async function searchIssues(ctx: CodeContext, args: unknown): Promise<CodeReadResult> {
  const a = parseSearchArgs(args);
  const query: Record<string, string | number> = { state: a.state, type: 'issues', page: a.page, limit: a.limit };
  if (a.labels !== undefined && a.labels.length > 0) query.labels = a.labels.join(',');
  if (a.q !== undefined) query.q = a.q;
  const res = await ctx.http.send({ method: 'GET', path: `${repoPath(a.owner, a.repo)}/issues`, query });
  if (!res.ok) throw failure('issue search', res);
  if (!Array.isArray(res.json)) throw new Error('issue search: invalid response');
  const items: WriteRecord[] = [];
  for (const raw of res.json as unknown[]) {
    const issue = issueOrSkip(raw, 'issue search');
    if (issue !== undefined) items.push({ ...issue });
  }
  return { items };
}

/** One `GET /repos/{owner}/{repo}/issues/{n}` per number, in order; a 404 or a pull request is omitted. */
export async function getIssues(ctx: CodeContext, args: unknown): Promise<CodeReadResult> {
  const a = parseGetManyArgs(args);
  const base = repoPath(a.owner, a.repo);
  const items: WriteRecord[] = [];
  for (const n of a.numbers) {
    const res = await ctx.http.send({ method: 'GET', path: `${base}/issues/${String(n)}` });
    if (!res.ok) {
      // Exactly the adapter's answer for a missing issue (F3); anything else is a failed read.
      if (res.code === 'http_status' && res.status === 404) continue;
      throw failure('issue read', res);
    }
    const issue = issueOrSkip(res.json, 'issue read');
    if (issue === undefined) continue;
    // An answer for another number would be keyed to the wrong target by core.
    if (issue.number !== n) throw new Error('issue read: invalid issue in response');
    items.push({ ...issue });
  }
  return { items };
}
