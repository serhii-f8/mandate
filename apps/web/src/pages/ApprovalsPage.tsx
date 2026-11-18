import { useEffect, useMemo, useState, type ReactElement } from 'react';
import { createApi, toLogin, Unauthenticated, type ApprovalQueue } from '../api.js';
import { ApprovalsView } from '../views/ApprovalsView.js';

type State = { kind: 'loading' } | { kind: 'error' } | { kind: 'ready'; queue: ApprovalQueue };

const RETURN_TO = '/app/approvals';

/** Container of `/app/approvals`: loads the session and the first queue page, appends pages on "More" (UI-2). */
export function ApprovalsPage(): ReactElement {
  const api = useMemo(() => createApi(), []);
  const [state, setState] = useState<State>({ kind: 'loading' });

  const fail = (error: unknown): void => {
    if (error instanceof Unauthenticated) void toLogin(RETURN_TO, false);
    else setState({ kind: 'error' });
  };

  useEffect(() => {
    let live = true;
    Promise.all([api.session(), api.approvals()]).then(
      ([, queue]) => {
        if (live) setState({ kind: 'ready', queue });
      },
      (error: unknown) => {
        if (live) fail(error);
      },
    );
    return () => {
      live = false;
    };
  }, [api]);

  if (state.kind === 'loading') return <p>Loading…</p>;
  if (state.kind === 'error') return <p role="alert">The page could not be loaded.</p>;
  const { queue } = state;
  return (
    <ApprovalsView
      queue={queue}
      onMore={() => {
        if (queue.next === undefined) return;
        api.approvals(queue.next).then((page) => {
          setState((s) =>
            s.kind === 'ready' ? { kind: 'ready', queue: { items: [...s.queue.items, ...page.items], ...(page.next === undefined ? {} : { next: page.next }) } } : s,
          );
        }, fail);
      }}
    />
  );
}
