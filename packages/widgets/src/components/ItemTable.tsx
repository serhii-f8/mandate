import type { ReactElement } from 'react';
import { fieldRows } from '../format.js';
import type { ItemRowModel } from '../model.js';
import { StatusBadge } from './StatusBadge.js';
import { Value } from './Value.js';

export interface ItemTableProps {
  rows: ItemRowModel[];
  selection?: {
    selected: ReadonlySet<string>;
    canSelect: (row: ItemRowModel) => boolean;
    toggle: (targetId: string) => void;
  };
}

function note(row: ItemRowModel): string {
  if (row.status === 'excluded') return `excluded: ${row.reason ?? ''}`;
  if (row.status === 'failed') return row.error ?? '';
  return '';
}

export function ItemTable({ rows, selection }: ItemTableProps): ReactElement {
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
        {rows.map((row) => {
          const excluded = row.status === 'excluded';
          const fields = excluded ? [] : fieldRows(row);
          const span = excluded ? 1 : fields.length;
          const head = (
            <>
              {selection ? (
                <td rowSpan={span}>
                  {selection.canSelect(row) ? (
                    <input
                      type="checkbox"
                      aria-label={`Select ${row.targetId}`}
                      checked={selection.selected.has(row.targetId)}
                      onChange={() => {
                        selection.toggle(row.targetId);
                      }}
                    />
                  ) : null}
                </td>
              ) : null}
              <td rowSpan={span}>{row.targetId}</td>
              <td rowSpan={span}>
                <StatusBadge status={row.status} />
              </td>
            </>
          );
          if (excluded) {
            return (
              <tr key={row.targetId}>
                {head}
                <td />
                <td />
                <td />
                <td>{note(row)}</td>
              </tr>
            );
          }
          return fields.map((f, i) => (
            <tr key={`${row.targetId}:${String(i)}`}>
              {i === 0 ? head : null}
              <td>{f.field ?? ''}</td>
              <td>
                <Value value={f.before} />
              </td>
              <td>
                <Value value={f.after} />
              </td>
              <td rowSpan={1}>{i === 0 ? note(row) : ''}</td>
            </tr>
          ));
        })}
      </tbody>
    </table>
  );
}
