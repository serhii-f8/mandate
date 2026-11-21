// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The AI Operations Layer Authors
import type { ReactElement } from 'react';
import type { ChangeSetViewModel } from '../model.js';

/** The rollback counts once an item has a rollback status (UI-4). */
export function RollbackCounts({ stats }: { stats: ChangeSetViewModel['rollback']['stats'] }): ReactElement | null {
  if (stats === undefined) return null;
  return <p className="counts rollback-counts">{`${String(stats.restored)} restored · ${String(stats.skipped)} skipped · ${String(stats.failed)} failed`}</p>;
}
