// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Mandate Authors
import { memo, type ReactElement } from 'react';
import { fieldRows } from '../format.js';
import type { ChangeSetAction, ItemRowModel } from '../model.js';
import { StatusBadge } from './StatusBadge.js';
import { Value } from './Value.js';

export interface ItemTableProps {
  rows: ItemRowModel[];
  selection?: {
    selected: ReadonlySet<string>;
    canSelect: (row: ItemRowModel) => boolean;
    /** A selectable row whose checkbox is shown but cannot be changed (selection limit). */
    isDisabled?: (row: ItemRowModel) => boolean;
    toggle: (targetId: string) => void;
  };
  /** Shown as the only row when there are no rows; absent: the table stays empty (the page may still load). */
  empty?: string;
  /** The change-set's action; a creation or deletion marks every row. */
  action?: ChangeSetAction;
  /** CS-3: titles of check codes from the current configuration, shown beside the stored code. */
  reasonTitles?: Readonly<Record<string, string>>;
  /** EXE-12: texts for verification codes, shown beside an unconfirmed item. */
  verificationTitles?: Readonly<Record<string, string>>;
}

function titleOf(titles: Readonly<Record<string, string>> | undefined, code: string): string | undefined {
  return titles !== undefined && Object.hasOwn(titles, code) ? titles[code] : undefined;
}

function note(row: ItemRowModel, reasonTitles: Readonly<Record<string, string>> | undefined, verificationTitles: Readonly<Record<string, string>> | undefined): string {
  if (row.status === 'excluded') {
    const reason = row.reason ?? '';
    const title = reasonTitles !== undefined && Object.hasOwn(reasonTitles, reason) ? reasonTitles[reason] : undefined;
    return title === undefined ? `excluded: ${reason}` : `excluded: ${title} (${reason})`;
  }
  if (row.status === 'failed') return row.error ?? '';
  if (row.verificationStatus === 'unconfirmed') {
    const code = row.verificationCode;
    return code === undefined ? 'Not confirmed' : `Not confirmed: ${titleOf(verificationTitles, code) ?? code}`;
  }
  return '';
}

/** APR-6: the badge follows the change-set's action, not the nullness of a side; an update has none. */
function actionBadge(action: ChangeSetAction | undefined): 'new' | 'delete' | undefined {
  if (action === 'create') return 'new';
  if (action === 'delete') return 'delete';
  return undefined;
}

interface RowProps {
  row: ItemRowModel;
  action?: ChangeSetAction;
  reasonTitles?: Readonly<Record<string, string>>;
  verificationTitles?: Readonly<Record<string, string>>;
  /** Absent without a selection column; otherwise whether the row has a checkbox and its state. */
  box?: { selectable: boolean; checked: boolean; disabled: boolean; toggle: (targetId: string) => void };
}

/** One item; memoised so a selection change re-renders only the rows whose checkbox changed. */
const ItemRows = memo(function ItemRows({ row, action, reasonTitles, verificationTitles, box }: RowProps): ReactElement {
  const excluded = row.status === 'excluded';
  const fields = excluded ? [] : fieldRows(row);
  const span = excluded ? 1 : fields.length;
  const badge = actionBadge(action);
  const head = (
    <>
      {box ? (
        <td rowSpan={span}>
          {box.selectable ? (
            <input
              type="checkbox"
              aria-label={`Select ${row.targetId}`}
              checked={box.checked}
              disabled={box.disabled}
              onChange={() => {
                box.toggle(row.targetId);
              }}
            />
          ) : null}
        </td>
      ) : null}
      <td rowSpan={span} className="target">
        {row.targetId}
        {badge ? <span className={`action-badge action-${badge}`}>{badge}</span> : null}
      </td>
      <td rowSpan={span}>
        <StatusBadge status={row.status} />
      </td>
    </>
  );
  if (excluded) {
    return (
      <tr>
        {head}
        <td />
        <td />
        <td />
        <td>{note(row, reasonTitles, verificationTitles)}</td>
      </tr>
    );
  }
  return (
    <>
      {fields.map((f, i) => (
        <tr key={String(i)}>
          {i === 0 ? head : null}
          <td>{f.field ?? ''}</td>
          <td className="before">
            <Value value={f.before} />
          </td>
          <td className="after">
            <Value value={f.after} />
          </td>
          <td rowSpan={1}>{i === 0 ? note(row, reasonTitles, verificationTitles) : ''}</td>
        </tr>
      ))}
    </>
  );
}, sameRow);

function sameRow(a: RowProps, b: RowProps): boolean {
  if (a.row !== b.row || a.action !== b.action || a.reasonTitles !== b.reasonTitles || a.verificationTitles !== b.verificationTitles) return false;
  if (!a.box || !b.box) return a.box === b.box;
  return (
    a.box.selectable === b.box.selectable &&
    a.box.checked === b.box.checked &&
    a.box.disabled === b.box.disabled &&
    a.box.toggle === b.box.toggle
  );
}

export function ItemTable({ rows, selection, empty, action, reasonTitles, verificationTitles }: ItemTableProps): ReactElement {
  return (
    <table className="items">
      <thead>
        <tr>
          {selection ? <th scope="col" /> : null}
          <th scope="col">Target</th>
          <th scope="col">Status</th>
          <th scope="col">Field</th>
          <th scope="col">Before</th>
          <th scope="col">After</th>
          <th scope="col">Note</th>
        </tr>
      </thead>
      <tbody>
        {rows.length === 0 && empty !== undefined ? (
          <tr>
            <td className="empty" colSpan={selection ? 7 : 6}>
              {empty}
            </td>
          </tr>
        ) : null}
        {rows.map((row) => (
          <ItemRows
            key={row.targetId}
            row={row}
            {...(action === undefined ? {} : { action })}
            {...(reasonTitles === undefined ? {} : { reasonTitles })}
            {...(verificationTitles === undefined ? {} : { verificationTitles })}
            {...(selection
              ? {
                  box: {
                    selectable: selection.canSelect(row),
                    checked: selection.selected.has(row.targetId),
                    disabled: selection.isDisabled?.(row) ?? false,
                    toggle: selection.toggle,
                  },
                }
              : {})}
          />
        ))}
      </tbody>
    </table>
  );
}
