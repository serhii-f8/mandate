import { StrictMode, type ReactElement } from 'react';
import { createRoot } from 'react-dom/client';
import { ApprovalsPage } from './pages/ApprovalsPage.js';
import { ChangeSetPage } from './pages/ChangeSetPage.js';
import { CredentialsPage } from './pages/CredentialsPage.js';
import { route } from './routes.js';
import '@aiops/widgets/styles.css';
import './styles.css';

// The api serves index.html for every path under /app/; the path picks the page (UI-2, no router library).
function Page(): ReactElement {
  const r = route(window.location.pathname);
  switch (r.kind) {
    case 'index':
      return (
        <main>
          <h1>AI Operations</h1>
          <ul>
            <li>
              <a href="/app/approvals">Approvals</a>
            </li>
            <li>
              <a href="/app/credentials">Credentials</a>
            </li>
          </ul>
        </main>
      );
    case 'credentials':
      return (
        <>
          <h1>Credentials</h1>
          <CredentialsPage />
        </>
      );
    case 'approvals':
      return <ApprovalsPage />;
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
