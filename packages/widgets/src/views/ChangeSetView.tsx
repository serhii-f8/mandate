// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The AI Operations Layer Authors
import { Fragment, type ReactElement } from 'react';
import { ActionBar } from '../components/ActionBar.js';
import { Notice } from '../components/Notice.js';
import { StatusBadge } from '../components/StatusBadge.js';
import { formatDateTime } from '../format.js';
import type { ApprovalStateModel, ChangeSetActions, ChangeSetViewModel, StepDecisionModel } from '../model.js';
import { PreviewView, type ViewProps } from './PreviewView.js';
import { ProgressView } from './ProgressView.js';
import { ResultView } from './ResultView.js';
import { useAction } from './useAction.js';

type Props = ViewProps<ChangeSetViewModel, ChangeSetActions>;

const PROGRESS_STATUSES: readonly string[] = ['approved', 'executing', 'rolling_back'];
const RESULT_STATUSES: readonly string[] = ['completed', 'completed_with_errors', 'failed', 'cancelled', 'rolled_back'];

function Title({ data }: { data: ChangeSetViewModel }): ReactElement {
  return (
    <header>
      <h2>{data.operation.title ?? data.operation.id}</h2>
      <StatusBadge status={data.status} />
    </header>
  );
}

function Decision({ d }: { d: StepDecisionModel }): ReactElement {
  return (
    <>
      {`${d.decision} by ${d.by} (${d.channel}, ${formatDateTime(d.ts)})`}
      {d.comment === undefined ? null : <q className="comment">{d.comment}</q>}
    </>
  );
}

/** A change-set waiting for approval (UI-2): round, steps and the decisions so far. */
function PendingView({ data, actions }: Props): ReactElement {
  const action = useAction();
  const openPage = actions.openPage?.bind(actions);
  return (
    <section className="view pending">
      <Title data={data} />
      {data.approval ? (
        <>
          <p className="round">{`Round ${String(data.approval.round)}`}</p>
          <ol className="steps">
            {data.approval.steps.map((s) => (
              <li key={s.step}>
                {`Step ${String(s.step)} · ${s.role}: `}
                {s.decision ? <Decision d={s.decision} /> : 'waiting'}
              </li>
            ))}
          </ol>
        </>
      ) : null}
      <Notice kind="info">Submitted for approval. Approvers decide on the approval page.</Notice>
      {openPage ? (
        <ActionBar>
          <button
            type="button"
            disabled={action.busy}
            onClick={() => {
              action.run('', openPage, () => undefined);
            }}
          >
            Open as page
          </button>
        </ActionBar>
      ) : null}
      {action.message === undefined ? null : <Notice kind="error">{action.message}</Notice>}
    </section>
  );
}

/** The deciding approver's step: the rejecting one, else the last step that has a decision. */
function decidingStep(approval: ApprovalStateModel | undefined): StepDecisionModel | undefined {
  const decided = (approval?.steps ?? []).flatMap((s) => (s.decision ? [s.decision] : []));
  return decided.find((d) => d.decision === 'reject') ?? decided[decided.length - 1];
}

/** A rejected or expired change-set: its status and the approver's comment, as text (SEC-5). */
function ClosedView({ data }: { data: ChangeSetViewModel }): ReactElement {
  const decision = decidingStep(data.approval);
  return (
    <section className="view closed">
      <Title data={data} />
      {decision?.comment === undefined ? null : (
        <p>
          {`${decision.by}: `}
          <q className="comment">{decision.comment}</q>
        </p>
      )}
    </section>
  );
}

function Preparing({ data }: { data: ChangeSetViewModel }): ReactElement {
  return (
    <section className="view preparing">
      <Title data={data} />
      <p>Being prepared…</p>
    </section>
  );
}

function viewFor(props: Props): ReactElement {
  const { status } = props.data;
  if (status === 'preparing') return <Preparing data={props.data} />;
  if (status === 'prepared') return <PreviewView {...props} />;
  if (status === 'pending_approval') return <PendingView {...props} />;
  if (PROGRESS_STATUSES.includes(status)) return <ProgressView {...props} />;
  if (RESULT_STATUSES.includes(status)) return <ResultView {...props} />;
  return <ClosedView data={props.data} />;
}

/**
 * Picks the view by status (UI-2). The status is the key: a new status mounts a fresh view, so its
 * item pages and notices start over (ruling F4); a refresh with the same status keeps them.
 */
export function ChangeSetView(props: Props): ReactElement {
  return <Fragment key={props.data.status}>{viewFor(props)}</Fragment>;
}
