// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The AI Operations Layer Authors
import { act, cleanup, render } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ActionResult, ItemFilter, ItemsPageModel } from './model.js';
import { type ItemPages, useItemPages } from './paging.js';

afterEach(cleanup);

interface Q {
  after?: string;
  status?: ItemFilter;
}
const run = (fn: () => void): Promise<undefined> =>
  act(() => {
    fn();
    return Promise.resolve(undefined);
  });
const page = (next?: string): ItemsPageModel => (next === undefined ? { items: [] } : { items: [], next });

function setup(load: (q: Q) => Promise<ActionResult<ItemsPageModel>>) {
  const ref: { current: ItemPages | undefined } = { current: undefined };
  function Probe() {
    ref.current = useItemPages(page('c1'), undefined, load, 'cs-1');
    return null;
  }
  render(<Probe />);
  const get = (): ItemPages => {
    if (!ref.current) throw new Error('not rendered');
    return ref.current;
  };
  return get;
}

describe('item paging', () => {
  it('NFR-8 next sends the page cursor and previous returns to the earlier cursor', async () => {
    const load = vi
      .fn<(q: Q) => Promise<ActionResult<ItemsPageModel>>>()
      .mockResolvedValueOnce({ ok: true, value: page('c2') })
      .mockResolvedValueOnce({ ok: true, value: page() })
      .mockResolvedValueOnce({ ok: true, value: page('c2') });
    const get = setup(load);
    await run(() => {
      get().next();
    });
    await run(() => {
      get().next();
    });
    expect(get().hasPrevious).toBe(true);
    await run(() => {
      get().previous();
    });
    expect(load.mock.calls.map((c) => c[0])).toEqual([{ after: 'c1' }, { after: 'c2' }, { after: 'c1' }]);
  });

  it('NFR-8 changing the filter restarts at the first page', async () => {
    const load = vi
      .fn<(q: Q) => Promise<ActionResult<ItemsPageModel>>>()
      .mockResolvedValue({ ok: true, value: page() });
    const get = setup(load);
    await run(() => {
      get().next();
    });
    expect(get().hasPrevious).toBe(true);
    await run(() => {
      get().setFilter('excluded');
    });
    expect(load).toHaveBeenLastCalledWith({ status: 'excluded' });
    expect(get().hasPrevious).toBe(false);
    expect(get().filter).toBe('excluded');
  });

  it('NFR-8 a failed load keeps the page and reports the message', async () => {
    const load = vi
      .fn<(q: Q) => Promise<ActionResult<ItemsPageModel>>>()
      .mockResolvedValue({ ok: false, message: 'boom' });
    const get = setup(load);
    await run(() => {
      get().next();
    });
    expect(get().error).toBe('boom');
    expect(get().page.next).toBe('c1');
    expect(get().hasPrevious).toBe(false);
    expect(get().busy).toBe(false);
  });

  it('NFR-8 a new resetKey returns to the initial page', async () => {
    const load = vi
      .fn<(q: Q) => Promise<ActionResult<ItemsPageModel>>>()
      .mockResolvedValue({ ok: true, value: page() });
    const ref: { current: ItemPages | undefined } = { current: undefined };
    const initial = page('c1');
    function Probe({ k }: { k: string }) {
      ref.current = useItemPages(initial, undefined, load, k);
      return null;
    }
    const r = render(<Probe k="a" />);
    await run(() => {
      ref.current?.next();
    });
    expect(ref.current?.hasPrevious).toBe(true);
    r.rerender(<Probe k="b" />);
    expect(ref.current?.hasPrevious).toBe(false);
    expect(ref.current?.page).toBe(initial);
  });
});
