import type { RetentionReport, SealResult } from '@aiops/db';
import type { Logger } from 'pino';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AUDIT_SEAL_MAX_ROUNDS, createAuditJobs, type AuditJobsDeps } from './audit-jobs.js';

interface LogLine {
  readonly level: 'info' | 'warn' | 'error';
  readonly obj: unknown;
  readonly msg: unknown;
}

let lines: LogLine[];

function recordingLogger(): Pick<Logger, 'info' | 'warn' | 'error'> {
  const at = (level: LogLine['level']) => (obj: unknown, msg?: unknown) => {
    lines.push({ level, obj, msg });
  };
  return { info: at('info'), warn: at('warn'), error: at('error') };
}

const NOTHING_DUE: RetentionReport = { kind: 'nothing_due', rateBucketsDeleted: 0 };
const SEALED: SealResult = { sealed: 0, locked: true };

function deps(overrides: Partial<AuditJobsDeps> = {}): AuditJobsDeps {
  return {
    seal: () => Promise.resolve(SEALED),
    retain: () => Promise.resolve(NOTHING_DUE),
    logger: recordingLogger(),
    sealIntervalMs: 100,
    retentionIntervalMs: 10_000,
    ...overrides,
  };
}

beforeEach(() => {
  lines = [];
  // Fake timers: the intervals advance on demand, so "no further pass" is not a wall-clock window.
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
});

afterEach(() => {
  vi.useRealTimers();
});

describe('AUD-3 audit sealer job', () => {
  it('AUD-3 seals on every interval and keeps going after a failure, logging the error name only', async () => {
    let calls = 0;
    const seal = (): Promise<SealResult> => {
      calls += 1;
      return calls === 2 ? Promise.reject(new Error('row actor alice')) : Promise.resolve(SEALED);
    };
    const jobs = createAuditJobs(deps({ seal })).start();
    await vi.advanceTimersByTimeAsync(0);
    expect(calls).toBe(1);
    await vi.advanceTimersByTimeAsync(100);
    expect(calls).toBe(2);
    const errors = lines.filter((l) => l.level === 'error');
    expect(errors).toHaveLength(1);
    expect(errors[0]?.obj).toEqual({ error: 'Error' });
    expect(JSON.stringify(lines)).not.toContain('alice');
    await vi.advanceTimersByTimeAsync(100);
    expect(calls).toBe(3);
    await vi.advanceTimersByTimeAsync(200);
    expect(calls).toBe(5);
    await jobs.stop();
  });

  it('AUD-3 a full batch is followed by another seal in the same tick until a partial one', async () => {
    const results = [3, 3, 3, 1];
    let calls = 0;
    const seal = (): Promise<SealResult> => {
      const sealed = results[calls] ?? 0;
      calls += 1;
      return Promise.resolve({ sealed, locked: false });
    };
    const jobs = createAuditJobs(deps({ seal, sealBatchSize: 3 })).start();
    await vi.advanceTimersByTimeAsync(0);
    expect(calls).toBe(4);
    await vi.advanceTimersByTimeAsync(100);
    expect(calls).toBe(5);
    await jobs.stop();
  });

  it('AUD-3 a backlog drain is bounded per tick and ends on an error', async () => {
    let calls = 0;
    const jobs = createAuditJobs(
      deps({
        seal: () => {
          calls += 1;
          return Promise.resolve({ sealed: 3, locked: false });
        },
        sealBatchSize: 3,
      }),
    ).start();
    await vi.advanceTimersByTimeAsync(0);
    expect(calls).toBe(AUDIT_SEAL_MAX_ROUNDS);
    await jobs.stop();
    let failing = 0;
    const second = createAuditJobs(
      deps({
        seal: () => {
          failing += 1;
          return failing === 2 ? Promise.reject(new Error('x')) : Promise.resolve({ sealed: 3, locked: false });
        },
        sealBatchSize: 3,
      }),
    ).start();
    await vi.advanceTimersByTimeAsync(0);
    expect(failing).toBe(2);
    await second.stop();
  });

  it('AUD-3 stop waits for the running pass and starts no other', async () => {
    let open: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      open = resolve;
    });
    let seals = 0;
    let retains = 0;
    const seal = async (): Promise<SealResult> => {
      seals += 1;
      if (seals === 2) await gate;
      return SEALED;
    };
    const retain = (): Promise<RetentionReport> => {
      retains += 1;
      return Promise.resolve(NOTHING_DUE);
    };
    const jobs = createAuditJobs(deps({ seal, retain })).start();
    await vi.advanceTimersByTimeAsync(100);
    expect(seals).toBe(2);
    expect(retains).toBe(1);

    let stopped = false;
    const stopping = jobs.stop().then(() => {
      stopped = true;
    });
    await vi.advanceTimersByTimeAsync(20_000);
    expect(stopped).toBe(false);
    open();
    await stopping;
    expect(stopped).toBe(true);

    await vi.advanceTimersByTimeAsync(50_000);
    expect(seals).toBe(2);
    expect(retains).toBe(1);
  });
});

describe('AUD-7 audit retention job', () => {
  it('AUD-7 runs retention once at start and then every interval', async () => {
    let retains = 0;
    const retain = (): Promise<RetentionReport> => {
      retains += 1;
      return Promise.resolve(NOTHING_DUE);
    };
    const jobs = createAuditJobs(deps({ retain })).start();
    await vi.advanceTimersByTimeAsync(0);
    expect(retains).toBe(1);
    await vi.advanceTimersByTimeAsync(9_999);
    expect(retains).toBe(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(retains).toBe(2);
    await vi.advanceTimersByTimeAsync(20_000);
    expect(retains).toBe(4);
    await jobs.stop();
  });

  it('AUD-7 defaults to sealing every 2000 ms and retention every 21600000 ms', async () => {
    let seals = 0;
    let retains = 0;
    const jobs = createAuditJobs({
      seal: () => {
        seals += 1;
        return Promise.resolve(SEALED);
      },
      retain: () => {
        retains += 1;
        return Promise.resolve(NOTHING_DUE);
      },
      logger: recordingLogger(),
    }).start();
    await vi.advanceTimersByTimeAsync(1_999);
    expect(seals).toBe(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(seals).toBe(2);
    await vi.advanceTimersByTimeAsync(21_600_000 - 2_001);
    expect(retains).toBe(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(retains).toBe(2);
    await jobs.stop();
  });

  it('AUD-7 logs a refused retention as a warning with its reason', async () => {
    const retain = (): Promise<RetentionReport> =>
      Promise.resolve({ kind: 'refused', reason: 'archive_unavailable', rateBucketsDeleted: 0 });
    const jobs = createAuditJobs(deps({ retain })).start();
    await vi.advanceTimersByTimeAsync(0);
    await jobs.stop();
    const warnings = lines.filter((l) => l.level === 'warn');
    expect(warnings).toHaveLength(1);
    expect(warnings[0]?.obj).toEqual({ reason: 'archive_unavailable' });
  });

  it('AUD-7 logs a locked retention at info, and a failed one by error name only', async () => {
    let calls = 0;
    const retain = (): Promise<RetentionReport> => {
      calls += 1;
      return calls === 1 ? Promise.resolve({ kind: 'locked', rateBucketsDeleted: 0 }) : Promise.reject(new TypeError('row actor alice'));
    };
    const jobs = createAuditJobs(deps({ retain })).start();
    await vi.advanceTimersByTimeAsync(10_000);
    expect(calls).toBe(2);
    await jobs.stop();
    expect(lines.filter((l) => l.level === 'warn')).toEqual([]);
    expect(lines.filter((l) => l.level === 'info').map((l) => l.obj)).toContainEqual({ kind: 'locked' });
    expect(lines.filter((l) => l.level === 'error').map((l) => l.obj)).toEqual([{ error: 'TypeError' }]);
    expect(JSON.stringify(lines)).not.toContain('alice');
  });
});
