// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Mandate Authors
// Browser side of the reference host: an AppBridge around one sandboxed iframe. Calls leave
// through functions that widget-host.mjs exposes (Node holds the token, so no CORS here).
import { AppBridge, PostMessageTransport } from '@modelcontextprotocol/ext-apps/app-bridge';
import { HOST_THEME } from '../widget-host-lib.mjs';

window.__host = { state: 'starting' };

async function main() {
  const bridge = new AppBridge(
    null,
    { name: 'mandate-reference-host', version: '1.0.0' },
    { openLinks: {}, serverTools: {}, updateModelContext: { text: {} } },
    { hostContext: { theme: 'light', displayMode: 'inline', styles: { variables: HOST_THEME } } },
  );
  bridge.oncalltool = (params) => window.mandateCallTool(params);
  bridge.onopenlink = async ({ url }) => {
    await window.mandateOpenLink(url);
    return {};
  };
  bridge.onupdatemodelcontext = async (params) => {
    await window.mandateModelContext(params);
    return {};
  };
  bridge.addEventListener('initialized', () => {
    window.mandateTrigger()
      .then(async ({ arguments: args, result }) => {
        await bridge.sendToolInput({ arguments: args });
        await bridge.sendToolResult(result);
        window.__host.state = 'initialized';
      })
      .catch((e) => {
        window.__host.state = 'error';
        window.__host.error = String(e);
      });
  });
  // The iframe is created after the bridge listens, so the widget's first message is not lost.
  const iframe = document.createElement('iframe');
  iframe.id = 'widget';
  iframe.setAttribute('sandbox', 'allow-scripts');
  iframe.style.cssText = 'width: 100%; height: 700px; border: 0';
  document.getElementById('slot').appendChild(iframe);
  await bridge.connect(new PostMessageTransport(iframe.contentWindow, iframe.contentWindow));
  iframe.src = '/frame';
}

main().catch((e) => {
  window.__host.state = 'error';
  window.__host.error = e instanceof Error ? `${e.name}: ${e.message}` : String(e);
});
