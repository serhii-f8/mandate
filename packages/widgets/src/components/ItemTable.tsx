// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The AI Operations Layer Authors
import { memo, type ReactElement } from 'react';
import { fieldRows } from '../format.js';
import type { ItemRowModel } from '../model.js';
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
}

function note(row: ItemRowModel): string {
  if (row.status === 'excluded') return `excluded: ${row.reason ?? ''}`;
  if (row.status === 'failed') return row.error ?? '';
  return '';
}

interface RowProps {
  row: ItemRowModel;
  /** Absent without a selection column; otherwise whether the row has a checkbox and its state. */
  box?: { selectable: boolean; checked: boolean; disabled: boolean; toggle: (targetId: string) => void };
}

/** One item; memoised so a selection change re-renders only the rows whose checkbox changed. */
const ItemRows = memo(function ItemRows({ row, box }: RowProps): ReactElement {
  const excluded = row.status === 'excluded';
  const fields = excluded ? [] : fieldRows(row);
  const span = excluded ? 1 : fields.length;
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
        <td>{note(row)}</td>
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
          <td rowSpan={1}>{i === 0 ? note(row) : ''}</td>
        </tr>
      ))}
    </>
  );
}, sameRow);

function sameRow(a: RowProps, b: RowProps): boolean {
  if (a.row !== b.row) return false;
  if (!a.box || !b.box) return a.box === b.box;
  return (
    a.box.selectable === b.box.selectable &&
    a.box.checked === b.box.checked &&
    a.box.disabled === b.box.disabled &&
    a.box.toggle === b.box.toggle
  );
}

export function ItemTable({ rows, selection, empty }: ItemTableProps): ReactElement {
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
