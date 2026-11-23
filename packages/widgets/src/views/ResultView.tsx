// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Mandate Authors
import { type ReactElement, useCallback, useEffect, useRef, useState } from 'react';
import { ActionBar } from '../components/ActionBar.js';
import { ItemTable } from '../components/ItemTable.js';
import { Notice } from '../components/Notice.js';
import { FilesSection } from '../components/FilesSection.js';
import { RawArguments } from '../components/RawArguments.js';
import { Pager } from '../components/Pager.js';
import { RollbackCounts } from '../components/RollbackCounts.js';
import { PlanSection } from '../components/PlanSection.js';
import { StatusBadge } from '../components/StatusBadge.js';
import type { ChangeSetActions, ChangeSetViewModel, ItemsPageModel } from '../model.js';
import { type ItemPages, useItemPages } from '../paging.js';
import type { ViewProps } from './PreviewView.js';
import { useAction } from './useAction.js';

type Tab = 'failed' | 'skipped' | 'written' | 'not_confirmed';

const TABS: { tab: Tab; label: string }[] = [
  { tab: 'failed', label: 'Failed' },
  { tab: 'skipped', label: 'Skipped' },
];

/**
 * EXE-12: a verified change-set also lists the written items verification has not confirmed (pending or
 * unconfirmed), and all its written items, where the unconfirmed ones are marked.
 */
const VERIFIED_TABS: { tab: Tab; label: string }[] = [
  { tab: 'not_confirmed', label: 'Not confirmed' },
  { tab: 'written', label: 'Written' },
];
const EMPTY_TEXT: Record<Tab, string> = {
  failed: 'No failed items.',
  skipped: 'No skipped items.',
  written: 'No written items.',
  not_confirmed: 'No items that are not confirmed.',
};

/** EXE-12: with nothing failed, the items to look at are the ones not confirmed; otherwise the failed ones. */
function firstTab(data: ChangeSetViewModel): Tab {
  const v = data.stats.verification;
  return data.stats.failed === 0 && v !== undefined && v.pending + v.unconfirmed > 0 ? 'not_confirmed' : 'failed';
}

// One stable empty page: each tab starts empty and loads its own status on first show.
const EMPTY: ItemsPageModel = { items: [] };

function summary(data: ChangeSetViewModel): string {
  const { written, failed, skipped } = data.stats;
  const base = `${String(written)} written · ${String(failed)} failed · ${String(skipped)} skipped`;
  return data.drift === undefined ? base : `${base} · ${String(data.drift)} changed upstream`;
}

/** EXE-12: an item still pending verification counts as not confirmed, as in the tool answer. */
function verificationLine(data: ChangeSetViewModel): string | undefined {
  const v = data.stats.verification;
  return v === undefined ? undefined : `Verification: ${String(v.confirmed)} confirmed · ${String(v.unconfirmed + v.pending)} not confirmed`;
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
  const writtenPages = useItemPages(EMPTY, 'written', loadItems, data.id);
  const notConfirmedPages = useItemPages(EMPTY, 'not_confirmed', loadItems, data.id);
  const [tab, setTab] = useState<Tab>(() => firstTab(data));
  const loaded = useRef(new Set<string>());
  const action = useAction();
  const rollback = actions.rollback?.bind(actions);

  const byTab: Record<Tab, ItemPages> = { failed: failedPages, skipped: skippedPages, written: writtenPages, not_confirmed: notConfirmedPages };
  const pages = byTab[tab];
  const verification = verificationLine(data);
  const tabs = data.stats.verification === undefined ? TABS : [...TABS, ...VERIFIED_TABS];
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
        <PlanSection plan={data.plan} />
        <FilesSection files={data.files ?? []} {...(actions.filesSource === undefined ? {} : { source: actions.filesSource })} />
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
      <PlanSection plan={data.plan} />
      <p className="counts">{summary(data)}</p>
      {verification === undefined ? null : <p className="verification">{verification}</p>}
      <RollbackCounts stats={data.rollback.stats} />
      {data.errorCode === undefined ? null : <p className="error-code">{`Error: ${data.errorCode}`}</p>}
      <div role="tablist" aria-label="Items">
        {tabs.map(({ tab: t, label }) => (
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
      <div role="tabpanel" aria-label={tabs.find((t) => t.tab === tab)?.label ?? ''}>
        <ItemTable
          rows={pages.page.items}
          {...(data.action === undefined ? {} : { action: data.action })}
          {...(data.reasonTitles === undefined ? {} : { reasonTitles: data.reasonTitles })}
          {...(data.verificationTitles === undefined ? {} : { verificationTitles: data.verificationTitles })}
          {...(loaded.current.has(key) && !pages.busy && pages.error === undefined
            ? { empty: EMPTY_TEXT[tab] }
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
