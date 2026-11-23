// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Mandate Authors
import { useEffect, useMemo, useState, type ReactElement } from 'react';
import { createApi, toLogin as login, Unauthenticated, type Session, type StagedFile } from '../api.js';
import { FilesView } from '../views/FilesView.js';

type State = { kind: 'loading' } | { kind: 'error' } | { kind: 'forbidden' } | { kind: 'ready'; session: Session; files: StagedFile[] };

const toLogin = (): Promise<never> => login('/app/files', false);

/** Container of `/app/files`: lists the user's staged files and uploads a chosen one (UI-2, CS-10). */
export function FilesPage(): ReactElement {
  const api = useMemo(() => createApi(), []);
  const [state, setState] = useState<State>({ kind: 'loading' });

  useEffect(() => {
    let live = true;
    Promise.all([api.session(), api.files()]).then(
      ([session, list]) => {
        if (!live) return;
        if (list.ok) setState({ kind: 'ready', session, files: list.files });
        else setState(list.error === 'forbidden' ? { kind: 'forbidden' } : { kind: 'error' });
      },
      (error: unknown) => {
        if (error instanceof Unauthenticated) void toLogin();
        else if (live) setState({ kind: 'error' });
      },
    );
    return () => {
      live = false;
    };
  }, [api]);

  if (state.kind === 'loading') return <p>Loading…</p>;
  if (state.kind === 'error') return <p role="alert">The page could not be loaded.</p>;
  if (state.kind === 'forbidden') return <FilesView files={[]} forbidden onUpload={() => Promise.resolve({ ok: false, error: 'forbidden' })} />;
  const { session } = state;
  return (
    <FilesView
      files={state.files}
      forbidden={false}
      onUpload={async (file) => {
        try {
          const outcome = await api.upload(session.csrfToken, file);
          if (!outcome.ok) return outcome;
          // The new file first; an earlier entry of the same ID cannot occur, the server assigns a new one.
          setState((s) => (s.kind === 'ready' ? { ...s, files: [outcome.file, ...s.files] } : s));
          return { ok: true };
        } catch (error) {
          if (error instanceof Unauthenticated) return toLogin();
          throw error;
        }
      }}
    />
  );
}
