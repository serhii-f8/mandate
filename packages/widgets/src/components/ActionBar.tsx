// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The AI Operations Layer Authors
import type { ReactElement, ReactNode } from 'react';

export function ActionBar({ children }: { children: ReactNode }): ReactElement {
  return (
    <div className="actions" role="toolbar">
      {children}
    </div>
  );
}
