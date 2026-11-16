// The single view component (UI-1). It knows nothing about MCP or HTTP: it gets
// data and a submit callback as props. widget.tsx wires it to the MCP Apps
// bridge, page.tsx wires it to the platform's REST API.
import { useState } from "react";

export interface ChangesetSummary {
  changesetId: string;
  title: string;
  summary: string;
  items: Array<{ sku: string; field: string; before: string; after: string }>;
  fallbackUrl: string;
}

export interface ChangesetViewProps {
  data: ChangesetSummary | null;
  mode: "widget" | "page";
  onSubmit: (changesetId: string) => Promise<string>;
}

export function ChangesetView({ data, mode, onSubmit }: ChangesetViewProps) {
  const [status, setStatus] = useState<"idle" | "busy" | "done" | "error">("idle");
  const [result, setResult] = useState<string>("");

  if (!data) {
    return (
      <main className="cs" data-testid="changeset-loading">
        Waiting for change-set…
      </main>
    );
  }

  const submit = async () => {
    setStatus("busy");
    try {
      const text = await onSubmit(data.changesetId);
      setResult(text);
      setStatus("done");
    } catch (e) {
      setResult(e instanceof Error ? e.message : String(e));
      setStatus("error");
    }
  };

  return (
    <main className="cs" data-testid="changeset-view" data-mode={mode}>
      <h1 className="cs-title">{data.title}</h1>
      <p className="cs-summary" data-testid="changeset-summary">
        {data.summary}
      </p>
      <table className="cs-table">
        <thead>
          <tr>
            <th>SKU</th>
            <th>Field</th>
            <th>Before</th>
            <th>After</th>
          </tr>
        </thead>
        <tbody>
          {data.items.map((it) => (
            <tr key={it.sku + it.field}>
              <td>{it.sku}</td>
              <td>{it.field}</td>
              <td>{it.before}</td>
              <td>{it.after}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <div className="cs-actions">
        <button
          type="button"
          className="cs-submit"
          data-testid="submit-button"
          disabled={status === "busy" || status === "done"}
          onClick={submit}
        >
          Submit
        </button>
        {mode === "widget" && (
          <a className="cs-link" href={data.fallbackUrl} target="_blank" rel="noreferrer">
            Open as page
          </a>
        )}
      </div>
      {status !== "idle" && (
        <p className={"cs-result cs-" + status} data-testid="submit-result">
          {status === "busy" ? "Submitting…" : result}
        </p>
      )}
    </main>
  );
}
