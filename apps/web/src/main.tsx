// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Mandate Authors
import { StrictMode, type ReactElement } from 'react';
import { createRoot } from 'react-dom/client';
import { ApprovalsPage } from './pages/ApprovalsPage.js';
import { AuditPage } from './pages/AuditPage.js';
import { ChangeSetPage } from './pages/ChangeSetPage.js';
import { CredentialsPage } from './pages/CredentialsPage.js';
import { IndexPage } from './pages/IndexPage.js';
import { route, type Route } from './routes.js';
import '@fontsource-variable/public-sans/wght.css';
import '@mandate/widgets/styles.css';
import './styles.css';

// The api serves index.html for every path under /app/; the path picks the page (UI-2, no router library).
function Page({ r }: { r: Route }): ReactElement {
  switch (r.kind) {
    case 'index':
      return <IndexPage />;
    case 'credentials':
      return (
        <>
          <h1>Credentials</h1>
          <CredentialsPage />
        </>
      );
    case 'approvals':
      return <ApprovalsPage />;
    case 'audit':
      return <AuditPage />;
    case 'changeset':
      return <ChangeSetPage id={r.id} />;
    case 'not_found':
      return <p>Page not found.</p>;
  }
}

/** The frame of every page: the product name back to `/app`, then the page itself (UI-2). */
function Shell(): ReactElement {
  const r = route(window.location.pathname);
  return (
    <>
      <header className="masthead">
        <a className="brand" href="/app/">
          Mandate
        </a>
        <nav aria-label="Pages">
          <a href="/app/approvals" {...(r.kind === 'approvals' ? { 'aria-current': 'page' as const } : {})}>
            Approvals
          </a>
          <a href="/app/credentials" {...(r.kind === 'credentials' ? { 'aria-current': 'page' as const } : {})}>
            Credentials
          </a>
        </nav>
      </header>
      <div className={`page page-${r.kind}`}>
        <Page r={r} />
      </div>
    </>
  );
}

const root = document.getElementById('root');
if (root === null) throw new Error('missing #root');
createRoot(root).render(
  <StrictMode>
    <Shell />
  </StrictMode>,
);
