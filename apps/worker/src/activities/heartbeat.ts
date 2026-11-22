// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Mandate Authors
/**
 * Keeps a long activity step alive (EXE-4, NFR-2): one heartbeat at once, then one every third
 * of the activity's heartbeat timeout (at least every second) until `step` settles. A slow
 * upstream read or submit therefore never times an attempt out while it still runs, which would
 * let a second attempt read the unchanged items and submit them again. A lost worker still stops
 * heartbeating and is noticed by the heartbeat timeout; a stuck step by start-to-close.
 */
import { Context } from '@temporalio/activity';

const MIN_INTERVAL_MS = 1_000;

export async function whileHeartbeating<T>(step: () => Promise<T>): Promise<T> {
  // Captured once: the timer callback runs outside the activity's async context.
  const context = Context.current();
  context.heartbeat();
  const timeoutMs = context.info.heartbeatTimeoutMs;
  const timer =
    timeoutMs === undefined || timeoutMs <= 0
      ? undefined
      : setInterval(() => {
          context.heartbeat();
        }, Math.max(MIN_INTERVAL_MS, Math.floor(timeoutMs / 3)));
  try {
    return await step();
  } finally {
    if (timer !== undefined) clearInterval(timer);
  }
}
