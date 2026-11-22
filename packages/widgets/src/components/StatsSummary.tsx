// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Mandate Authors
import type { ReactElement } from 'react';
import { formatDateTime, plural, shortHash } from '../format.js';
import type { StatsModel } from '../model.js';

/** The built-in exclusion reasons in their fixed order (core `BUILTIN_EXCLUSION_REASONS`); check codes (CS-3) follow by code. */
const REASON_ORDER = ['not_found', 'out_of_scope', 'missing_data', 'no_change', 'already_exists', 'requester'];

function reasonList(excluded: Record<string, number>): string[] {
  const present = Object.keys(excluded).filter((r) => (excluded[r] ?? 0) > 0);
  const known = REASON_ORDER.filter((r) => present.includes(r));
  const other = present.filter((r) => !REASON_ORDER.includes(r)).sort();
  return [...known, ...other].map((r) => `${r} ${String(excluded[r])}`);
}

export function StatsSummary(props: { stats: StatsModel; hash?: string; expiresAt?: string }): ReactElement {
  const { stats, hash, expiresAt } = props;
  const excludedTotal = Object.values(stats.excluded).reduce((a, b) => a + b, 0);
  const reasons = reasonList(stats.excluded);
  return (
    <p className="stats">
      {`${plural(stats.included, 'change')} · ${String(excludedTotal)} excluded`}
      {reasons.length > 0 ? ` (${reasons.join(', ')})` : ''}
      {hash === undefined ? null : (
        <>
          {' · Hash '}
          <code title={hash}>{shortHash(hash)}</code>
        </>
      )}
      {expiresAt === undefined ? null : ` · Expires ${formatDateTime(expiresAt)}`}
    </p>
  );
}
