import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { CredentialsPage } from './pages/CredentialsPage.js';
import './styles.css';

// One route: /app/credentials (the api serves index.html for every path under /app/).
const root = document.getElementById('root');
if (root === null) throw new Error('missing #root');
createRoot(root).render(
  <StrictMode>
    <h1>Credentials</h1>
    <CredentialsPage />
  </StrictMode>,
);
