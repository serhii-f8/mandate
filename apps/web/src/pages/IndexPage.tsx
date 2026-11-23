// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Mandate Authors
import { useEffect, useMemo, useState, type ReactElement } from 'react';
import { createApi } from '../api.js';

/** Container of `/app`: links the pages; Audit only when the session says `viewAudit` (UI-2). The api enforces it regardless (SEC-1). */
export function IndexPage(): ReactElement {
  const api = useMemo(() => createApi(), []);
  const [viewAudit, setViewAudit] = useState(false);
  // The files page is offered unless the api answered 403: no role of the user has an operation that takes a file (CS-10).
  const [showFiles, setShowFiles] = useState(false);
  useEffect(() => {
    let live = true;
    api.session().then(
      (s) => {
        if (live) setViewAudit(s.viewAudit);
      },
      () => undefined,
    );
    return () => {
      live = false;
    };
  }, [api]);
  useEffect(() => {
    let live = true;
    api.files().then(
      (r) => {
        if (live) setShowFiles(r.ok || r.error !== 'forbidden');
      },
      () => undefined,
    );
    return () => {
      live = false;
    };
  }, [api]);
  return (
    <main>
      <h1>Mandate</h1>
      <ul className="destinations">
        <li>
          <a href="/app/approvals">Approvals</a>
          <p>Change-sets waiting for your decision.</p>
        </li>
        <li>
          <a href="/app/credentials">Credentials</a>
          <p>The secrets the server uses to reach your systems.</p>
        </li>
        {showFiles ? (
          <li>
            <a href="/app/files">Files</a>
            <p>Upload a file for a call that takes one.</p>
          </li>
        ) : null}
        {viewAudit ? (
          <li>
            <a href="/app/audit">Audit</a>
          <p>Every request, decision and write, searchable.</p>
          </li>
        ) : null}
      </ul>
    </main>
  );
}
