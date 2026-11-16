// Standalone page entry (the fallback URL target): the same ChangesetView wired
// to the platform's REST API instead of the MCP Apps bridge.
import { StrictMode, useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import { ChangesetView, type ChangesetSummary } from "./ChangesetView";
import "./changeset.css";

function changesetIdFromPath(): string {
  const parts = location.pathname.split("/").filter(Boolean);
  return parts[parts.length - 1] ?? "";
}

function Page() {
  const [data, setData] = useState<ChangesetSummary | null>(null);
  const id = changesetIdFromPath();

  useEffect(() => {
    fetch(`/api/changesets/${encodeURIComponent(id)}`)
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status}`))))
      .then(setData)
      .catch((e) => console.error("[page]", e));
  }, [id]);

  return (
    <ChangesetView
      data={data}
      mode="page"
      onSubmit={async (changesetId) => {
        const r = await fetch(`/api/changesets/${encodeURIComponent(changesetId)}/submit`, {
          method: "POST",
        });
        const body = await r.json();
        if (!r.ok) throw new Error(body.error ?? `HTTP ${r.status}`);
        return body.result as string;
      }}
    />
  );
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <Page />
  </StrictMode>,
);
