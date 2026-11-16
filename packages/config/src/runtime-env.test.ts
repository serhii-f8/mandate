import { describe, expect, it } from 'vitest';
import { EnvError, parseApiEnv, parseWorkerEnv } from './runtime-env.js';

const DB = 'postgres://aiops:dev-only-secret-value@localhost:5432/aiops';

describe('api runtime environment', () => {
  it('applies defaults', () => {
    expect(parseApiEnv({ DATABASE_URL: DB })).toEqual({
      databaseUrl: DB,
      port: 8080,
      allowedHosts: ['localhost', '127.0.0.1'],
      logLevel: 'info',
    });
  });

  it('parses and trims the allowed host list', () => {
    expect(parseApiEnv({ DATABASE_URL: DB, API_ALLOWED_HOSTS: ' api.example , localhost ' }).allowedHosts).toEqual([
      'api.example',
      'localhost',
    ]);
  });

  it('names every invalid variable without echoing values', () => {
    let error: unknown;
    try {
      parseApiEnv({ DATABASE_URL: DB, API_PORT: 'abc', LOG_LEVEL: 'loud' });
    } catch (e) {
      error = e;
    }
    expect(error).toBeInstanceOf(EnvError);
    const envError = error as EnvError;
    expect(envError.issues.map((i) => i.variable).sort()).toEqual(['API_PORT', 'LOG_LEVEL']);
    expect(envError.message).toContain('API_PORT');
    expect(envError.message).not.toContain('dev-only-secret-value');
    expect(envError.message).not.toContain('abc');
  });

  it('requires a PostgreSQL DATABASE_URL', () => {
    expect(() => parseApiEnv({})).toThrow(/DATABASE_URL/);
    expect(() => parseApiEnv({ DATABASE_URL: 'mysql://x@y/z' })).toThrow(/DATABASE_URL/);
  });

  it('rejects a port outside 1..65535', () => {
    expect(() => parseApiEnv({ DATABASE_URL: DB, API_PORT: '70000' })).toThrow(/API_PORT/);
  });
});

describe('worker runtime environment', () => {
  it('applies defaults', () => {
    expect(parseWorkerEnv({})).toEqual({
      temporalAddress: 'localhost:7233',
      temporalNamespace: 'default',
      taskQueue: 'aiops-operations',
      logLevel: 'info',
    });
  });

  it('reads Temporal settings', () => {
    expect(
      parseWorkerEnv({ TEMPORAL_ADDRESS: 'temporal:7233', TEMPORAL_NAMESPACE: 'ops', TEMPORAL_TASK_QUEUE: 'q' }),
    ).toMatchObject({ temporalAddress: 'temporal:7233', temporalNamespace: 'ops', taskQueue: 'q' });
  });
});
