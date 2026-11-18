import type { ReactElement } from 'react';
import type { ChangeSetDetail, DecideBody, DecideOutcome, ItemRow, ItemsPage, Sample } from '../api.js';

export interface ChangeSetViewProps {
  detail: ChangeSetDetail;
  items: ItemsPage;
  sample: Sample;
  hasPrevious: boolean;
  statusFilter?: string;
  onResample: () => void;
  onNext: () => void;
  onPrevious: () => void;
  onStatusFilter: (status: string | undefined) => void;
  freshLoginUrl: string;
  onDecide: (body: DecideBody) => Promise<DecideOutcome>;
  onStart: () => Promise<DecideOutcome>;
}

const ITEM_STATUSES = ['pending', 'excluded', 'written', 'failed', 'skipped'] as const;

/** Upstream values are data: shown as JSON text, escaped by React (SEC-5). */
// JSON.stringify returns undefined for an undefined value although its type says string.
const text = (value: unknown): string => {
  const out: unknown = JSON.stringify(value, null, 2);
  return typeof out === 'string' ? out : '';
};

function ItemTable(props: { rows: ItemRow[] }): ReactElement {
  return (
    <table>
      <thead>
        <tr>
          <th>Target</th>
          <th>Status</th>
          <th>Before</th>
          <th>After</th>
          <th>Note</th>
        </tr>
      </thead>
      <tbody>
        {props.rows.map((r) => (
          <tr key={r.targetId}>
            <td>{r.targetId}</td>
            <td>{r.status}</td>
            <td>
              <pre>{text(r.before)}</pre>
            </td>
            <td>
              <pre>{text(r.after)}</pre>
            </td>
            <td>{r.reason ?? r.error ?? ''}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

/** Read part of the change-set page, sections in design order (UI-2, APR-5, APR-3, NFR-8). */
export function ChangeSetView(props: ChangeSetViewProps): ReactElement {
  const { detail, items, sample } = props;
  const { request, policy, stats, approval } = detail;
  const excluded = Object.entries(stats.excluded);
  return (
    <main>
      <section aria-label="Summary">
        <h1>{detail.operation.title ?? detail.operation.id}</h1>
        <p>Status: {detail.status}</p>
        {detail.hash === undefined ? null : <p>Hash: {detail.hash}</p>}
        <p>Expires: {detail.expiresAt}</p>
      </section>
      <section aria-label="Request">
        <h2>Request</h2>
        <p>Requester: {request.requester}</p>
        {request.clientId === undefined ? null : <p>Client: {request.clientId}</p>}
        <p>Created: {request.createdAt}</p>
        {request.submittedAt === undefined ? null : <p>Submitted: {request.submittedAt}</p>}
        <pre>{JSON.stringify(request.args, null, 2)}</pre>
      </section>
      <section aria-label="Policy">
        <h2>Policy</h2>
        {policy === undefined ? (
          <p>No policy information.</p>
        ) : (
          <>
            <p>Allowed by {policy.rule}</p>
            {policy.approval === undefined ? null : (
              <p>
                {policy.approval.threshold === undefined
                  ? `Approval is required (${policy.approval.reason}).`
                  : `${String(policy.approval.included)} changes, above the threshold of ${String(policy.approval.threshold)}`}
              </p>
            )}
          </>
        )}
      </section>
      <section aria-label="Statistics">
        <h2>Statistics</h2>
        <p>
          {stats.total} total, {stats.included} included, {stats.written} written, {stats.failed} failed, {stats.skipped} skipped
        </p>
        {excluded.length === 0 ? null : (
          <ul>
            {excluded.map(([reason, n]) => (
              <li key={reason}>{`${reason}: ${String(n)}`}</li>
            ))}
          </ul>
        )}
      </section>
      <section aria-label="Sample">
        <h2>Sample</h2>
        <button type="button" onClick={props.onResample}>
          Re-sample
        </button>
        <ItemTable rows={sample.items} />
      </section>
      <section aria-label="Items">
        <h2>Items</h2>
        <label>
          Status
          <select value={props.statusFilter ?? ''} onChange={(e) => {
              props.onStatusFilter(e.target.value === '' ? undefined : e.target.value);
            }}>
            <option value="">All</option>
            {ITEM_STATUSES.map((s) => (
              <option key={s} value={s}>
                {s}
              </option>
            ))}
          </select>
        </label>
        <ItemTable rows={items.items} />
        <button type="button" disabled={!props.hasPrevious} onClick={props.onPrevious}>
          Previous
        </button>
        <button type="button" disabled={items.next === undefined} onClick={props.onNext}>
          Next
        </button>
      </section>
      <section aria-label="Approval chain">
        <h2>Approval chain</h2>
        {approval === undefined ? (
          <p>No approval chain.</p>
        ) : (
          <ol>
            {approval.steps.map((s) => (
              <li key={s.step}>
                <span>{`Step ${String(s.step)}: ${s.role}`}</span>{' '}
                {s.decision === undefined ? (
                  <span>{s.role === approval.awaitingRole ? 'awaiting' : 'pending'}</span>
                ) : (
                  <span>
                    {`${s.decision.decision} by ${s.decision.name ?? s.decision.approver} at ${s.decision.ts}`}
                    {s.decision.comment === undefined ? null : <q>{s.decision.comment}</q>}
                  </span>
                )}
              </li>
            ))}
          </ol>
        )}
      </section>
      <section aria-label="Decision" />
    </main>
  );
}
