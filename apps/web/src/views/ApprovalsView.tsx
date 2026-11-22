// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Mandate Authors
import type { ReactElement } from 'react';
import type { ApprovalQueue } from '../api.js';
import { changesetPath } from '../routes.js';

/** The approval queue: one row per change-set awaiting the viewer, linked by id only (UI-2, APR-7). */
export function ApprovalsView(props: { queue: ApprovalQueue; onMore?: () => void }): ReactElement {
  const { queue, onMore } = props;
  return (
    <main>
      <h1>Approvals</h1>
      {queue.items.length === 0 ? (
        <p>Nothing awaits your decision.</p>
      ) : (
        <table>
          <thead>
            <tr>
              <th>Change-set</th>
              <th>Operation</th>
              <th>Requester</th>
              <th>Changes</th>
              <th>Step</th>
              <th>Expires</th>
            </tr>
          </thead>
          <tbody>
            {queue.items.map((e) => (
              <tr key={e.id}>
                <td>
                  <a href={changesetPath(e.id)}>{e.title}</a>
                </td>
                <td>{e.operation}</td>
                <td>{e.requester}</td>
                <td>{e.total}</td>
                <td>{`Step ${String(e.step)} of ${String(e.steps)}`}</td>
                <td>{e.expiresAt}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {queue.next !== undefined && onMore !== undefined ? (
        <button type="button" onClick={onMore}>
          More
        </button>
      ) : null}
    </main>
  );
}
