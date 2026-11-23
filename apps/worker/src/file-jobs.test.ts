// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Mandate Authors
import type { Logger } from 'pino';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createFileJobs, FILE_PURGE_BATCH, FILE_PURGE_INTERVAL_MS, FILE_PURGE_MAX_ROUNDS } from './file-jobs.js';

interface LogLine {
  readonly level: 'info' | 'error';
  readonly obj: unknown;
}

let lines: LogLine[];

function recordingLogger(): Pick<Logger, 'info' | 'error'> {
  const at = (level: LogLine['level']) => (obj: unknown) => {
    lines.push({ level, obj });
  };
  return { info: at('info'), error: at('error') };
}

beforeEach(() => {
  lines = [];
  // Fake timers: "no further pass" is not a wall-clock window.
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
});

afterEach(() => {
  vi.useRealTimers();
});

describe('CS-10 file purge job', () => {
  it('CS-10 the constants are an hour and a batch of 200', () => {
    expect(FILE_PURGE_INTERVAL_MS).toBe(3_600_000);
    expect(FILE_PURGE_BATCH).toBe(200);
  });

  it('CS-10 a pass runs at start and then every interval', async () => {
    let calls = 0;
    const jobs = createFileJobs({ purge: () => Promise.resolve((calls += 1, 0)), logger: recordingLogger(), intervalMs: 100 }).start();
    await vi.advanceTimersByTimeAsync(0);
    expect(calls).toBe(1);
    await vi.advanceTimersByTimeAsync(100);
    expect(calls).toBe(2);
    await jobs.stop();
  });

  it('CS-10 a full batch is followed at once by another pass; a short one is not', async () => {
    const results = [FILE_PURGE_BATCH, FILE_PURGE_BATCH, 3];
    let calls = 0;
    const purge = (): Promise<number> => Promise.resolve(results[calls++] ?? 0);
    const jobs = createFileJobs({ purge, logger: recordingLogger(), intervalMs: 10_000 }).start();
    await vi.advanceTimersByTimeAsync(0);
    expect(calls).toBe(3);
    await vi.advanceTimersByTimeAsync(5_000);
    expect(calls).toBe(3);
    await jobs.stop();
  });

  it('CS-10 a backlog is bounded to FILE_PURGE_MAX_ROUNDS passes in one tick', async () => {
    let calls = 0;
    const jobs = createFileJobs({ purge: () => Promise.resolve((calls += 1, FILE_PURGE_BATCH)), logger: recordingLogger(), intervalMs: 10_000 }).start();
    await vi.advanceTimersByTimeAsync(0);
    expect(calls).toBe(FILE_PURGE_MAX_ROUNDS);
    expect(FILE_PURGE_MAX_ROUNDS).toBe(100);
    await jobs.stop();
  });

  it('CS-10 SEC-3 a throwing pass logs the error name and SQLSTATE only, and the next pass still runs', async () => {
    let calls = 0;
    const purge = (): Promise<number> => {
      calls += 1;
      if (calls === 1) return Promise.reject(Object.assign(new Error('file report.pdf of alice'), { code: '40001' }));
      if (calls === 2) return Promise.reject(new Error('file report.pdf of alice'));
      return Promise.resolve(0);
    };
    const jobs = createFileJobs({ purge, logger: recordingLogger(), intervalMs: 100 }).start();
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(100);
    await vi.advanceTimersByTimeAsync(100);
    expect(calls).toBe(3);
    const errors = lines.filter((l) => l.level === 'error');
    expect(errors.map((e) => e.obj)).toEqual([{ error: 'Error', code: '40001' }, { error: 'Error' }]);
    expect(JSON.stringify(lines)).not.toContain('report.pdf');
    await jobs.stop();
  });

  it('CS-10 stop() resolves and no pass starts after it', async () => {
    let calls = 0;
    const jobs = createFileJobs({ purge: () => Promise.resolve((calls += 1, 0)), logger: recordingLogger(), intervalMs: 100 }).start();
    await vi.advanceTimersByTimeAsync(0);
    await jobs.stop();
    await vi.advanceTimersByTimeAsync(1_000);
    expect(calls).toBe(1);
  });
});
