// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Mandate Authors
/** The start of the UTC minute containing `now` (fixed rate-limit windows, POL-4 and SEC-10). */
export function minuteWindow(now: Date): Date {
  return new Date(Math.floor(now.getTime() / 60_000) * 60_000);
}
