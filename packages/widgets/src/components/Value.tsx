// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The AI Operations Layer Authors
import type { ReactElement } from 'react';
import { displayValue } from '../format.js';

export function Value({ value }: { value: unknown }): ReactElement {
  return <pre className="value">{displayValue(value)}</pre>;
}
