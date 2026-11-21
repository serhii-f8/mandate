// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The AI Operations Layer Authors
import type { ReactElement } from 'react';

export function StatusBadge({ status }: { status: string }): ReactElement {
  return <span className={`status status-${status}`}>{status}</span>;
}
