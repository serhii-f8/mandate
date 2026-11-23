// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Mandate Authors
import { useCallback, useEffect, useRef, useState } from 'react';
import type { ActionResult, ItemsPageModel, ItemsQuery, ListFilter } from './model.js';

export interface ItemPages {
  page: ItemsPageModel;
  filter: ListFilter | undefined;
  hasPrevious: boolean;
  busy: boolean;
  error?: string;
  next(): void;
  previous(): void;
  setFilter(f: ListFilter | undefined): void;
}

type Load = (q: ItemsQuery) => Promise<ActionResult<ItemsPageModel>>;

interface State {
  page: ItemsPageModel;
  filter: ListFilter | undefined;
  stack: (string | undefined)[];
  busy: boolean;
  error: string | undefined;
}

/** Cursor-stack paging over the items of one change-set; a new resetKey starts over. */
export function useItemPages(
  initial: ItemsPageModel,
  initialFilter: ListFilter | undefined,
  load: Load,
  resetKey: string,
): ItemPages {
  const fresh = useCallback(
    (): State => ({
      page: initial,
      filter: initialFilter,
      stack: [undefined],
      busy: false,
      error: undefined,
    }),
    [initial, initialFilter],
  );
  const [state, setState] = useState<State>(fresh);
  const keyRef = useRef(resetKey);
  const seq = useRef(0);
  const stateRef = useRef(state);
  stateRef.current = state;

  useEffect(() => {
    if (keyRef.current === resetKey) return;
    keyRef.current = resetKey;
    seq.current += 1;
    setState(fresh());
  }, [resetKey]);

  const go = useCallback(
    (stack: (string | undefined)[], filter: ListFilter | undefined) => {
      const cursor = stack[stack.length - 1];
      const ticket = ++seq.current;
      setState((s) => ({ ...s, busy: true, error: undefined }));
      const q: ItemsQuery = {};
      if (cursor !== undefined) q.after = cursor;
      if (filter === 'not_confirmed') q.verification = filter;
      else if (filter !== undefined) q.status = filter;
      void load(q).then(
        (r) => {
          if (ticket !== seq.current) return;
          if (r.ok)
            setState({
              page: r.value,
              filter,
              stack,
              busy: false,
              error: undefined,
            });
          else setState((s) => ({ ...s, busy: false, error: r.message }));
        },
        (e: unknown) => {
          if (ticket !== seq.current) return;
          setState((s) => ({
            ...s,
            busy: false,
            error: e instanceof Error ? e.message : 'load failed',
          }));
        },
      );
    },
    [load],
  );

  return {
    page: state.page,
    filter: state.filter,
    hasPrevious: state.stack.length > 1,
    busy: state.busy,
    ...(state.error === undefined ? {} : { error: state.error }),
    next() {
      const s = stateRef.current;
      if (s.busy || s.page.next === undefined) return;
      go([...s.stack, s.page.next], s.filter);
    },
    previous() {
      const s = stateRef.current;
      if (s.busy || s.stack.length <= 1) return;
      go(s.stack.slice(0, -1), s.filter);
    },
    setFilter(f) {
      go([undefined], f);
    },
  };
}
