// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The AI Operations Layer Authors
import { useEffect, useMemo, useState, type ReactElement } from 'react';
import { createApi, loginUrl, toLogin as login, Unauthenticated, type CredentialListEntry, type Session } from '../api.js';
import { CredentialsView } from '../views/CredentialsView.js';

type State = { kind: 'loading' } | { kind: 'error' } | { kind: 'ready'; session: Session; credentials: CredentialListEntry[] };

const RETURN_TO = '/app/credentials';
const toLogin = (fresh: boolean): Promise<never> => login(RETURN_TO, fresh);

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
      freshLoginUrl={loginUrl(RETURN_TO, true)}
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
