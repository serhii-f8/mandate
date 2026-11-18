import type { ReactElement } from "react";

export function StatusBadge({ status }: { status: string }): ReactElement {
  return <span className={`status status-${status}`}>{status}</span>;
}
