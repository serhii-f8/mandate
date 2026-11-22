// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Mandate Authors
import { useState, type SyntheticEvent, type ReactElement } from 'react';
import { Notice } from '../components/Notice.js';

export interface AuditFilters {
  actor?: string;
  action?: string;
  outcome?: string;
  changeset?: string;
  correlation?: string;
  from?: string;
  to?: string;
}

export interface AuditEventModel {
  seq: string;
  ts: string;
  actor: string;
  action: string;
  outcome: string;
  subject: string | null;
  changesetId: string | null;
  correlationId: string;
  chainPos: number | null;
  details: Record<string, unknown>;
}

export interface AuditSearchViewProps {
  events: readonly AuditEventModel[];
  filters: AuditFilters;
  exportUrl: string;
  onSearch: (filters: AuditFilters) => void;
  onMore?: () => void;
  error?: string;
}

const TEXT_FILTERS: readonly { key: Exclude<keyof AuditFilters, 'outcome'>; label: string }[] = [
  { key: 'actor', label: 'Actor' },
  { key: 'action', label: 'Action' },
  { key: 'changeset', label: 'Change-set' },
  { key: 'correlation', label: 'Correlation' },
  { key: 'from', label: 'From' },
  { key: 'to', label: 'To' },
];

/** The audit log search: filters, one row per event, details as text, JSON Lines export (UI-2, AUD-6). No authority: the api decides. */
export function AuditSearchView(props: AuditSearchViewProps): ReactElement {
  const { events, filters, exportUrl, onSearch, onMore, error } = props;
  const [draft, setDraft] = useState<AuditFilters>(filters);

  const submit = (e: SyntheticEvent): void => {
    e.preventDefault();
    const clean: AuditFilters = {};
    for (const [key, value] of Object.entries(draft) as [keyof AuditFilters, string | undefined][]) {
      if (value !== undefined && value.trim() !== '') clean[key] = value.trim();
    }
    onSearch(clean);
  };

  return (
    <main>
      <h1>Audit log</h1>
      <form onSubmit={submit}>
        {TEXT_FILTERS.map(({ key, label }) => (
          <label key={key}>
            {label}
            <input value={draft[key] ?? ''} onChange={(e) => {
                setDraft({ ...draft, [key]: e.target.value });
              }} />
          </label>
        ))}
        <label>
          Outcome
          <select value={draft.outcome ?? ''} onChange={(e) => {
              setDraft({ ...draft, outcome: e.target.value });
            }}>
            <option value="">Any</option>
            <option value="ok">ok</option>
            <option value="error">error</option>
            <option value="denied">denied</option>
          </select>
        </label>
        <button type="submit">Search</button>
      </form>
      {error === undefined ? null : <Notice kind="error">{error}</Notice>}
      <p>
        <a href={exportUrl}>Export JSON Lines</a>
      </p>
      {events.length === 0 ? (
        <p>No events match.</p>
      ) : (
        <table>
          <thead>
            <tr>
              <th>Time</th>
              <th>Actor</th>
              <th>Action</th>
              <th>Outcome</th>
              <th>Subject</th>
              <th>Chain</th>
              <th>Details</th>
            </tr>
          </thead>
          <tbody>
            {events.map((ev) => (
              <tr key={ev.seq}>
                <td>{ev.ts}</td>
                <td>{ev.actor}</td>
                <td>{ev.action}</td>
                <td>{ev.outcome}</td>
                <td>{ev.subject ?? ''}</td>
                <td>{ev.chainPos === null ? 'unsealed' : String(ev.chainPos)}</td>
                <td>
                  <details>
                    <summary>Details</summary>
                    <pre>{JSON.stringify(ev.details, null, 2)}</pre>
                  </details>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {onMore === undefined ? null : (
        <button type="button" onClick={onMore}>
          More
        </button>
      )}
    </main>
  );
}
