// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Mandate Authors
import { useCallback, useRef, useState } from 'react';
import type { ActionResult } from '../model.js';

export interface Action {
  busy: boolean;
  message?: string;
  run<T>(prefix: string, call: () => Promise<ActionResult<T>>, onOk: (value: T) => void): void;
}

function errorText(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/** One action in flight per view: `run` is ignored while another call is pending. */
export function useAction(): Action {
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | undefined>(undefined);
  // The ref closes the window between a click and React's re-render (a double click).
  const inFlight = useRef(false);

  const run = useCallback(
    <T>(prefix: string, call: () => Promise<ActionResult<T>>, onOk: (value: T) => void): void => {
      if (inFlight.current) return;
      inFlight.current = true;
      setBusy(true);
      setMessage(undefined);
      const done = (failure?: string): void => {
        inFlight.current = false;
        setBusy(false);
        if (failure !== undefined) setMessage(prefix + failure);
      };
      let pending: Promise<ActionResult<T>>;
      try {
        pending = call();
      } catch (e) {
        done(errorText(e));
        return;
      }
      pending.then(
        (r) => {
          if (r.ok) {
            done();
            onOk(r.value);
          } else done(r.message);
        },
        (e: unknown) => {
          done(errorText(e));
        },
      );
    },
    [],
  );

  return { busy, ...(message === undefined ? {} : { message }), run };
}
