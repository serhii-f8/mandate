import type { ReactElement, ReactNode } from "react";

export function ActionBar({ children }: { children: ReactNode }): ReactElement {
  return (
    <div className="actions" role="toolbar">
      {children}
    </div>
  );
}
