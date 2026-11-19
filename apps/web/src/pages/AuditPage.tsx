import { AuditSearchView, type AuditEventModel, type AuditFilters } from '@aiops/widgets';
import { useCallback, useEffect, useMemo, useState, type ReactElement } from 'react';
import { BadQuery, createApi, toLogin, Unauthenticated } from '../api.js';

type State =
  | { kind: 'loading' }
  | { kind: 'error' }
  | { kind: 'denied' }
  | { kind: 'ready'; filters: AuditFilters; events: AuditEventModel[]; next?: string; error?: string };

const RETURN_TO = '/app/audit';

/** Container of `/app/audit`: session first, then the search; no audit request without `viewAudit` (UI-2, SEC-1, AUD-6). */
export function AuditPage(): ReactElement {
  const api = useMemo(() => createApi(), []);
  const [state, setState] = useState<State>({ kind: 'loading' });

  const search = useCallback(
    (filters: AuditFilters): void => {
      api.audit(filters).then(
        (page) => { setState({ kind: 'ready', filters, events: page.events, ...(page.nextCursor === undefined ? {} : { next: page.nextCursor }) }); },
        (error: unknown) => {
          if (error instanceof Unauthenticated) void toLogin(RETURN_TO, false);
          else if (error instanceof BadQuery) setState((s) => ({ kind: 'ready', filters, events: s.kind === 'ready' ? s.events : [], error: 'Check the filter values.' }));
          else setState({ kind: 'error' });
        },
      );
    },
    [api],
  );

  useEffect(() => {
    api.session().then(
      (s) => {
        if (s.viewAudit) search({});
        else setState({ kind: 'denied' });
      },
      (error: unknown) => {
        if (error instanceof Unauthenticated) void toLogin(RETURN_TO, false);
        else setState({ kind: 'error' });
      },
    );
  }, [api, search]);

  if (state.kind === 'loading') return <p>Loading…</p>;
  if (state.kind === 'denied') return <p role="alert">You are not allowed to view the audit log.</p>;
  if (state.kind === 'error') return <p role="alert">The page could not be loaded.</p>;
  const { filters, events, next, error } = state;
  return (
    <AuditSearchView
      events={events}
      filters={filters}
      exportUrl={api.auditExportUrl(filters)}
      onSearch={search}
      {...(error === undefined ? {} : { error })}
      {...(next === undefined
        ? {}
        : {
            onMore: () => {
              api.audit({ ...filters, cursor: next }).then(
                (page) => { setState((s) =>
                    s.kind === 'ready' ? { kind: 'ready', filters: s.filters, events: [...s.events, ...page.events], ...(page.nextCursor === undefined ? {} : { next: page.nextCursor }) } : s,
                  ); },
                (e: unknown) => {
                  if (e instanceof Unauthenticated) void toLogin(RETURN_TO, false);
                  else setState({ kind: 'error' });
                },
              );
            },
          })}
    />
  );
}
