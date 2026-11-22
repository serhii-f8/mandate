// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Mandate Authors
import type { ReactElement } from 'react';
import { ActionBar } from '../components/ActionBar.js';
import { Notice } from '../components/Notice.js';
import { RollbackCounts } from '../components/RollbackCounts.js';
import { StatusBadge } from '../components/StatusBadge.js';
import type { ChangeSetActions, ChangeSetViewModel, ProgressModel } from '../model.js';
import type { ViewProps } from './PreviewView.js';
import { useAction } from './useAction.js';

/** Progress from the execution counters, or from the statistics before the first counter arrives. */
function progressOf(data: ChangeSetViewModel): ProgressModel {
  if (data.progress) return data.progress;
  const { included, written, failed, skipped } = data.stats;
  return { total: included, done: written, failed, skipped };
}

/** An approved, executing or rolling-back change-set (UI-2); the entry refreshes the data. */
export function ProgressView({ data, actions, onData }: ViewProps<ChangeSetViewModel, ChangeSetActions>): ReactElement {
  const action = useAction();
  const { total, done, failed, skipped } = progressOf(data);
  const cancel = actions.cancel?.bind(actions);
  const v = data.stats.verification;
  // EXE-12: while items still await their check, the line says so.
  const verifying = data.status === 'executing' && v !== undefined && v.pending > 0;
  const counts = verifying
    ? `Verifying: ${String(v.confirmed)} of ${String(v.confirmed + v.pending + v.unconfirmed)} confirmed`
    : `${String(done)} done · ${String(failed)} failed · ${String(skipped)} skipped of ${String(total)}`;
  const canCancel = cancel !== undefined && data.permissions.canCancel && data.status === 'executing';

  return (
    <section className="view progress">
      <header>
        <h2>{data.operation.title ?? data.operation.id}</h2>
        <StatusBadge status={data.status} />
      </header>
      <progress max={total} value={done + failed + skipped} />
      <p className="counts">{counts}</p>
      <RollbackCounts stats={data.rollback.stats} />
      {canCancel ? (
        <ActionBar>
          <button
            type="button"
            className="danger"
            disabled={action.busy}
            onClick={() => {
              action.run('Not cancelled: ', cancel, onData);
            }}
          >
            Cancel
          </button>
        </ActionBar>
      ) : null}
      {action.message === undefined ? null : <Notice kind="error">{action.message}</Notice>}
    </section>
  );
}
