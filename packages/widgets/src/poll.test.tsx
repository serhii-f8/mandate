// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Mandate Authors
import { act, renderHook } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { pollDelay, usePolling } from './poll.js';

afterEach(() => {
  vi.useRealTimers();
});

describe('poll', () => {
  it('UI-2 pollDelay polls every 3 s for a minute, then every 10 s, and stops after 30 minutes', () => {
    expect(pollDelay(0)).toBe(3000);
    expect(pollDelay(59_999)).toBe(3000);
    expect(pollDelay(60_000)).toBe(10_000);
    expect(pollDelay(1_799_999)).toBe(10_000);
    expect(pollDelay(1_800_000)).toBeUndefined();
  });

  it('UI-2 a full poll schedule makes at most 200 calls', () => {
    let elapsed = 0;
    let calls = 0;
    for (let d = pollDelay(elapsed); d !== undefined; d = pollDelay(elapsed)) {
      elapsed += d;
      calls += 1;
    }
    expect(calls).toBeLessThanOrEqual(200);
    expect(calls).toBe(194);
  });

  it('UI-2 usePolling refreshes on the schedule, stops when inactive and on unmount', async () => {
    vi.useFakeTimers();
    const refresh = vi.fn<() => Promise<void>>().mockResolvedValue(undefined);
    const now = (): number => Date.now();
    const hook = renderHook(({ active }: { active: boolean }) => usePolling(active, refresh, now), {
      initialProps: { active: true },
    });
    expect(refresh).not.toHaveBeenCalled();
    await act(() => vi.advanceTimersByTimeAsync(3000));
    expect(refresh).toHaveBeenCalledTimes(1);

    hook.rerender({ active: false });
    expect(vi.getTimerCount()).toBe(0);
    await act(() => vi.advanceTimersByTimeAsync(60_000));
    expect(refresh).toHaveBeenCalledTimes(1);

    hook.rerender({ active: true });
    expect(vi.getTimerCount()).toBe(1);
    hook.unmount();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('UI-2 usePolling waits for each refresh to settle and keeps polling after a failed one', async () => {
    vi.useFakeTimers();
    let settle: () => void = () => undefined;
    const refresh = vi
      .fn<() => Promise<void>>()
      .mockImplementationOnce(
        () =>
          new Promise<void>((resolve) => {
            settle = resolve;
          }),
      )
      .mockRejectedValueOnce(new Error('offline'))
      .mockResolvedValue(undefined);
    const hook = renderHook(() => usePolling(true, refresh, () => Date.now()));
    await act(() => vi.advanceTimersByTimeAsync(3000));
    expect(refresh).toHaveBeenCalledTimes(1);
    // No timer runs while the refresh is pending: setTimeout chained after it settles.
    expect(vi.getTimerCount()).toBe(0);
    await act(() => vi.advanceTimersByTimeAsync(9000));
    expect(refresh).toHaveBeenCalledTimes(1);
    await act(async () => {
      settle();
      await Promise.resolve();
    });
    await act(() => vi.advanceTimersByTimeAsync(3000));
    expect(refresh).toHaveBeenCalledTimes(2);
    await act(() => vi.advanceTimersByTimeAsync(3000));
    expect(refresh).toHaveBeenCalledTimes(3);
    hook.unmount();
  });

  it('UI-2 usePolling reports stopped after 30 minutes and restart resumes', async () => {
    vi.useFakeTimers();
    const refresh = vi.fn<() => Promise<void>>().mockResolvedValue(undefined);
    const hook = renderHook(() => usePolling(true, refresh, () => Date.now()));
    expect(hook.result.current.stopped).toBe(false);
    await act(() => vi.advanceTimersByTimeAsync(1_800_000 + 10_000));
    expect(hook.result.current.stopped).toBe(true);
    expect(refresh).toHaveBeenCalledTimes(194);
    expect(vi.getTimerCount()).toBe(0);

    act(() => {
      hook.result.current.restart();
    });
    expect(hook.result.current.stopped).toBe(false);
    await act(() => vi.advanceTimersByTimeAsync(3000));
    expect(refresh).toHaveBeenCalledTimes(195);
    hook.unmount();
    expect(vi.getTimerCount()).toBe(0);
  });
});
