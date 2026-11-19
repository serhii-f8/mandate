import { StrictMode, type ReactElement } from 'react';
import { createRoot } from 'react-dom/client';
import { ApprovalsPage } from './pages/ApprovalsPage.js';
import { AuditPage } from './pages/AuditPage.js';
import { ChangeSetPage } from './pages/ChangeSetPage.js';
import { CredentialsPage } from './pages/CredentialsPage.js';
import { IndexPage } from './pages/IndexPage.js';
import { route } from './routes.js';
import '@aiops/widgets/styles.css';
import './styles.css';

// The api serves index.html for every path under /app/; the path picks the page (UI-2, no router library).
function Page(): ReactElement {
  const r = route(window.location.pathname);
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

const root = document.getElementById('root');
if (root === null) throw new Error('missing #root');
createRoot(root).render(
  <StrictMode>
    <Page />
  </StrictMode>,
);
