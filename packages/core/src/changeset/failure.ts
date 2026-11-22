// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Mandate Authors

/**
 * A fixed-code preparation failure that marks the change-set `failed` (design §4.1). It carries the
 * upstream HTTP status of a failed read when there was one, never upstream text (SEC-3).
 */
export class PreparationFailure extends Error {
  constructor(
    readonly code: string,
    readonly status?: number,
  ) {
    super(`preparation failed: ${code}`);
  }
}
