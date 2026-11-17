import { describe, expect, it } from 'vitest';
import { EnvError, parseApiEnv, parseWorkerEnv } from './runtime-env.js';

const DB = 'postgres://aiops:dev-only-secret-value@localhost:5432/aiops';
const AUTH = {
  AIOPS_CONFIG_DIR: '/etc/aiops/config',
  AIOPS_MCP_RESOURCE: 'http://localhost:8400/mcp',
  OIDC_ISSUER: 'http://localhost:8480/realms/aiops',
  OIDC_JWKS_URL: 'http://keycloak:8080/realms/aiops/protocol/openid-connect/certs',
  AIOPS_PUBLIC_URL: 'http://localhost:8400',
  OIDC_WEB_CLIENT_SECRET: 'dev-only-web-secret-value',
  AIOPS_MASTER_KEYS: '1:ZGV2LW9ubHktbWFzdGVyLWtleS0wMTIzNDU2Nzg5YWI=',
};
const API = { DATABASE_URL: DB, ...AUTH };

describe('api runtime environment', () => {
  it('applies defaults', () => {
    expect(parseApiEnv(API)).toEqual({
      databaseUrl: DB,
      port: 8080,
      allowedHosts: ['localhost', '127.0.0.1'],
      logLevel: 'info',
      configDir: '/etc/aiops/config',
      mcpResource: new URL('http://localhost:8400/mcp'),
      oidcIssuer: 'http://localhost:8480/realms/aiops',
      oidcJwksUrl: new URL('http://keycloak:8080/realms/aiops/protocol/openid-connect/certs'),
      publicUrl: new URL('http://localhost:8400'),
      webClientId: 'aiops-web',
      webClientSecret: 'dev-only-web-secret-value',
      oidcAuthorizationUrl: new URL('http://localhost:8480/realms/aiops/protocol/openid-connect/auth'),
      oidcTokenUrl: new URL('http://localhost:8480/realms/aiops/protocol/openid-connect/token'),
      masterKeys: '1:ZGV2LW9ubHktbWFzdGVyLWtleS0wMTIzNDU2Nzg5YWI=',
      sessionMaxAgeSeconds: 28_800,
      freshAuthSeconds: 300,
      presetDirs: [],
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

describe('AUTH-1 api identity settings', () => {
  it.each(['AIOPS_CONFIG_DIR', 'AIOPS_MCP_RESOURCE', 'OIDC_ISSUER', 'OIDC_JWKS_URL'])('requires %s', (name) => {
    const env = Object.fromEntries(Object.entries(API).filter(([key]) => key !== name));
    expect(() => parseApiEnv(env)).toThrow(new RegExp(name));
  });

  it('requires an http(s) resource URL without a fragment', () => {
    expect(() => parseApiEnv({ ...API, AIOPS_MCP_RESOURCE: 'ftp://x/mcp' })).toThrow(/AIOPS_MCP_RESOURCE/);
    expect(() => parseApiEnv({ ...API, AIOPS_MCP_RESOURCE: 'https://x/mcp#a' })).toThrow(/AIOPS_MCP_RESOURCE/);
  });
});

describe('AUTH-5 page login environment', () => {
  it('derives endpoint defaults from the issuer and reads overrides', () => {
    const env = parseApiEnv({
      ...API,
      OIDC_ISSUER: 'http://localhost:8480/realms/aiops/',
      AIOPS_WEB_DIR: '/srv/web',
      AIOPS_PRESET_DIRS: '/p/a: /p/b::',
      AIOPS_SESSION_MAX_AGE_SECONDS: '60',
      AIOPS_FRESH_AUTH_SECONDS: '30',
      OIDC_WEB_CLIENT_ID: 'web2',
      OIDC_TOKEN_URL: 'http://keycloak:8080/t',
    });
    expect(env).toMatchObject({
      oidcAuthorizationUrl: new URL('http://localhost:8480/realms/aiops/protocol/openid-connect/auth'),
      oidcTokenUrl: new URL('http://keycloak:8080/t'),
      webDir: '/srv/web',
      presetDirs: ['/p/a', '/p/b'],
      sessionMaxAgeSeconds: 60,
      freshAuthSeconds: 30,
      webClientId: 'web2',
    });
  });

  it.each(['OIDC_WEB_CLIENT_SECRET', 'AIOPS_PUBLIC_URL', 'AIOPS_MASTER_KEYS'])('requires %s without echoing values', (name) => {
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
      expect(() => parseApiEnv({ ...API, AIOPS_PUBLIC_URL: bad })).toThrow(/AIOPS_PUBLIC_URL/);
    }
  });
});

/** `WORKER` without one variable. */
function without(variable: string): Record<string, string> {
  return Object.fromEntries(Object.entries(WORKER).filter(([k]) => k !== variable));
}

const WORKER = {
  DATABASE_URL: DB,
  AIOPS_CONFIG_DIR: '/etc/aiops/config',
  AIOPS_MASTER_KEYS: '1:ZGV2LW9ubHktbWFzdGVyLWtleS0wMTIzNDU2Nzg5YWI=',
  AIOPS_TEMPORAL_KEYS: '1:ZGV2LW9ubHktdGVtcG9yYWwta2V5LTAxMjM0NTY3ODk=',
};

describe('worker runtime environment', () => {
  it('applies defaults', () => {
    expect(parseWorkerEnv(WORKER)).toEqual({
      temporalAddress: 'localhost:7233',
      temporalNamespace: 'default',
      taskQueue: 'aiops-operations',
      logLevel: 'info',
      databaseUrl: DB,
      configDir: '/etc/aiops/config',
      presetDirs: [],
      masterKeys: WORKER.AIOPS_MASTER_KEYS,
      temporalKeys: WORKER.AIOPS_TEMPORAL_KEYS,
      activityTuning: { batchHeartbeatMs: 30_000, batchTimeoutMs: 900_000, batchMaxAttempts: 10, retryInitialMs: 1_000, retryMaxMs: 30_000 },
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
      AIOPS_PRESET_DIRS: '/app/presets: /opt/presets',
      AIOPS_BATCH_HEARTBEAT_MS: '5000',
      AIOPS_BATCH_TIMEOUT_MS: '60000',
      AIOPS_BATCH_MAX_ATTEMPTS: '3',
      AIOPS_RETRY_INITIAL_MS: '200',
      AIOPS_RETRY_MAX_MS: '2000',
    });
    expect(env).toMatchObject({
      databaseUrl: DB,
      configDir: '/etc/aiops/config',
      presetDirs: ['/app/presets', '/opt/presets'],
      masterKeys: WORKER.AIOPS_MASTER_KEYS,
      temporalKeys: WORKER.AIOPS_TEMPORAL_KEYS,
      activityTuning: { batchHeartbeatMs: 5_000, batchTimeoutMs: 60_000, batchMaxAttempts: 3, retryInitialMs: 200, retryMaxMs: 2_000 },
    });
    for (const required of ['DATABASE_URL', 'AIOPS_CONFIG_DIR', 'AIOPS_MASTER_KEYS']) {
      expect(() => parseWorkerEnv(without(required))).toThrow(new RegExp(`${required}: is required`));
    }
  });

  it('SEC-3 a missing AIOPS_TEMPORAL_KEYS is reported by name without values', () => {
    let error: unknown;
    try {
      parseWorkerEnv(without('AIOPS_TEMPORAL_KEYS'));
    } catch (e) {
      error = e;
    }
    expect(error).toBeInstanceOf(EnvError);
    expect((error as EnvError).issues).toEqual([{ variable: 'AIOPS_TEMPORAL_KEYS', reason: 'is required' }]);
    const message = (error as EnvError).message;
    expect(message).not.toContain(WORKER.AIOPS_MASTER_KEYS);
    expect(message).not.toContain('dev-only-secret-value');
  });

  it('NFR-4 activity tuning must be positive integers', () => {
    for (const variable of ['AIOPS_BATCH_HEARTBEAT_MS', 'AIOPS_BATCH_TIMEOUT_MS', 'AIOPS_BATCH_MAX_ATTEMPTS', 'AIOPS_RETRY_INITIAL_MS', 'AIOPS_RETRY_MAX_MS']) {
      for (const bad of ['0', '-5', '1.5', 'many']) {
        expect(() => parseWorkerEnv({ ...WORKER, [variable]: bad })).toThrow(new RegExp(`${variable}: invalid`));
      }
    }
  });
});
