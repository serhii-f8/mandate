// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Mandate Authors
import { type ReactElement, useCallback, useRef, useState } from 'react';
import { ActionBar } from '../components/ActionBar.js';
import { ItemTable } from '../components/ItemTable.js';
import { Notice } from '../components/Notice.js';
import { FilesSection } from '../components/FilesSection.js';
import { RawArguments } from '../components/RawArguments.js';
import { Pager } from '../components/Pager.js';
import { StatsSummary } from '../components/StatsSummary.js';
import { PlanSection } from '../components/PlanSection.js';
import { StatusBadge } from '../components/StatusBadge.js';
import { formatDateTime, plural, shortId } from '../format.js';
import type { ChangeSetActions, ChangeSetViewModel, ItemFilter, ItemRowModel } from '../model.js';
import { useItemPages } from '../paging.js';
import { useAction } from './useAction.js';

export interface ViewProps<M, A> {
  data: M;
  actions: A;
  onData: (next: M) => void;
}

export const SELECTION_LIMIT = 1000;

const FILTERS: { label: string; filter: ItemFilter | undefined }[] = [
  { label: 'All', filter: undefined },
  { label: 'Included', filter: 'pending' },
  { label: 'Excluded', filter: 'excluded' },
];

type Edit = 'exclude' | 'include';

/** What ticking a row asks for: exclude a pending row, include back a row the requester excluded. */
function editFor(row: ItemRowModel): Edit | undefined {
  if (row.status === 'pending') return 'exclude';
  if (row.status === 'excluded' && row.reason === 'requester') return 'include';
  return undefined;
}

/** The preview of a prepared change-set (UI-3): selection, exclusion, export and submit. */
export function PreviewView({ data, actions, onData }: ViewProps<ChangeSetViewModel, ChangeSetActions>): ReactElement {
  const loadItems = useCallback((q: Parameters<ChangeSetActions['loadItems']>[0]) => actions.loadItems(q), [actions]);
  const pages = useItemPages(data.items, data.itemFilter, loadItems, data.id);
  const action = useAction();
  // The selection belongs to one change-set; a new ID (exclusion, refresh) starts empty.
  const [selection, setSelection] = useState<{ id: string; edits: ReadonlyMap<string, Edit> }>({
    id: data.id,
    edits: new Map(),
  });
  const edits = selection.id === data.id ? selection.edits : new Map<string, Edit>();
  const [notice, setNotice] = useState<string | undefined>(undefined);

  const toExclude = [...edits].filter(([, e]) => e === 'exclude').map(([id]) => id);
  const toInclude = [...edits].filter(([, e]) => e === 'include').map(([id]) => id);
  const atLimit = edits.size >= SELECTION_LIMIT;
  const clearSelection = (): void => {
    setSelection({ id: data.id, edits: new Map() });
  };

  const rowsById = new Map(pages.page.items.map((r) => [r.targetId, r]));
  // Refs keep `toggle` stable across renders, so the memoised table rows skip unchanged rows.
  const rowsRef = useRef(rowsById);
  rowsRef.current = rowsById;
  const idRef = useRef(data.id);
  idRef.current = data.id;
  const toggle = useCallback((targetId: string): void => {
    const row = rowsRef.current.get(targetId);
    const edit = row ? editFor(row) : undefined;
    if (edit === undefined) return;
    setSelection((s) => {
      const id = idRef.current;
      const next = new Map(s.id === id ? s.edits : []);
      if (next.has(targetId)) next.delete(targetId);
      else if (next.size < SELECTION_LIMIT) next.set(targetId, edit);
      else return s;
      return { id, edits: next };
    });
  }, []);

  // Bound once per render: the entry's actions are methods of one object.
  const exclude = actions.exclude?.bind(actions);
  const submit = actions.submit?.bind(actions);
  const exportItems = actions.export?.bind(actions);
  const openPage = actions.openPage?.bind(actions);
  const opaque = data.kind === 'opaque';
  const canEdit = exclude !== undefined && data.permissions.canExclude && !opaque;
  const { hash } = data;

  const start = (): void => {
    if (!action.busy) setNotice(undefined);
  };

  const sendEdit = (): void => {
    if (!exclude) return;
    start();
    action.run('Not excluded: ', () => exclude({ exclude: toExclude, include: toInclude }), (value) => {
      clearSelection();
      setNotice(`New change-set ${shortId(value.id)}; the previous one is unchanged.`);
      onData(value);
    });
  };

  const sendSubmit = (shown: string): void => {
    if (!submit) return;
    start();
    action.run('Not submitted: ', () => submit(shown), (value) => {
      if (value.status === 'pending_approval') {
        setNotice('Submitted for approval. Approvers decide on the approval page.');
      }
      onData(value);
    });
  };

  return (
    <section className="view preview">
      <header>
        <h2>{data.operation.title ?? data.operation.id}</h2>
        <StatusBadge status={data.status} />
        <span className="expires">{` Expires ${formatDateTime(data.expiresAt)}`}</span>
      </header>
      <PlanSection plan={data.plan} />
      <StatsSummary stats={data.stats} {...(hash === undefined ? {} : { hash })} />
      {opaque ? <FilesSection files={data.files ?? []} {...(actions.filesSource === undefined ? {} : { source: actions.filesSource })} /> : null}
      {opaque ? <RawArguments args={data.args ?? {}} /> : null}
      {opaque ? null : (
      <div className="filters" role="group" aria-label="Show">
        {FILTERS.map(({ label, filter }) => (
          <button
            key={label}
            type="button"
            aria-pressed={pages.filter === filter}
            onClick={() => {
              clearSelection();
              pages.setFilter(filter);
            }}
          >
            {label}
          </button>
        ))}
      </div>
      )}
      {opaque ? null : (
      <>
      <ItemTable
        rows={pages.page.items}
        {...(data.action === undefined ? {} : { action: data.action })}
        {...(data.reasonTitles === undefined ? {} : { reasonTitles: data.reasonTitles })}
        {...(canEdit
          ? {
              selection: {
                selected: new Set(edits.keys()),
                canSelect: (row: ItemRowModel) => editFor(row) !== undefined,
                isDisabled: (row: ItemRowModel) => atLimit && !edits.has(row.targetId),
                toggle,
              },
            }
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
      </>
      )}
      <ActionBar>
        {canEdit ? (
          <>
            <button type="button" disabled={action.busy || toExclude.length === 0} onClick={sendEdit}>
              {`Exclude selected (${String(toExclude.length)})`}
            </button>
            <button type="button" disabled={action.busy || toInclude.length === 0} onClick={sendEdit}>
              {`Include selected (${String(toInclude.length)})`}
            </button>
          </>
        ) : null}
        {exportItems
          ? (['csv', 'xlsx'] as const).map((format) => (
              <button
                key={format}
                type="button"
                disabled={action.busy}
                onClick={() => {
                  start();
                  action.run('', () => exportItems(format), () => undefined);
                }}
              >
                {`Export ${format.toUpperCase()}`}
              </button>
            ))
          : null}
        {submit && data.permissions.canSubmit && hash !== undefined ? (
          <button
            type="button"
            className="primary"
            disabled={action.busy}
            onClick={() => {
              sendSubmit(hash);
            }}
          >
            {`Submit ${plural(data.stats.included, 'change')}`}
          </button>
        ) : null}
        {openPage ? (
          <button
            type="button"
            disabled={action.busy}
            onClick={() => {
              start();
              action.run('', openPage, () => undefined);
            }}
          >
            Open as page
          </button>
        ) : null}
      </ActionBar>
      {atLimit ? (
        <Notice kind="info">{`At most ${String(SELECTION_LIMIT)} items can be selected at once.`}</Notice>
      ) : null}
      {notice === undefined ? null : <Notice kind="info">{notice}</Notice>}
      {action.message === undefined ? null : <Notice kind="error">{action.message}</Notice>}
      {pages.error === undefined ? null : <Notice kind="error">{pages.error}</Notice>}
    </section>
  );
}
