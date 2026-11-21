// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The AI Operations Layer Authors
import type { ReactElement, ReactNode } from 'react';

export function Notice({ kind, children }: { kind: 'info' | 'error'; children: ReactNode }): ReactElement {
  return (
    <div className={`notice notice-${kind}`} role={kind === 'error' ? 'alert' : 'status'}>
      {children}
    </div>
  );
}
