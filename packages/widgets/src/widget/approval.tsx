// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Mandate Authors
// MCP Apps entry of the approval widget (UI-1, APR-8). API per @modelcontextprotocol/ext-apps 2.1.0
// dist/src/react/useApp.d.ts and useHostStyles.d.ts: the handlers are set in onAppCreated, before
// the connection completes, so the first tool result is not missed.
import { StrictMode, useState, type ReactElement } from 'react';
import { createRoot } from 'react-dom/client';
import type { CallToolResult } from '@modelcontextprotocol/client';
import { useApp, useHostStyles } from '@modelcontextprotocol/ext-apps/react';
import { ApprovalWidget } from './ApprovalWidget.js';
import '../styles.css';

function Entry(): ReactElement {
  const [trigger, setTrigger] = useState<CallToolResult>();
  const { app, error } = useApp({
    appInfo: { name: 'mandate-approval-widget', version: '0.0.0' },
    capabilities: {},
    onAppCreated: (created) => {
      // addEventListener: the `ontoolresult` setter is deprecated in ext-apps 2.1.0 (app.d.ts).
      created.addEventListener('toolresult', (result) => {
        setTrigger(result);
      });
      // Nothing to stop: the approval widget does not poll.
      created.onteardown = () => ({});
    },
  });
  useHostStyles(app, app?.getHostContext());
  return <ApprovalWidget app={app} trigger={trigger} {...(error === null ? {} : { error })} />;
}

const root = document.getElementById('root');
if (root === null) throw new Error('the widget document has no #root');
createRoot(root).render(
  <StrictMode>
    <Entry />
  </StrictMode>,
);
