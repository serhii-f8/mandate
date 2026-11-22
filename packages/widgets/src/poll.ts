// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Mandate Authors
import { useCallback, useEffect, useRef, useState } from 'react';

const FAST_MS = 3000;
const SLOW_MS = 10_000;
const FAST_UNTIL_MS = 60_000;
const STOP_AFTER_MS = 1_800_000;

/** The wait before the next poll (UI-2): 3 s for a minute, then 10 s, and none after 30 minutes. */
export function pollDelay(elapsedMs: number): number | undefined {
  if (elapsedMs < FAST_UNTIL_MS) return FAST_MS;
  if (elapsedMs < STOP_AFTER_MS) return SLOW_MS;
  return undefined;
}

export interface Polling {
  stopped: boolean;
  restart: () => void;
}

/** Calls `refresh` on the schedule while `active`; stops on teardown (unmount) and after 30 min. */
export function usePolling(active: boolean, refresh: () => Promise<void>, now: () => number = Date.now): Polling {
  const [stopped, setStopped] = useState(false);
  // A new round restarts the effect, and with it the elapsed time.
  const [round, setRound] = useState(0);
  // Refs keep the schedule running when the entry passes a new closure on each render.
  const refreshRef = useRef(refresh);
  refreshRef.current = refresh;
  const nowRef = useRef(now);
  nowRef.current = now;

  useEffect(() => {
    if (!active) return undefined;
    const startedAt = nowRef.current();
    let timer: ReturnType<typeof setTimeout> | undefined;
    let live = true;
    const schedule = (): void => {
      const delay = pollDelay(nowRef.current() - startedAt);
      if (delay === undefined) {
        setStopped(true);
        return;
      }
      // Chained after each refresh settles, never an interval: a slow answer never stacks calls.
      timer = setTimeout(() => {
        timer = undefined;
        const next = (): void => {
          if (live) schedule();
        };
        let pending: Promise<void>;
        try {
          pending = refreshRef.current();
        } catch {
          next();
          return;
        }
        pending.then(next, next);
      }, delay);
    };
    schedule();
    return () => {
      live = false;
      if (timer !== undefined) clearTimeout(timer);
    };
  }, [active, round]);

  const restart = useCallback((): void => {
    setStopped(false);
    setRound((r) => r + 1);
  }, []);

  return { stopped, restart };
}
