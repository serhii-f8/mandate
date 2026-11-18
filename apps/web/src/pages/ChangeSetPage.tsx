import { useCallback, useEffect, useMemo, useState, type ReactElement } from 'react';
import {
  createApi,
  loginUrl,
  NotFound,
  toLogin,
  Unauthenticated,
  type ChangeSetDetail,
  type DecideOutcome,
  type ItemsPage,
  type Sample,
  type Session,
} from '../api.js';
import { changesetPath } from '../routes.js';
import { ChangeSetView } from '../views/ChangeSetView.js';

interface Ready {
  kind: 'ready';
  session: Session;
  detail: ChangeSetDetail;
  items: ItemsPage;
  sample: Sample;
  /** Cursors of the item pages before the current one, plus the current page's own cursor last. */
  cursors: (string | undefined)[];
  statusFilter: string | undefined;
}
type State = { kind: 'loading' } | { kind: 'error' } | { kind: 'not_found' } | Ready;

/** Container of `/app/changesets/<id>`: loads the change-set and turns view callbacks into REST calls (UI-2, UI-7). */
export function ChangeSetPage(props: { id: string }): ReactElement {
  const { id } = props;
  const api = useMemo(() => createApi(), []);
  const path = changesetPath(id);
  const [state, setState] = useState<State>({ kind: 'loading' });

  // 401: log in again and come back here (never an error shown); 404: not found (also for a change-set the viewer may
  // not see); anything else: an error state, never a login redirect.
  const fail = useCallback(
    (error: unknown): void => {
      if (error instanceof Unauthenticated) void toLogin(path, false);
      else if (error instanceof NotFound) setState({ kind: 'not_found' });
      else setState({ kind: 'error' });
    },
    [path],
  );

  useEffect(() => {
    let live = true;
    Promise.all([api.session(), api.changeset(id), api.items(id, {}), api.sample(id)]).then(
      ([session, detail, items, sample]) => {
        if (live) setState({ kind: 'ready', session, detail, items, sample, cursors: [undefined], statusFilter: undefined });
      },
      (error: unknown) => {
        if (live) fail(error);
      },
    );
    return () => {
      live = false;
    };
  }, [api, id, fail]);

  if (state.kind === 'loading') return <p>Loading…</p>;
  if (state.kind === 'error') return <p role="alert">The page could not be loaded.</p>;
  if (state.kind === 'not_found') return <p>Change-set not found.</p>;
  const ready = state;

  const loadItems = (cursors: (string | undefined)[], statusFilter: string | undefined): void => {
    const after = cursors.at(-1);
    api
      .items(id, { ...(after === undefined ? {} : { after }), ...(statusFilter === undefined ? {} : { status: statusFilter }) })
      .then((items) => {
        setState((s) => (s.kind === 'ready' ? { ...s, items, cursors, statusFilter } : s));
      }, fail);
  };
  const reloadDetail = (): void => {
    api.changeset(id).then((detail) => {
      setState((s) => (s.kind === 'ready' ? { ...s, detail } : s));
    }, fail);
  };
  // A refused fresh-session or step-up check is answered by logging in again to this page (SEC-8, AUTH-6).
  const settle = async (call: () => Promise<DecideOutcome>): Promise<DecideOutcome> => {
    try {
      const outcome = await call();
      if (!outcome.ok && (outcome.error === 'reauthentication_required' || outcome.error === 'step_up_required')) return await toLogin(path, true);
      if (outcome.ok) reloadDetail();
      return outcome;
    } catch (error) {
      if (error instanceof Unauthenticated) return toLogin(path, false);
      throw error;
    }
  };

  return (
    <ChangeSetView
      detail={ready.detail}
      items={ready.items}
      sample={ready.sample}
      hasPrevious={ready.cursors.length > 1}
      {...(ready.statusFilter === undefined ? {} : { statusFilter: ready.statusFilter })}
      freshLoginUrl={loginUrl(path, true)}
      onResample={() => {
        api.sample(id).then((sample) => {
          setState((s) => (s.kind === 'ready' ? { ...s, sample } : s));
        }, fail);
      }}
      onNext={() => {
        if (ready.items.next !== undefined) loadItems([...ready.cursors, ready.items.next], ready.statusFilter);
      }}
      onPrevious={() => {
        if (ready.cursors.length > 1) loadItems(ready.cursors.slice(0, -1), ready.statusFilter);
      }}
      onStatusFilter={(status) => {
        loadItems([undefined], status);
      }}
      onDecide={(body) => settle(() => api.decide(ready.session.csrfToken, id, body))}
      onStart={() => settle(() => api.start(ready.session.csrfToken, id))}
    />
  );
}
