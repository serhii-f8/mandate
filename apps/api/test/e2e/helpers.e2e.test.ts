// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Mandate Authors
import { describe, expect, it } from 'vitest';
import { withFreePort } from './helpers.js';

describe('end-to-end helpers', () => {
  it('withFreePort retries a port taken between probe and listen', async () => {
    const ports: number[] = [];
    const result = await withFreePort((port) => {
      ports.push(port);
      if (ports.length === 1) return Promise.reject(Object.assign(new Error('x'), { code: 'EADDRINUSE' }));
      return Promise.resolve(port);
    });
    expect(ports).toHaveLength(2);
    expect(ports[0]).not.toBe(ports[1]);
    expect(result).toBe(ports[1]);
  });

  it('withFreePort retries an EADDRINUSE carried as the cause', async () => {
    let calls = 0;
    await withFreePort(() => {
      calls += 1;
      if (calls === 1) return Promise.reject(new Error('wrapped', { cause: Object.assign(new Error('x'), { code: 'EADDRINUSE' }) }));
      return Promise.resolve();
    });
    expect(calls).toBe(2);
  });

  it('withFreePort propagates any other error after one call', async () => {
    let calls = 0;
    await expect(
      withFreePort(() => {
        calls += 1;
        return Promise.reject(new Error('boom'));
      }),
    ).rejects.toThrow('boom');
    expect(calls).toBe(1);
  });

  it('withFreePort gives up with the EADDRINUSE error after the last attempt', async () => {
    let calls = 0;
    await expect(
      withFreePort(() => {
        calls += 1;
        return Promise.reject(Object.assign(new Error('taken'), { code: 'EADDRINUSE' }));
      }, 3),
    ).rejects.toThrow('taken');
    expect(calls).toBe(3);
  });
});
