import { useCallback, useEffect, useMemo, useRef, useState, type ReactElement } from 'react';
import {
  ApprovalView,
  ChangeSetView,
  POLLED_STATUSES,
  usePolling,
  type ActionResult,
  type ApprovalActions,
  type ApprovalViewModel,
  type ChangeSetActions,
  type ChangeSetViewModel,
} from '@aiops/widgets';
import { toApprovalModel, toChangeSetModel, toItemsPage } from '../adapters.js';
import { createApi, loginUrl, NotFound, toLogin, Unauthenticated, type DecideOutcome, type ItemsPage, type Session } from '../api.js';
import { changesetPath } from '../routes.js';

type Api = ReturnType<typeof createApi>;

/** The requester previews, edits and submits; everyone else gets the approval view (UI-1, UI-3). */
type Shown = { kind: 'requester'; model: ChangeSetViewModel } | { kind: 'approver'; model: ApprovalViewModel };

interface Ready {
  kind: 'ready';
  session: Session;
  /** The current change-set: an exclusion moves the page to the derived one (CS-5). */
  id: string;
  shown: Shown;
}
type State = { kind: 'loading' } | { kind: 'error' } | { kind: 'not_found' } | Ready;

/**
 * Loads the detail of `id` into a model. A different status than `prev` shows (or another ID) also loads
 * the first items page, so a change-set that finishes preparing shows its items; the same status keeps
 * the items the view pages through (ruling F4).
 */
async function fetchShown(api: Api, kind: Shown['kind'], id: string, prev: Shown | undefined): Promise<Shown> {
  const detail = await api.changeset(id);
  const same = prev?.model.id === id && prev.model.status === detail.status;
  const items: ItemsPage = same ? prev.model.items : await api.items(id, {});
  const filter = same ? prev.model.itemFilter : undefined;
  if (kind === 'requester') return { kind, model: toChangeSetModel(detail, items, filter) };
  const sample = prev?.kind === 'approver' && prev.model.id === id ? prev.model.sample : await api.sample(id);
  return { kind, model: toApprovalModel(detail, items, sample, loginUrl(changesetPath(id), true), filter) };
}

/** Container of `/app/changesets/<id>`: loads the change-set and turns view actions into REST calls (UI-2, UI-7). */
export function ChangeSetPage(props: { id: string }): ReactElement {
  const api = useMemo(() => createApi(), []);
  const [state, setState] = useState<State>({ kind: 'loading' });
  // Actions run after renders; the refs give them the current change-set and its path.
  const stateRef = useRef(state);
  stateRef.current = state;
  const pathRef = useRef(changesetPath(props.id));
  pathRef.current = changesetPath(state.kind === 'ready' ? state.id : props.id);

  // 401: log in again and come back here (never an error shown); 404: not found (also for a change-set the viewer may
  // not see); anything else: an error state, never a login redirect.
  const fail = useCallback((error: unknown): void => {
    if (error instanceof Unauthenticated) void toLogin(pathRef.current, false);
    else if (error instanceof NotFound) setState({ kind: 'not_found' });
    else setState({ kind: 'error' });
  }, []);

  useEffect(() => {
    let live = true;
    Promise.all([api.session(), api.changeset(props.id), api.items(props.id, {}), api.sample(props.id)]).then(
      ([session, detail, items, sample]) => {
        if (!live) return;
        const shown: Shown =
          detail.request.requester === session.subject
            ? { kind: 'requester', model: toChangeSetModel(detail, items) }
            : { kind: 'approver', model: toApprovalModel(detail, items, sample, loginUrl(changesetPath(props.id), true)) };
        setState({ kind: 'ready', session, id: props.id, shown });
      },
      (error: unknown) => {
        if (live) fail(error);
      },
    );
    return () => {
      live = false;
    };
  }, [api, props.id, fail]);

  const actions = useMemo(() => {
    const ready = (): Ready => {
      const s = stateRef.current;
      if (s.kind !== 'ready') throw new Error('the change-set is not loaded');
      return s;
    };
    const show = (id: string, shown: Shown): void => {
      setState((s) => (s.kind === 'ready' ? { ...s, id, shown } : s));
    };
    // Reads that fail leave the page as Phase 6 did (login, not found, error state).
    const orFail = async <T,>(call: () => Promise<T>): Promise<ActionResult<T>> => {
      try {
        return { ok: true, value: await call() };
      } catch (error) {
        fail(error);
        return { ok: false, message: 'The page could not be loaded.' };
      }
    };
    // A mutation: a 401 logs in again; a refusal is the view's message; success reloads the change-set.
    const mutate = async <M,>(
      call: () => Promise<{ ok: true } | { ok: false; error: string; count?: number }>,
      reload: () => Promise<M>,
    ): Promise<ActionResult<M>> => {
      let outcome: { ok: true } | { ok: false; error: string; count?: number };
      try {
        outcome = await call();
      } catch (error) {
        if (error instanceof Unauthenticated) return toLogin(pathRef.current, false);
        throw error;
      }
      if (!outcome.ok) {
        const message = outcome.count === undefined ? outcome.error : `${outcome.error} (${String(outcome.count)})`;
        return { ok: false, message };
      }
      return orFail(reload);
    };
    const reload = async (): Promise<Shown> => {
      const s = ready();
      const shown = await fetchShown(api, s.shown.kind, s.id, s.shown);
      show(s.id, shown);
      return shown;
    };
    const loadItems = (q: { after?: string; status?: string }) => orFail(async () => toItemsPage(await api.items(ready().id, q)));

    const requester: ChangeSetActions = {
      loadItems,
      refresh: () => orFail(async () => (await reload()).model as ChangeSetViewModel),
      exclude(edit) {
        const s = ready();
        let newId = '';
        return mutate(
          async () => {
            const outcome = await api.exclude(s.session.csrfToken, s.id, { hash: s.shown.model.hash ?? '', ...edit });
            if (outcome.ok) newId = outcome.id;
            return outcome;
          },
          async () => {
            const shown = await fetchShown(api, 'requester', newId, undefined);
            window.history.replaceState(null, '', changesetPath(newId));
            show(newId, shown);
            return shown.model as ChangeSetViewModel;
          },
        );
      },
      submit(hash) {
        const s = ready();
        return mutate(
          () => api.submit(s.session.csrfToken, s.id, hash),
          async () => (await reload()).model as ChangeSetViewModel,
        );
      },
      rollback() {
        const s = ready();
        return mutate(
          async () => {
            const outcome = await api.rollback(s.session.csrfToken, s.id, s.shown.model.hash ?? '');
            // A stale login is answered by a fresh one, back to this page (SEC-8).
            if (!outcome.ok && outcome.error === 'reauthentication_required') return toLogin(pathRef.current, true);
            return outcome;
          },
          async () => (await reload()).model as ChangeSetViewModel,
        );
      },
      export(format) {
        window.location.assign(api.exportUrl(ready().id, format));
        return Promise.resolve({ ok: true, value: undefined });
      },
    };

    // A refused fresh-session or step-up check is answered by logging in again to this page (SEC-8, AUTH-6).
    const settle = (call: (csrfToken: string, id: string) => Promise<DecideOutcome>) => {
      const s = ready();
      return mutate(
        async () => {
          const outcome = await call(s.session.csrfToken, s.id);
          if (!outcome.ok && (outcome.error === 'reauthentication_required' || outcome.error === 'step_up_required')) return toLogin(pathRef.current, true);
          return outcome;
        },
        async () => (await reload()).model as ApprovalViewModel,
      );
    };
    const approver: ApprovalActions = {
      loadItems,
      resample: () =>
        orFail(async () => {
          const sample = await api.sample(ready().id);
          return { seed: sample.seed, items: toItemsPage({ items: sample.items }).items };
        }),
      decide: (input) => settle((csrf, id) => api.decide(csrf, id, input)),
      start: () => settle((csrf, id) => api.start(csrf, id)),
    };
    return { requester, approver };
  }, [api, fail]);

  const ready = state.kind === 'ready' ? state : undefined;
  const polling = usePolling(ready !== undefined && POLLED_STATUSES.includes(ready.shown.model.status), async () => {
    const s = stateRef.current;
    if (s.kind !== 'ready') return;
    try {
      const shown = await fetchShown(api, s.shown.kind, s.id, s.shown);
      setState((cur) => (cur.kind === 'ready' && cur.id === s.id ? { ...cur, shown } : cur));
    } catch (error) {
      // A lost session or change-set ends the page; a failed poll is retried on the next one.
      if (error instanceof Unauthenticated || error instanceof NotFound) fail(error);
    }
  });

  if (state.kind === 'loading') return <p>Loading…</p>;
  if (state.kind === 'error') return <p role="alert">The page could not be loaded.</p>;
  if (state.kind === 'not_found') return <p>Change-set not found.</p>;
  const { shown } = state;
  const setShown = (next: Shown): void => {
    setState((s) => (s.kind === 'ready' ? { ...s, shown: next } : s));
  };

  return (
    <>
      {shown.kind === 'requester' ? (
        <ChangeSetView
          data={shown.model}
          actions={actions.requester}
          onData={(model) => {
            setShown({ kind: 'requester', model });
          }}
        />
      ) : (
        // Keyed by status like ChangeSetView: a new status mounts a fresh view with the reloaded items (ruling F4).
        <ApprovalView
          key={shown.model.status}
          data={shown.model}
          actions={actions.approver}
          onData={(model) => {
            setShown({ kind: 'approver', model });
          }}
        />
      )}
      {polling.stopped ? (
        <button type="button" onClick={polling.restart}>
          Refresh
        </button>
      ) : null}
    </>
  );
}
