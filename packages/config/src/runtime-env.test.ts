import { describe, expect, it } from 'vitest';
import { EnvError, parseApiEnv, parseWorkerEnv } from './runtime-env.js';

const DB = 'postgres://aiops:dev-only-secret-value@localhost:5432/aiops';
const AUTH = {
  AIOPS_CONFIG_DIR: '/etc/aiops/config',
  AIOPS_MCP_RESOURCE: 'http://localhost:8400/mcp',
  OIDC_ISSUER: 'http://localhost:8480/realms/aiops',
  OIDC_JWKS_URL: 'http://keycloak:8080/realms/aiops/protocol/openid-connect/certs',
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
