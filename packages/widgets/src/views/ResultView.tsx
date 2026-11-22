// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Mandate Authors
import { type ReactElement, useCallback, useEffect, useRef, useState } from 'react';
import { ActionBar } from '../components/ActionBar.js';
import { ItemTable } from '../components/ItemTable.js';
import { Notice } from '../components/Notice.js';
import { RawArguments } from '../components/RawArguments.js';
import { Pager } from '../components/Pager.js';
import { RollbackCounts } from '../components/RollbackCounts.js';
import { StatusBadge } from '../components/StatusBadge.js';
import type { ChangeSetActions, ChangeSetViewModel, ItemsPageModel } from '../model.js';
import { type ItemPages, useItemPages } from '../paging.js';
import type { ViewProps } from './PreviewView.js';
import { useAction } from './useAction.js';

type Tab = 'failed' | 'skipped';

const TABS: { tab: Tab; label: string }[] = [
  { tab: 'failed', label: 'Failed' },
  { tab: 'skipped', label: 'Skipped' },
];

// One stable empty page: each tab starts empty and loads its own status on first show.
const EMPTY: ItemsPageModel = { items: [] };

function summary(data: ChangeSetViewModel): string {
  const { written, failed, skipped } = data.stats;
  const base = `${String(written)} written · ${String(failed)} failed · ${String(skipped)} skipped`;
  return data.drift === undefined ? base : `${base} · ${String(data.drift)} changed upstream`;
}

/** The one call of an opaque change-set: its status and, when it failed, the error. */
function callOutcome(data: ChangeSetViewModel): string {
  const call = data.items.items[0];
  const status = call?.status ?? data.status;
  return call?.error === undefined ? `Call outcome: ${status}` : `Call outcome: ${status} (${call.error})`;
}

/** A finished change-set (UI-4): counts, drift, error code, and the failed and skipped items. */
export function ResultView({ data, actions, onData }: ViewProps<ChangeSetViewModel, ChangeSetActions>): ReactElement {
  const loadItems = useCallback((q: Parameters<ChangeSetActions['loadItems']>[0]) => actions.loadItems(q), [actions]);
  const failedPages = useItemPages(EMPTY, 'failed', loadItems, data.id);
  const skippedPages = useItemPages(EMPTY, 'skipped', loadItems, data.id);
  const [tab, setTab] = useState<Tab>('failed');
  const loaded = useRef(new Set<string>());
  const action = useAction();
  const rollback = actions.rollback?.bind(actions);

  const pages: ItemPages = tab === 'failed' ? failedPages : skippedPages;
  // Loads the shown tab once per change-set (the key holds the ID, so a new change-set loads again).
  const key = `${data.id}:${tab}`;
  useEffect(() => {
    if (loaded.current.has(key)) return;
    loaded.current.add(key);
    pages.setFilter(tab);
  }, [key]);

  if (data.kind === 'opaque') {
    return (
      <section className="view result">
        <header>
          <h2>{data.operation.title ?? data.operation.id}</h2>
          <StatusBadge status={data.status} />
        </header>
        <RawArguments args={data.args ?? {}} />
        <p className="outcome">{callOutcome(data)}</p>
        {data.errorCode === undefined ? null : <p className="error-code">{`Error: ${data.errorCode}`}</p>}
      </section>
    );
  }
  return (
    <section className="view result">
      <header>
        <h2>{data.operation.title ?? data.operation.id}</h2>
        <StatusBadge status={data.status} />
      </header>
      <p className="counts">{summary(data)}</p>
      <RollbackCounts stats={data.rollback.stats} />
      {data.errorCode === undefined ? null : <p className="error-code">{`Error: ${data.errorCode}`}</p>}
      <div role="tablist" aria-label="Items">
        {TABS.map(({ tab: t, label }) => (
          <button
            key={t}
            type="button"
            role="tab"
            aria-selected={tab === t}
            onClick={() => {
              setTab(t);
            }}
          >
            {label}
          </button>
        ))}
      </div>
      <div role="tabpanel" aria-label={tab === 'failed' ? 'Failed' : 'Skipped'}>
        <ItemTable
          rows={pages.page.items}
          {...(loaded.current.has(key) && !pages.busy && pages.error === undefined
            ? { empty: tab === 'failed' ? 'No failed items.' : 'No skipped items.' }
            : {})}
        />
        <Pager
          hasPrevious={pages.hasPrevious}
          hasNext={pages.page.next !== undefined}
          busy={pages.busy}
          onPrevious={() => {
            pages.previous();
          }}
          onNext={() => {
            pages.next();
          }}
        />
      </div>
      {data.rollback.available && rollback ? (
        <ActionBar>
          <button
            type="button"
            className="danger"
            disabled={action.busy}
            onClick={() => {
              action.run('Not rolled back: ', rollback, (next) => {
                if (next !== undefined) onData(next);
              });
            }}
          >
            {data.rollback.count === undefined ? 'Roll back' : `Roll back ${String(data.rollback.count)} items`}
          </button>
        </ActionBar>
      ) : null}
      {action.message === undefined ? null : <Notice kind="error">{action.message}</Notice>}
      {pages.error === undefined ? null : <Notice kind="error">{pages.error}</Notice>}
    </section>
  );
}
