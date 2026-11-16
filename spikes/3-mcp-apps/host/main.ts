// Minimal host page. Replaces only the React shell of the ext-apps basic-host
// (examples/basic-host/src/index.tsx, tag v2.0.4) with a scripted flow; all
// MCP/AppBridge/sandbox logic is the vendored basic-host code in ./vendor.
// The flow follows AppIFramePanel in that index.tsx:
//   connectToServer -> callTool -> loadSandboxProxy -> newAppBridge -> initializeApp
import {
  callTool,
  connectToServer,
  hasAppHtml,
  initializeApp,
  loadSandboxProxy,
  log,
  newAppBridge,
} from "./vendor/implementation";
import { getTheme, setTheme, type Theme } from "./vendor/theme";

declare global {
  interface Window {
    __host: {
      state: string;
      error?: string;
      theme: () => Theme;
      setTheme: (t: Theme) => void;
      toolResultText?: string;
    };
  }
}

window.__host = { state: "starting", theme: getTheme, setTheme };

async function main() {
  const params = new URLSearchParams(location.search);
  const serverUrl = new URL(params.get("server") ?? "http://localhost:4121/mcp");
  const toolName = params.get("tool") ?? "preview_changeset";

  window.__host.state = "connecting";
  const serverInfo = await connectToServer(serverUrl);

  window.__host.state = "calling";
  const info = callTool(serverInfo, toolName, {});
  info.resultPromise.then((r) => {
    const t = r.content?.find((c) => c.type === "text");
    window.__host.toolResultText = t && "text" in t ? t.text : undefined;
  });
  if (!hasAppHtml(info)) {
    window.__host.state = "no-ui";
    return;
  }

  const iframe = document.createElement("iframe");
  iframe.id = "app-frame";
  iframe.style.width = "100%";
  iframe.style.height = "420px";
  iframe.style.border = "1px solid #888";
  document.getElementById("frame-slot")!.appendChild(iframe);

  const { csp, permissions } = await info.appResourcePromise;
  const firstTime = await loadSandboxProxy(iframe, csp, permissions);
  if (!firstTime) throw new Error("sandbox proxy already loaded");
  window.__host.state = "sandbox-ready";

  const bridge = newAppBridge(serverInfo, iframe, {}, {
    containerDimensions: { maxHeight: 6000 },
    displayMode: "inline",
  });
  await initializeApp(iframe, bridge, info);
  window.__host.state = "app-initialized";
}

main().catch((e) => {
  log.error(e);
  window.__host.state = "error";
  window.__host.error = e instanceof Error ? `${e.name}: ${e.message}` : String(e);
});
