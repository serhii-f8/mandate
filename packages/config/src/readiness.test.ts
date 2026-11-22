// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Mandate Authors
import { describe, expect, it } from 'vitest';
import { configurationProbe, probeWithin, readinessStatus, type ReadinessReport } from './readiness.js';

const active = { revision: null, hash: 'abc' } as const;
const report = (over: Partial<ReadinessReport> = {}): ReadinessReport => ({ database: 'ok', configuration: active, temporal: 'unavailable', ...over });

describe('NFR-10 readiness', () => {
  it('NFR-10 api is ready with the database and an active configuration, Temporal reported only', () => {
    expect(readinessStatus(report(), false)).toBe(200);
    expect(readinessStatus(report({ temporal: 'ok' }), true)).toBe(200);
    expect(readinessStatus(report(), true)).toBe(503);
  });

  it('NFR-10 a missing or mismatched configuration is not ready', () => {
    expect(readinessStatus(report({ configuration: 'none' }), false)).toBe(503);
    expect(readinessStatus(report({ configuration: 'configuration_mismatch' }), false)).toBe(503);
    expect(configurationProbe({ status: 'active', revision: null, hash: 'h' })).toEqual({ revision: null, hash: 'h' });
    expect(configurationProbe({ status: 'none' })).toBe('none');
    expect(configurationProbe({ status: 'configuration_mismatch', revision: 'r' })).toBe('configuration_mismatch');
  });

  it('NFR-10 the database down is not ready', () => {
    expect(readinessStatus(report({ database: 'unavailable' }), false)).toBe(503);
  });

  it('NFR-10 probeWithin turns a hang into unavailable', async () => {
    expect(await probeWithin(() => new Promise<never>(() => undefined), 50)).toBe('unavailable');
    expect(await probeWithin(() => Promise.reject(new Error('x')), 50)).toBe('unavailable');
    expect(await probeWithin(() => Promise.resolve(1), 50)).toBe('ok');
  });
});
