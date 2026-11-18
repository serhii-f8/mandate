import { useEffect, useMemo, useRef, useState, type ReactElement } from 'react';
import type { CallToolResult } from '@modelcontextprotocol/client';
import type { ApprovalViewModel } from '../model.js';
import { ApprovalView } from '../views/ApprovalView.js';
import { parseApprovalTrigger, type ApprovalTrigger } from './adapters.js';
import { approvalActions, type WidgetApp } from './bridge.js';
import { TextResult } from './TextResult.js';

/**
 * The approval widget (UI-1, APR-8): the `review_changeset` result as the shared approval view.
 * It does not poll; the server decides whether this channel may decide (SEC-1).
 */
export function ApprovalWidget(props: { app: WidgetApp | null; trigger: CallToolResult | undefined; error?: Error }): ReactElement {
  const { app, trigger } = props;
  const [shown, setShown] = useState<ApprovalTrigger | undefined>();
  const model = shown?.kind === 'view' ? shown.model : undefined;
  // Actions run after renders; the ref gives them the change-set shown now.
  const modelRef = useRef(model);
  modelRef.current = model;

  useEffect(() => {
    if (trigger !== undefined) setShown(parseApprovalTrigger(trigger));
  }, [trigger]);

  const shape = model === undefined ? 'none' : model.pageUrl === undefined ? 'no-page' : 'page';
  const actions = useMemo(() => {
    if (app === null || shape === 'none') return undefined;
    const current = (): ApprovalViewModel => {
      const m = modelRef.current;
      if (m === undefined) throw new Error('no change-set is shown');
      return m;
    };
    return approvalActions(app, current);
  }, [app, shape]);

  if (props.error !== undefined) return <p role="alert">The widget could not connect to the host.</p>;
  if (shown === undefined) return <p>Waiting for data…</p>;
  if (shown.kind === 'text') return <TextResult app={app} text={shown.text} pageUrl={shown.pageUrl} />;
  if (actions === undefined) return <p>Loading…</p>;
  return (
    // Keyed by status as on the page: a new status mounts a fresh view with the reloaded items (ruling F4).
    <ApprovalView
      key={shown.model.status}
      data={shown.model}
      actions={actions}
      onData={(next) => {
        setShown({ kind: 'view', model: next });
      }}
    />
  );
}
