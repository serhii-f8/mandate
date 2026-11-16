// MCP Apps entry: the shared ChangesetView wired to the host bridge.
// - data comes from the preview_changeset tool result (structuredContent),
//   pushed by the host as ui/notifications/tool-result;
// - Submit calls the platform tool submit_changeset through the host
//   (app.callServerTool -> tools/call over postMessage -> host -> MCP server);
// - host theme and style variables are applied with useHostStyles.
// API per @modelcontextprotocol/ext-apps@2.0.4 dist/src/react/*.d.ts and
// examples/basic-server-react/src/mcp-app.tsx (tag v2.0.4).
import { StrictMode, useState } from "react";
import { createRoot } from "react-dom/client";
import { useApp, useHostStyles } from "@modelcontextprotocol/ext-apps/react";
import { ChangesetView, type ChangesetSummary } from "./ChangesetView";
import "./changeset.css";

function textOf(result: { content?: Array<{ type: string; text?: string }> }): string {
  const block = result.content?.find((c) => c.type === "text");
  return block?.text ?? "";
}

function Widget() {
  const [data, setData] = useState<ChangesetSummary | null>(null);
  const { app, error } = useApp({
    appInfo: { name: "fde-spike-3-changeset-widget", version: "0.0.0" },
    capabilities: {},
    onAppCreated: (a) => {
      a.ontoolresult = (result) => {
        const sc = result.structuredContent as ChangesetSummary | undefined;
        if (sc && typeof sc.changesetId === "string") setData(sc);
      };
      a.onerror = (e) => console.error("[widget]", e);
    },
  });
  useHostStyles(app, app?.getHostContext());

  if (error) return <main className="cs">Bridge error: {error.message}</main>;

  return (
    <ChangesetView
      data={data}
      mode="widget"
      onSubmit={async (changesetId) => {
        if (!app) throw new Error("not connected");
        const result = await app.callServerTool({
          name: "submit_changeset",
          arguments: { changesetId },
        });
        if (result.isError) throw new Error(textOf(result) || "submit failed");
        return textOf(result);
      }}
    />
  );
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <Widget />
  </StrictMode>,
);
