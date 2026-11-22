// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Mandate Authors
/**
 * One problem in a configuration directory (CFG-2): which file, where, and why.
 * Messages never quote configuration values, since a value can be a pasted secret.
 */
export interface ConfigIssue {
  /** Path relative to the configuration directory. */
  readonly file: string;
  /** Dotted path with indices in brackets, e.g. `roles[0].grants[1].scope.brand`; empty for the whole file. */
  readonly path: string;
  readonly line?: number;
  readonly column?: number;
  readonly message: string;
}

export function pathToString(path: readonly PropertyKey[]): string {
  let out = '';
  for (const segment of path) {
    if (typeof segment === 'number') out += `[${String(segment)}]`;
    else out += out === '' ? String(segment) : `.${String(segment)}`;
  }
  return out;
}

/** `roles.yaml:12:9 roles[0].grants[1].scope.brand: message` */
export function formatIssue(issue: ConfigIssue): string {
  const where = issue.line === undefined ? issue.file : `${issue.file}:${String(issue.line)}:${String(issue.column ?? 1)}`;
  return issue.path === '' ? `${where}: ${issue.message}` : `${where} ${issue.path}: ${issue.message}`;
}
