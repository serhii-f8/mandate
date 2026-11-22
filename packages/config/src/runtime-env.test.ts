// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Mandate Authors
import { describe, expect, it } from 'vitest';
import { EnvError, parseApiEnv, parseWorkerEnv } from './runtime-env.js';

const DB = 'postgres://mandate:dev-only-secret-value@localhost:5432/mandate';
const AUTH = {
  MANDATE_CONFIG_DIR: '/etc/mandate/config',
  MANDATE_MCP_RESOURCE: 'http://localhost:8400/mcp',
  OIDC_ISSUER: 'http://localhost:8480/realms/mandate',
  OIDC_JWKS_URL: 'http://keycloak:8080/realms/mandate/protocol/openid-connect/certs',
  MANDATE_PUBLIC_URL: 'http://localhost:8400',
  OIDC_WEB_CLIENT_SECRET: 'dev-only-web-secret-value',
  MANDATE_MASTER_KEYS: '1:ZGV2LW9ubHktbWFzdGVyLWtleS0wMTIzNDU2Nzg5YWI=',
  MANDATE_TEMPORAL_KEYS: '1:ZGV2LW9ubHktdGVtcG9yYWwta2V5LTAxMjM0NTY3ODk=',
};
const API = { DATABASE_URL: DB, ...AUTH };

describe('api runtime environment', () => {
  it('applies defaults', () => {
    expect(parseApiEnv(API)).toEqual({
      databaseUrl: DB,
      port: 8080,
      allowedHosts: ['localhost', '127.0.0.1'],
      logLevel: 'info',
      configDir: '/etc/mandate/config',
      mcpResource: new URL('http://localhost:8400/mcp'),
      oidcIssuer: 'http://localhost:8480/realms/mandate',
      oidcJwksUrl: new URL('http://keycloak:8080/realms/mandate/protocol/openid-connect/certs'),
      publicUrl: new URL('http://localhost:8400'),
      webClientId: 'mandate-web',
      webClientSecret: 'dev-only-web-secret-value',
      oidcAuthorizationUrl: new URL('http://localhost:8480/realms/mandate/protocol/openid-connect/auth'),
      oidcTokenUrl: new URL('http://localhost:8480/realms/mandate/protocol/openid-connect/token'),
      masterKeys: '1:ZGV2LW9ubHktbWFzdGVyLWtleS0wMTIzNDU2Nzg5YWI=',
      sessionMaxAgeSeconds: 28_800,
      freshAuthSeconds: 300,
      presetDirs: [],
      temporalAddress: 'localhost:7233',
      temporalNamespace: 'default',
      taskQueue: 'mandate-operations',
      temporalKeys: '1:ZGV2LW9ubHktdGVtcG9yYWwta2V5LTAxMjM0NTY3ODk=',
      prepareWaitMs: 20_000,
      metricsPort: 9464,
      trustProxy: 0,
    });
  });

  it('parses and trims the allowed host list', () => {
    expect(parseApiEnv({ ...API, API_ALLOWED_HOSTS: ' api.example , localhost ' }).allowedHosts).toEqual([
      'api.example',
      'localhost',
    ]);
  });

  it('names every invalid variable without echoing values', () => {
    let error: unknown;
    try {
      parseApiEnv({ ...API, API_PORT: 'abc', LOG_LEVEL: 'loud' });
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
    expect(() => parseApiEnv(AUTH)).toThrow(/DATABASE_URL/);
    expect(() => parseApiEnv({ ...AUTH, DATABASE_URL: 'mysql://x@y/z' })).toThrow(/DATABASE_URL/);
  });

  it('rejects a port outside 1..65535', () => {
    expect(() => parseApiEnv({ ...API, API_PORT: '70000' })).toThrow(/API_PORT/);
  });
});

describe('MCP-7 api Temporal settings and prepare wait', () => {
  it('parseApiEnv reads the Temporal settings and the prepare wait', () => {
    expect(parseApiEnv(API)).toMatchObject({
      temporalAddress: 'localhost:7233',
      temporalNamespace: 'default',
      taskQueue: 'mandate-operations',
      prepareWaitMs: 20_000,
    });
    expect(
      parseApiEnv({
        ...API,
        TEMPORAL_ADDRESS: 'temporal:7233',
        TEMPORAL_NAMESPACE: 'ops',
        TEMPORAL_TASK_QUEUE: 'q',
        MANDATE_PREPARE_WAIT_MS: '0',
      }),
    ).toMatchObject({ temporalAddress: 'temporal:7233', temporalNamespace: 'ops', taskQueue: 'q', prepareWaitMs: 0 });
    expect(parseApiEnv({ ...API, MANDATE_PREPARE_WAIT_MS: '300000' }).prepareWaitMs).toBe(300_000);
  });

  it('SEC-4 parseApiEnv requires MANDATE_TEMPORAL_KEYS and names it without the value', () => {
    let error: unknown;
    try {
      parseApiEnv(Object.fromEntries(Object.entries(API).filter(([key]) => key !== 'MANDATE_TEMPORAL_KEYS')));
    } catch (e) {
      error = e;
    }
    expect(error).toBeInstanceOf(EnvError);
    expect((error as EnvError).issues).toEqual([{ variable: 'MANDATE_TEMPORAL_KEYS', reason: 'is required' }]);
    // Present but blank: still named by variable, the reason carries no value.
    let blank: unknown;
    try {
      parseApiEnv({ ...API, MANDATE_TEMPORAL_KEYS: ' \t ' });
    } catch (e) {
      blank = e;
    }
    expect(blank).toBeInstanceOf(EnvError);
    expect((blank as EnvError).issues).toEqual([{ variable: 'MANDATE_TEMPORAL_KEYS', reason: 'invalid (too_small)' }]);
  });

  it('MANDATE_PREPARE_WAIT_MS outside 0..300000 is rejected by name', () => {
    for (const bad of ['-1', '300001', '1.5', 'soon']) {
      let error: unknown;
      try {
        parseApiEnv({ ...API, MANDATE_PREPARE_WAIT_MS: bad });
      } catch (e) {
        error = e;
      }
      expect(error).toBeInstanceOf(EnvError);
      expect((error as EnvError).issues.map((i) => i.variable)).toEqual(['MANDATE_PREPARE_WAIT_MS']);
      expect((error as EnvError).message).not.toContain(bad);
    }
  });
});

describe('AUTH-1 api identity settings', () => {
  it.each(['MANDATE_CONFIG_DIR', 'MANDATE_MCP_RESOURCE', 'OIDC_ISSUER', 'OIDC_JWKS_URL'])('requires %s', (name) => {
    const env = Object.fromEntries(Object.entries(API).filter(([key]) => key !== name));
    expect(() => parseApiEnv(env)).toThrow(new RegExp(name));
  });

  it('requires an http(s) resource URL without a fragment', () => {
    expect(() => parseApiEnv({ ...API, MANDATE_MCP_RESOURCE: 'ftp://x/mcp' })).toThrow(/MANDATE_MCP_RESOURCE/);
    expect(() => parseApiEnv({ ...API, MANDATE_MCP_RESOURCE: 'https://x/mcp#a' })).toThrow(/MANDATE_MCP_RESOURCE/);
  });
});

describe('MCP-5 widget directory environment', () => {
  it('MCP-5 parseApiEnv reads MANDATE_WIDGET_DIR and leaves it unset by default', () => {
    expect(parseApiEnv({ ...API, MANDATE_WIDGET_DIR: '/srv/widgets' })).toMatchObject({ widgetDir: '/srv/widgets' });
    expect('widgetDir' in parseApiEnv({ ...API })).toBe(false);
    expect(() => parseApiEnv({ ...API, MANDATE_WIDGET_DIR: '' })).toThrow(/MANDATE_WIDGET_DIR/);
  });
});

describe('AUTH-5 page login environment', () => {
  it('derives endpoint defaults from the issuer and reads overrides', () => {
    const env = parseApiEnv({
      ...API,
      OIDC_ISSUER: 'http://localhost:8480/realms/mandate/',
      MANDATE_WEB_DIR: '/srv/web',
      MANDATE_PRESET_DIRS: '/p/a: /p/b::',
      MANDATE_SESSION_MAX_AGE_SECONDS: '60',
      MANDATE_FRESH_AUTH_SECONDS: '30',
      OIDC_WEB_CLIENT_ID: 'web2',
      OIDC_TOKEN_URL: 'http://keycloak:8080/t',
    });
    expect(env).toMatchObject({
      oidcAuthorizationUrl: new URL('http://localhost:8480/realms/mandate/protocol/openid-connect/auth'),
      oidcTokenUrl: new URL('http://keycloak:8080/t'),
      webDir: '/srv/web',
      presetDirs: ['/p/a', '/p/b'],
      sessionMaxAgeSeconds: 60,
      freshAuthSeconds: 30,
      webClientId: 'web2',
    });
  });

  it.each(['OIDC_WEB_CLIENT_SECRET', 'MANDATE_PUBLIC_URL', 'MANDATE_MASTER_KEYS'])('requires %s without echoing values', (name) => {
    const env = Object.fromEntries(Object.entries(API).filter(([key]) => key !== name));
    let error: unknown;
    try {
      parseApiEnv(env);
    } catch (e) {
      error = e;
    }
    expect(error).toBeInstanceOf(EnvError);
    expect((error as EnvError).message).toContain(name);
    expect((error as EnvError).message).not.toContain('dev-only-web-secret-value');
  });

  it('rejects a public URL with a path, query or fragment', () => {
    for (const bad of ['not a url', 'http://localhost:8400/app', 'http://localhost:8400/?a=1', 'http://localhost:8400/#x', 'ftp://x']) {
      expect(() => parseApiEnv({ ...API, MANDATE_PUBLIC_URL: bad })).toThrow(/MANDATE_PUBLIC_URL/);
    }
  });
});

/** `WORKER` without one variable. */
function without(variable: string): Record<string, string> {
  return Object.fromEntries(Object.entries(WORKER).filter(([k]) => k !== variable));
}

const WORKER = {
  DATABASE_URL: DB,
  MANDATE_CONFIG_DIR: '/etc/mandate/config',
  MANDATE_MASTER_KEYS: '1:ZGV2LW9ubHktbWFzdGVyLWtleS0wMTIzNDU2Nzg5YWI=',
  MANDATE_TEMPORAL_KEYS: '1:ZGV2LW9ubHktdGVtcG9yYWwta2V5LTAxMjM0NTY3ODk=',
};

describe('worker runtime environment', () => {
  it('applies defaults', () => {
    expect(parseWorkerEnv(WORKER)).toEqual({
      temporalAddress: 'localhost:7233',
      temporalNamespace: 'default',
      taskQueue: 'mandate-operations',
      logLevel: 'info',
      databaseUrl: DB,
      configDir: '/etc/mandate/config',
      presetDirs: [],
      masterKeys: WORKER.MANDATE_MASTER_KEYS,
      temporalKeys: WORKER.MANDATE_TEMPORAL_KEYS,
      activityTuning: { prepareTimeoutMs: 3_600_000, batchHeartbeatMs: 30_000, batchTimeoutMs: 900_000, batchMaxAttempts: 10, retryInitialMs: 1_000, retryMaxMs: 30_000 },
      mailFrom: 'mandate@localhost',
      publicUrl: new URL('http://localhost:8400/'),
      httpPort: 8081,
    });
  });

  it('reads Temporal settings', () => {
    expect(
      parseWorkerEnv({ ...WORKER, TEMPORAL_ADDRESS: 'temporal:7233', TEMPORAL_NAMESPACE: 'ops', TEMPORAL_TASK_QUEUE: 'q' }),
    ).toMatchObject({ temporalAddress: 'temporal:7233', temporalNamespace: 'ops', taskQueue: 'q' });
  });

  it('NFR-4 parseWorkerEnv reads database, configuration, keys and activity tuning', () => {
    const env = parseWorkerEnv({
      ...WORKER,
      MANDATE_PRESET_DIRS: '/app/presets: /opt/presets',
      MANDATE_PREPARE_TIMEOUT_MS: '7200000',
      MANDATE_BATCH_HEARTBEAT_MS: '15000',
      MANDATE_BATCH_TIMEOUT_MS: '60000',
      MANDATE_BATCH_MAX_ATTEMPTS: '3',
      MANDATE_RETRY_INITIAL_MS: '200',
      MANDATE_RETRY_MAX_MS: '2000',
    });
    expect(env).toMatchObject({
      databaseUrl: DB,
      configDir: '/etc/mandate/config',
      presetDirs: ['/app/presets', '/opt/presets'],
      masterKeys: WORKER.MANDATE_MASTER_KEYS,
      temporalKeys: WORKER.MANDATE_TEMPORAL_KEYS,
      activityTuning: { prepareTimeoutMs: 7_200_000, batchHeartbeatMs: 15_000, batchTimeoutMs: 60_000, batchMaxAttempts: 3, retryInitialMs: 200, retryMaxMs: 2_000 },
    });
    for (const required of ['DATABASE_URL', 'MANDATE_CONFIG_DIR', 'MANDATE_MASTER_KEYS']) {
      expect(() => parseWorkerEnv(without(required))).toThrow(new RegExp(`${required}: is required`));
    }
  });

  it('SEC-3 a missing MANDATE_TEMPORAL_KEYS is reported by name without values', () => {
    let error: unknown;
    try {
      parseWorkerEnv(without('MANDATE_TEMPORAL_KEYS'));
    } catch (e) {
      error = e;
    }
    expect(error).toBeInstanceOf(EnvError);
    expect((error as EnvError).issues).toEqual([{ variable: 'MANDATE_TEMPORAL_KEYS', reason: 'is required' }]);
    const message = (error as EnvError).message;
    expect(message).not.toContain(WORKER.MANDATE_MASTER_KEYS);
    expect(message).not.toContain('dev-only-secret-value');
  });

  it('NFR-4 activity tuning must be positive integers', () => {
    for (const variable of ['MANDATE_PREPARE_TIMEOUT_MS', 'MANDATE_BATCH_HEARTBEAT_MS', 'MANDATE_BATCH_TIMEOUT_MS', 'MANDATE_BATCH_MAX_ATTEMPTS', 'MANDATE_RETRY_INITIAL_MS', 'MANDATE_RETRY_MAX_MS']) {
      for (const bad of ['0', '-5', '1.5', 'many']) {
        expect(() => parseWorkerEnv({ ...WORKER, [variable]: bad })).toThrow(new RegExp(`${variable}: invalid`));
      }
    }
  });

  it('NFR-4 the retry initial interval must not exceed the retry maximum interval, reported without values', () => {
    expect(parseWorkerEnv({ ...WORKER, MANDATE_RETRY_INITIAL_MS: '2000', MANDATE_RETRY_MAX_MS: '2000' }).activityTuning).toMatchObject({
      retryInitialMs: 2_000,
      retryMaxMs: 2_000,
    });
    let error: unknown;
    try {
      parseWorkerEnv({ ...WORKER, MANDATE_RETRY_INITIAL_MS: '45678', MANDATE_RETRY_MAX_MS: '12345' });
    } catch (e) {
      error = e;
    }
    expect(error).toBeInstanceOf(EnvError);
    expect((error as EnvError).issues).toEqual([
      { variable: 'MANDATE_RETRY_INITIAL_MS', reason: 'must not exceed MANDATE_RETRY_MAX_MS' },
    ]);
    expect((error as EnvError).message).not.toMatch(/45678|12345/);
    // Only the default of the other variable can be exceeded, too.
    expect(() => parseWorkerEnv({ ...WORKER, MANDATE_RETRY_INITIAL_MS: '30001' })).toThrow(
      /MANDATE_RETRY_INITIAL_MS: must not exceed MANDATE_RETRY_MAX_MS/,
    );
  });

  it('EXE-4 the batch heartbeat timeout must exceed the longest poll pause plus a margin (10000 ms), reported without values', () => {
    let error: unknown;
    try {
      parseWorkerEnv({ ...WORKER, MANDATE_BATCH_HEARTBEAT_MS: '9999' });
    } catch (e) {
      error = e;
    }
    expect(error).toBeInstanceOf(EnvError);
    expect((error as EnvError).issues).toEqual([
      { variable: 'MANDATE_BATCH_HEARTBEAT_MS', reason: 'must be greater than 10000 (the longest status poll pause plus a margin)' },
    ]);
    expect((error as EnvError).message).not.toContain('9999');
    expect(() => parseWorkerEnv({ ...WORKER, MANDATE_BATCH_HEARTBEAT_MS: '10000' })).toThrow(/MANDATE_BATCH_HEARTBEAT_MS: must be greater than 10000/);
    expect(parseWorkerEnv({ ...WORKER, MANDATE_BATCH_HEARTBEAT_MS: '10001' }).activityTuning.batchHeartbeatMs).toBe(10_001);
  });

  it('NFR-7 the preparation timeout must exceed the 60000 ms preparation heartbeat timeout, reported without values', () => {
    let error: unknown;
    try {
      parseWorkerEnv({ ...WORKER, MANDATE_PREPARE_TIMEOUT_MS: '60000' });
    } catch (e) {
      error = e;
    }
    expect(error).toBeInstanceOf(EnvError);
    expect((error as EnvError).issues).toEqual([
      { variable: 'MANDATE_PREPARE_TIMEOUT_MS', reason: 'must be greater than 60000 (the preparation heartbeat timeout)' },
    ]);
    expect(parseWorkerEnv({ ...WORKER, MANDATE_PREPARE_TIMEOUT_MS: '60001' }).activityTuning.prepareTimeoutMs).toBe(60_001);
  });

  it('NFR-4 the batch heartbeat must be shorter than the batch timeout, reported without values', () => {
    let error: unknown;
    try {
      parseWorkerEnv({ ...WORKER, MANDATE_BATCH_HEARTBEAT_MS: '54321', MANDATE_BATCH_TIMEOUT_MS: '54321' });
    } catch (e) {
      error = e;
    }
    expect(error).toBeInstanceOf(EnvError);
    expect((error as EnvError).issues).toEqual([
      { variable: 'MANDATE_BATCH_HEARTBEAT_MS', reason: 'must be less than MANDATE_BATCH_TIMEOUT_MS' },
    ]);
    expect((error as EnvError).message).not.toContain('54321');
    expect(parseWorkerEnv({ ...WORKER, MANDATE_BATCH_HEARTBEAT_MS: '54320', MANDATE_BATCH_TIMEOUT_MS: '54321' }).activityTuning).toMatchObject({
      batchHeartbeatMs: 54_320,
      batchTimeoutMs: 54_321,
    });
  });
});

/** The EnvError thrown by `parseWorkerEnv` for `env`, or a failure when it parses. */
function workerEnvError(env: Record<string, string>): EnvError {
  try {
    parseWorkerEnv(env);
  } catch (e) {
    if (e instanceof EnvError) return e;
    throw e;
  }
  throw new Error('expected an EnvError');
}

describe('NTF-1 worker notification environment', () => {
  it('NTF-1 parseWorkerEnv reads MANDATE_SMTP_URL, MANDATE_MAIL_FROM and MANDATE_PUBLIC_URL', () => {
    const env = parseWorkerEnv({
      ...WORKER,
      MANDATE_SMTP_URL: 'smtp://mailpit:1025',
      MANDATE_MAIL_FROM: ' ops@example.test ',
      MANDATE_PUBLIC_URL: 'https://mandate.example.test',
    });
    expect(env.smtpUrl).toBe('smtp://mailpit:1025');
    expect(env.mailFrom).toBe('ops@example.test');
    expect(env.publicUrl).toEqual(new URL('https://mandate.example.test/'));
    expect(parseWorkerEnv({ ...WORKER, MANDATE_SMTP_URL: 'smtps://mail.example.test:465/' }).smtpUrl).toBe('smtps://mail.example.test:465/');
  });

  it('NTF-1 notification defaults', () => {
    const env = parseWorkerEnv(WORKER);
    expect(env.smtpUrl).toBeUndefined();
    expect('smtpUrl' in env).toBe(false);
    expect(env.mailFrom).toBe('mandate@localhost');
    expect(env.publicUrl.href).toBe('http://localhost:8400/');
  });

  it('SEC-3 an invalid MANDATE_SMTP_URL is reported by name without its value', () => {
    const error = workerEnvError({ ...WORKER, MANDATE_SMTP_URL: 'http://u:pw-secret@x' });
    expect(error.message).toContain('MANDATE_SMTP_URL');
    expect(error.message).not.toContain('pw-secret');
    expect(() => parseWorkerEnv({ ...WORKER, MANDATE_SMTP_URL: 'smtp://mail:1025/path' })).toThrow(/MANDATE_SMTP_URL/);
  });

  it('SEC-3 an smtp URL with credentials parses and its error never echoes it', () => {
    expect(parseWorkerEnv({ ...WORKER, MANDATE_SMTP_URL: 'smtp://user:pw@mail:587' }).smtpUrl).toBe('smtp://user:pw@mail:587');
    const error = workerEnvError({ ...WORKER, MANDATE_SMTP_URL: 'smtp://user:pw@mail:99999' });
    expect(error.issues.map((i) => i.variable)).toEqual(['MANDATE_SMTP_URL']);
    expect(error.message).not.toContain('user:pw');
    expect(error.message).not.toContain('99999');
  });

  it('NTF-1 MANDATE_MAIL_FROM must be one address of at most 254 characters, reported without its value', () => {
    for (const bad of ['no-at-sign', 'a b@example.test', 'Ops <ops@example.test>', `${'a'.repeat(250)}@x.test`]) {
      const error = workerEnvError({ ...WORKER, MANDATE_MAIL_FROM: bad });
      expect(error.issues.map((i) => i.variable)).toEqual(['MANDATE_MAIL_FROM']);
      expect(error.message).not.toContain(bad);
    }
  });

  it('NTF-1 the worker MANDATE_PUBLIC_URL must be an origin, as in api', () => {
    for (const bad of ['not a url', 'http://localhost:8400/app', 'http://localhost:8400/?a=1', 'http://localhost:8400/#x', 'ftp://x']) {
      expect(() => parseWorkerEnv({ ...WORKER, MANDATE_PUBLIC_URL: bad })).toThrow(/MANDATE_PUBLIC_URL/);
    }
  });
});

describe('AUD-7 worker audit archive environment', () => {
  it('AUD-7 MANDATE_AUDIT_ARCHIVE_DIR is optional and must be absolute', () => {
    const unset = parseWorkerEnv(WORKER);
    expect('auditArchiveDir' in unset).toBe(false);
    expect(parseWorkerEnv({ ...WORKER, MANDATE_AUDIT_ARCHIVE_DIR: '/var/lib/mandate/audit-archive' }).auditArchiveDir).toBe(
      '/var/lib/mandate/audit-archive',
    );
    for (const bad of ['', 'relative/dir', './archive', ' ']) {
      const error = workerEnvError({ ...WORKER, MANDATE_AUDIT_ARCHIVE_DIR: bad });
      expect(error.issues.map((i) => i.variable)).toEqual(['MANDATE_AUDIT_ARCHIVE_DIR']);
    }
  });
});

describe('AUD-7 api audit archive environment', () => {
  it('AUD-7 the api parses MANDATE_AUDIT_ARCHIVE_DIR: optional, absolute', () => {
    expect('auditArchiveDir' in parseApiEnv(API)).toBe(false);
    expect(parseApiEnv({ ...API, MANDATE_AUDIT_ARCHIVE_DIR: '/var/lib/mandate/audit-archive' }).auditArchiveDir).toBe('/var/lib/mandate/audit-archive');
    expect(() => parseApiEnv({ ...API, MANDATE_AUDIT_ARCHIVE_DIR: 'relative/dir' })).toThrow(EnvError);
  });
});

describe('telemetry environment', () => {
  it('NFR-11 OTEL_EXPORTER_OTLP_ENDPOINT is optional and empty means unset', () => {
    for (const parse of [(e: Record<string, string>) => parseApiEnv({ ...API, ...e }), (e: Record<string, string>) => parseWorkerEnv({ ...WORKER, ...e })]) {
      expect('otlpEndpoint' in parse({})).toBe(false);
      expect('otlpEndpoint' in parse({ OTEL_EXPORTER_OTLP_ENDPOINT: '' })).toBe(false);
      expect('otlpEndpoint' in parse({ OTEL_EXPORTER_OTLP_ENDPOINT: '  ' })).toBe(false);
      expect(parse({ OTEL_EXPORTER_OTLP_ENDPOINT: 'http://jaeger:4318' }).otlpEndpoint?.href).toBe(new URL('http://jaeger:4318').href);
      for (const bad of ['ftp://x', 'not a url']) {
        let error: unknown;
        try {
          parse({ OTEL_EXPORTER_OTLP_ENDPOINT: bad });
        } catch (e) {
          error = e;
        }
        expect(error).toBeInstanceOf(EnvError);
        expect((error as EnvError).message).toContain('OTEL_EXPORTER_OTLP_ENDPOINT');
        expect((error as EnvError).message).not.toContain(bad);
      }
    }
  });

  it('NFR-12 MANDATE_METRICS_PORT defaults to 9464 and accepts 0', () => {
    expect(parseApiEnv(API).metricsPort).toBe(9464);
    expect(parseApiEnv({ ...API, MANDATE_METRICS_PORT: '0' }).metricsPort).toBe(0);
    expect(parseApiEnv({ ...API, MANDATE_METRICS_PORT: '9100' }).metricsPort).toBe(9100);
    for (const bad of ['65536', '-1']) expect(() => parseApiEnv({ ...API, MANDATE_METRICS_PORT: bad })).toThrow(/MANDATE_METRICS_PORT/);
  });

  it('NFR-10 MANDATE_WORKER_HTTP_PORT defaults to 8081 and accepts 0', () => {
    expect(parseWorkerEnv(WORKER).httpPort).toBe(8081);
    expect(parseWorkerEnv({ ...WORKER, MANDATE_WORKER_HTTP_PORT: '0' }).httpPort).toBe(0);
    for (const bad of ['65536', '-1']) expect(() => parseWorkerEnv({ ...WORKER, MANDATE_WORKER_HTTP_PORT: bad })).toThrow(/MANDATE_WORKER_HTTP_PORT/);
  });
});

describe('telemetry port environment edge cases', () => {
  it('NFR-12 NFR-10 an empty or blank port variable means the default; non-integers are refused', () => {
    const cases: [string, (e: Record<string, string>) => number, number][] = [
      ['MANDATE_METRICS_PORT', (e) => parseApiEnv({ ...API, ...e }).metricsPort, 9464],
      ['MANDATE_WORKER_HTTP_PORT', (e) => parseWorkerEnv({ ...WORKER, ...e }).httpPort, 8081],
    ];
    for (const [variable, read, fallback] of cases) {
      expect(read({ [variable]: '' })).toBe(fallback);
      expect(read({ [variable]: '  ' })).toBe(fallback);
      for (const bad of ['abc', '1.5']) {
        expect(() => read({ [variable]: bad })).toThrow(EnvError);
        expect(() => read({ [variable]: bad })).toThrow(new RegExp(variable));
      }
    }
  });
});

describe('SEC-10 proxy trust environment', () => {
  it('SEC-10 MANDATE_TRUST_PROXY defaults to 0, accepts 0..10, refuses 11, -1, 1.5, abc', () => {
    expect(parseApiEnv(API).trustProxy).toBe(0);
    for (const ok of [0, 1, 5, 10]) expect(parseApiEnv({ ...API, MANDATE_TRUST_PROXY: String(ok) }).trustProxy).toBe(ok);
    for (const bad of ['11', '-1', '1.5', 'abc']) {
      try {
        parseApiEnv({ ...API, MANDATE_TRUST_PROXY: bad });
        expect.unreachable(`MANDATE_TRUST_PROXY=${bad} was accepted`);
      } catch (error) {
        expect(error).toBeInstanceOf(EnvError);
        expect((error as EnvError).issues.map((i) => i.variable)).toEqual(['MANDATE_TRUST_PROXY']);
        expect((error as EnvError).message).not.toContain(bad);
      }
    }
  });
});
