// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Mandate Authors
import { describe, expect, it } from 'vitest';
import * as db from './index.js';

describe('SEC-2 envelope primitives stay internal', () => {
  it.each(['seal', 'openSealed', 'rewrap'])('@mandate/db does not export %s', (name) => {
    expect(Object.keys(db)).not.toContain(name);
  });
});
