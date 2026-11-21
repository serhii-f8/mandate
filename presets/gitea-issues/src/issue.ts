// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The AI Operations Layer Authors
/**
 * The normalised Gitea issue both code reads answer (OPS-5). Upstream content is data (SEC-5):
 * only the keys below leave this module, and `owner`/`repo` come from the issue's own
 * `repository`, so core's scope check compares what the upstream says, not the arguments (POL-2).
 */

export interface GiteaIssue {
  readonly number: number;
  readonly title: string;
  readonly state: 'open' | 'closed';
  /** Label names, sorted by code point. */
  readonly labels: readonly string[];
  readonly owner: string;
  readonly repo: string;
  readonly updated_at: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** True when the raw issue is a pull request (`pull_request` present and not null). */
export function isPullRequest(raw: unknown): boolean {
  return isRecord(raw) && raw.pull_request !== undefined && raw.pull_request !== null;
}

function labelNames(raw: unknown): string[] | undefined {
  // Gitea answers `[]` for an issue without labels; `null` is treated the same.
  if (raw === null) return [];
  if (!Array.isArray(raw)) return undefined;
  const names: string[] = [];
  for (const label of raw) {
    if (!isRecord(label) || typeof label.name !== 'string') return undefined;
    names.push(label.name);
  }
  return names.sort();
}

/** The normalised issue; undefined for a pull request or a malformed issue. */
export function toIssue(raw: unknown): GiteaIssue | undefined {
  if (!isRecord(raw) || isPullRequest(raw)) return undefined;
  const { number, title, state, updated_at: updatedAt, repository } = raw;
  if (typeof number !== 'number' || !Number.isSafeInteger(number) || number < 1) return undefined;
  if (typeof title !== 'string' || typeof updatedAt !== 'string') return undefined;
  if (state !== 'open' && state !== 'closed') return undefined;
  if (!isRecord(repository) || typeof repository.owner !== 'string' || typeof repository.name !== 'string') return undefined;
  const labels = labelNames(raw.labels);
  if (labels === undefined) return undefined;
  return { number, title, state, labels, owner: repository.owner, repo: repository.name, updated_at: updatedAt };
}

/** `/repos/<owner>/<repo>`, each segment percent-encoded; callers check the name pattern first. */
export function repoPath(owner: string, repo: string): string {
  return `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}`;
}
