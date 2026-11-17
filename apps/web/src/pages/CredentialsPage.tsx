import { useEffect, useMemo, useState, type ReactElement } from 'react';
import { createApi, loginUrl, Unauthenticated, type CredentialListEntry, type Session } from '../api.js';
import { CredentialsView } from '../views/CredentialsView.js';

type State = { kind: 'loading' } | { kind: 'error' } | { kind: 'ready'; session: Session; credentials: CredentialListEntry[] };

/** Leaves the page for a login; the promise never settles so no result is shown meanwhile. */
function toLogin(fresh: boolean): Promise<never> {
  window.location.assign(loginUrl(fresh));
  return new Promise<never>(() => undefined);
}

/** Container of `/app/credentials`: loads the session and the refs, turns view callbacks into REST calls. */
export function CredentialsPage(): ReactElement {
  const api = useMemo(() => createApi(), []);
  const [state, setState] = useState<State>({ kind: 'loading' });

  useEffect(() => {
    let live = true;
    Promise.all([api.session(), api.credentials()]).then(
      ([session, credentials]) => {
        if (live) setState({ kind: 'ready', session, credentials });
      },
      (error: unknown) => {
        if (error instanceof Unauthenticated) void toLogin(false);
        else if (live) setState({ kind: 'error' });
      },
    );
    return () => {
      live = false;
    };
  }, [api]);

  if (state.kind === 'loading') return <p>Loading…</p>;
  if (state.kind === 'error') return <p role="alert">The page could not be loaded.</p>;
  const { session, credentials } = state;
  const schemeFields = new Map(credentials.map((c) => [c.scheme, c.fields] as const));
  return (
    <CredentialsView
      credentials={credentials}
      fields={(scheme) => schemeFields.get(scheme) ?? []}
      fresh={session.fresh}
      freshLoginUrl={loginUrl(true)}
      onSave={async (ref, secret) => {
        try {
          const result = await api.save(session.csrfToken, ref, secret);
          return result === 'reauthentication_required' ? await toLogin(true) : result;
        } catch (error) {
          if (error instanceof Unauthenticated) return toLogin(false);
          throw error;
        }
      }}
      onTest={async (connection) => {
        try {
          return await api.test(session.csrfToken, connection);
        } catch (error) {
          if (error instanceof Unauthenticated) return toLogin(false);
          throw error;
        }
      }}
    />
  );
}
