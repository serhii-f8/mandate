// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Mandate Authors
import { type ReactElement, useCallback, useState } from 'react';
import { ItemTable } from '../components/ItemTable.js';
import { Notice } from '../components/Notice.js';
import { RawArguments } from '../components/RawArguments.js';
import { PlanSection } from '../components/PlanSection.js';
import { Pager } from '../components/Pager.js';
import { StatusBadge } from '../components/StatusBadge.js';
import { formatDateTime, plural } from '../format.js';
import type { ApprovalActions, ApprovalViewModel, DecisionInput, ItemFilter } from '../model.js';
import { useItemPages } from '../paging.js';
import type { ViewProps } from './PreviewView.js';
import { type Action, useAction } from './useAction.js';

type Props = ViewProps<ApprovalViewModel, ApprovalActions>;

const ITEM_STATUSES: readonly ItemFilter[] = ['pending', 'excluded', 'written', 'failed', 'skipped'];

const REASON_TEXT: Readonly<Record<string, string>> = {
  separation_of_duties: 'You cannot decide this step: you requested this change-set or decided an earlier step.',
  not_approver: 'This step awaits another role.',
  not_pending: 'This change-set is not awaiting a decision.',
  expired: 'This change-set has expired.',
  widget_not_allowed: 'Decisions on this change-set are made on the approval page.',
  step_up_required: 'This change-set needs a recent login; decide on the approval page.',
};

function reasonText(reason: string | null): string {
  return (reason === null ? undefined : REASON_TEXT[reason]) ?? 'You cannot decide this change-set.';
}

/** APR-6: the approve control states what is approved; an update keeps its text. */
function approveText(data: ApprovalViewModel, n: number): string {
  if (data.kind === 'opaque') return 'Approve 1 call';
  if (data.action === 'create') return `Approve creating ${plural(n, 'record')}`;
  if (data.action === 'delete') return `Approve deleting ${plural(n, 'record')}`;
  return `Approve ${plural(n, 'change')}`;
}

/** Which section started the running or last action, so its message shows there. */
type Origin = 'sample' | 'decision';

function Time({ iso }: { iso: string }): ReactElement {
  return <time dateTime={iso}>{formatDateTime(iso)}</time>;
}

/**
 * The decision part (APR-4, APR-6, APR-7, APR-8, SEC-8, AUTH-6). Only the server's `viewer` block decides what
 * shows, for the entry's channel; the approve button names the count it sends and the hash is the one shown.
 */
function DecisionPanel(props: Props & { action: Action; origin: Origin | undefined; begin: () => void }): ReactElement {
  const { data, actions, onData, action, origin, begin } = props;
  const { viewer } = data;
  const [comment, setComment] = useState('');
  const n = data.stats.included;
  const decide = actions.decide?.bind(actions);
  const start = actions.start?.bind(actions);
  const openPage = actions.openPage?.bind(actions);

  const send = (decision: DecisionInput['decision']): void => {
    if (!decide) return;
    const text = comment.trim();
    begin();
    action.run(
      'Not decided: ',
      () => decide({ decision, hash: data.hash ?? '', count: n, ...(text === '' ? {} : { comment: text }) }),
      onData,
    );
  };

  let body: ReactElement | null = null;
  if (viewer.canDecide && viewer.needsFreshLogin) {
    body =
      data.freshLoginUrl === undefined ? (
        <p>{reasonText('step_up_required')}</p>
      ) : (
        <a href={data.freshLoginUrl}>Log in again to decide</a>
      );
  } else if (viewer.canDecide && decide) {
    body = (
      <>
        <label>
          Comment
          <textarea
            value={comment}
            onChange={(e) => {
              setComment(e.target.value);
            }}
          />
        </label>
        <button
          type="button"
          className="primary"
          disabled={action.busy}
          onClick={() => {
            send('approve');
          }}
        >
          {approveText(data, n)}
        </button>
        <button
          type="button"
          className="danger"
          disabled={action.busy}
          onClick={() => {
            send('reject');
          }}
        >
          Reject
        </button>
        <button
          type="button"
          disabled={action.busy || comment.trim() === ''}
          onClick={() => {
            send('return');
          }}
        >
          Return with comment
        </button>
      </>
    );
  } else if (data.status === 'pending_approval') {
    body = (
      <>
        <p>{reasonText(viewer.reason)}</p>
        {viewer.channel === 'widget' && openPage ? (
          <button
            type="button"
            disabled={action.busy}
            onClick={() => {
              begin();
              action.run('', openPage, () => undefined);
            }}
          >
            Decide on the approval page
          </button>
        ) : null}
      </>
    );
  }
  const canStart = viewer.canStart && start !== undefined;
  // Nothing to act on: say so plainly, and leave the panel unmarked.
  const open = body !== null || canStart;
  if (!open) body = <p>{`Nothing to decide: this change-set is ${data.status}.`}</p>;
  return (
    <section aria-label="Decision" className={open ? 'decision open' : 'decision'}>
      <h2>Decision</h2>
      {body}
      {canStart ? (
        <button
          type="button"
          className="primary"
          disabled={action.busy}
          onClick={() => {
            begin();
            action.run('Not started: ', start, onData);
          }}
        >
          Start execution
        </button>
      ) : null}
      {origin === 'decision' && action.message !== undefined ? <Notice kind="error">{action.message}</Notice> : null}
    </section>
  );
}

/** The approval view, sections in design order (UI-2, APR-3, APR-5, NFR-8); used by the page and the widget. */
export function ApprovalView({ data, actions, onData }: Props): ReactElement {
  const { request, policy, stats, approval } = data;
  const loadItems = useCallback((q: Parameters<ApprovalActions['loadItems']>[0]) => actions.loadItems(q), [actions]);
  const pages = useItemPages(data.items, data.itemFilter, loadItems, data.id);
  const action = useAction();
  const [origin, setOrigin] = useState<Origin | undefined>(undefined);
  // A click while another action runs is ignored by `run`; it must not move the running action's message.
  const beginAt = (o: Origin) => (): void => {
    if (!action.busy) setOrigin(o);
  };
  const excluded = Object.entries(stats.excluded);
  const opaque = data.kind === 'opaque';

  return (
    <main className="view approval">
      <section aria-label="Summary">
        <h1>{data.operation.title ?? data.operation.id}</h1>
        <p>
          {'Status: '}
          <StatusBadge status={data.status} />
        </p>
        {data.hash === undefined ? null : <p className="hash">{`Hash: ${data.hash}`}</p>}
        <p>
          {'Expires: '}
          <Time iso={data.expiresAt} />
        </p>
        <PlanSection plan={data.plan} />
      </section>
      <section aria-label="Request">
        <h2>Request</h2>
        <p>{`Requester: ${request.requester}`}</p>
        {request.clientId === undefined ? null : <p>{`Client: ${request.clientId}`}</p>}
        <p>
          {'Created: '}
          <Time iso={request.createdAt} />
        </p>
        {request.submittedAt === undefined ? null : (
          <p>
            {'Submitted: '}
            <Time iso={request.submittedAt} />
          </p>
        )}
        {opaque ? null : <pre>{JSON.stringify(request.args, null, 2)}</pre>}
      </section>
      <section aria-label="Policy">
        <h2>Policy</h2>
        {policy === undefined ? (
          <p>No policy information.</p>
        ) : (
          <>
            <p>{`Allowed by ${policy.rule}`}</p>
            {policy.approval === undefined ? null : (
              <p>
                {policy.approval.threshold === undefined
                  ? `Approval is required (${policy.approval.reason}).`
                  : `${String(policy.approval.included)} changes, above the threshold of ` +
                    String(policy.approval.threshold)}
              </p>
            )}
          </>
        )}
      </section>
      <section aria-label="Statistics">
        <h2>Statistics</h2>
        <p>
          {`${String(stats.total)} total, ${String(stats.included)} included, ${String(stats.written)} written, `}
          {`${String(stats.failed)} failed, ${String(stats.skipped)} skipped`}
        </p>
        {excluded.length === 0 ? null : (
          <ul>
            {excluded.map(([reason, count]) => (
              <li key={reason}>{`${reason}: ${String(count)}`}</li>
            ))}
          </ul>
        )}
      </section>
      {opaque ? <RawArguments args={request.args} /> : null}
      {opaque ? null : (
      <>
      <section aria-label="Sample">
        <h2>Sample</h2>
        <button
          type="button"
          disabled={action.busy}
          onClick={() => {
            beginAt('sample')();
            action.run('', () => actions.resample(), (sample) => {
              onData({ ...data, sample });
            });
          }}
        >
          Re-sample
        </button>
        <ItemTable
          rows={data.sample.items}
          {...(data.action === undefined ? {} : { action: data.action })}
          {...(data.reasonTitles === undefined ? {} : { reasonTitles: data.reasonTitles })}
        />
        {origin === 'sample' && action.message !== undefined ? <Notice kind="error">{action.message}</Notice> : null}
      </section>
      <section aria-label="Items">
        <h2>Items</h2>
        <label>
          Status
          <select
            value={pages.filter ?? ''}
            onChange={(e) => {
              const value = ITEM_STATUSES.find((s) => s === e.target.value);
              pages.setFilter(value);
            }}
          >
            <option value="">All</option>
            {ITEM_STATUSES.map((s) => (
              <option key={s} value={s}>
                {s}
              </option>
            ))}
          </select>
        </label>
        <ItemTable
          rows={pages.page.items}
          {...(data.action === undefined ? {} : { action: data.action })}
          {...(data.reasonTitles === undefined ? {} : { reasonTitles: data.reasonTitles })}
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
        {pages.error === undefined ? null : <Notice kind="error">{pages.error}</Notice>}
      </section>
      </>
      )}
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
                  <span className={s.role === approval.awaitingRole ? 'awaiting' : undefined}>
                    {s.role === approval.awaitingRole ? 'awaiting' : 'pending'}
                  </span>
                ) : (
                  <span>
                    {`${s.decision.decision} by ${s.decision.by} at ${formatDateTime(s.decision.ts)}`}
                    {s.decision.comment === undefined ? null : <q>{s.decision.comment}</q>}
                  </span>
                )}
              </li>
            ))}
          </ol>
        )}
      </section>
      <DecisionPanel
        data={data}
        actions={actions}
        onData={onData}
        action={action}
        origin={origin}
        begin={beginAt('decision')}
      />
    </main>
  );
}
