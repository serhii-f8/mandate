import type { ReactElement } from "react";

export interface PagerProps {
  hasPrevious: boolean;
  hasNext: boolean;
  busy: boolean;
  onPrevious: () => void;
  onNext: () => void;
}

export function Pager({
  hasPrevious,
  hasNext,
  busy,
  onPrevious,
  onNext,
}: PagerProps): ReactElement {
  return (
    <div className="pager">
      <button
        type="button"
        disabled={!hasPrevious || busy}
        onClick={onPrevious}
      >
        Previous
      </button>
      <button type="button" disabled={!hasNext || busy} onClick={onNext}>
        Next
      </button>
    </div>
  );
}
