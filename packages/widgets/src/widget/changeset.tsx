// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The AI Operations Layer Authors
// MCP Apps entry of the change-set widget (UI-1). API per @modelcontextprotocol/ext-apps 2.1.0
// dist/src/react/useApp.d.ts and useHostStyles.d.ts: the handlers are set in onAppCreated, before
// the connection completes, so the first tool result is not missed.
import { StrictMode, useState, type ReactElement } from 'react';
import { createRoot } from 'react-dom/client';
import type { CallToolResult } from '@modelcontextprotocol/client';
import { useApp, useHostStyles } from '@modelcontextprotocol/ext-apps/react';
import { ChangeSetWidget } from './ChangeSetWidget.js';
import '../styles.css';

function Entry(): ReactElement {
  const [trigger, setTrigger] = useState<CallToolResult>();
  const [tornDown, setTornDown] = useState(false);
  const { app, error } = useApp({
    appInfo: { name: 'aiops-changeset-widget', version: '0.0.0' },
    capabilities: {},
    onAppCreated: (created) => {
      // addEventListener: the `ontoolresult` setter is deprecated in ext-apps 2.1.0 (app.d.ts).
      created.addEventListener('toolresult', (result) => {
        setTrigger(result);
      });
      created.onteardown = () => {
        setTornDown(true);
        return {};
      };
    },
  });
  useHostStyles(app, app?.getHostContext());
  return <ChangeSetWidget app={app} trigger={trigger} tornDown={tornDown} {...(error === null ? {} : { error })} />;
}

const root = document.getElementById('root');
if (root === null) throw new Error('the widget document has no #root');
createRoot(root).render(
  <StrictMode>
    <Entry />
  </StrictMode>,
);
