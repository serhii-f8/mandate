/**
 * Process environment of `api` and `worker`, parsed at the boundary (CLAUDE.md:
 * external input is parsed with a schema). Errors name the variable and the
 * reason, never the value, because values can be secrets (SEC-3).
 */
import { z } from 'zod';

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

export interface ApiEnv {
  readonly databaseUrl: string;
  readonly port: number;
  /** Host names accepted in `Host` and `Origin` of MCP requests (ADR 0013). */
  readonly allowedHosts: readonly string[];
  readonly logLevel: LogLevel;
  /** Directory of YAML configuration files (CFG-1). */
  readonly configDir: string;
  /** Canonical URL of the MCP endpoint: the token audience and RFC 8707 resource (AUTH-1). */
  readonly mcpResource: URL;
  /** Expected `iss` of access tokens (the public issuer URL). */
  readonly oidcIssuer: string;
  /** Where `api` fetches the issuer's signing keys (may be an internal URL). */
  readonly oidcJwksUrl: URL;
  /** Public origin of the api (no path); base of page and callback URLs (AUTH-5). */
  readonly publicUrl: URL;
  /** OIDC client used for trusted-page login (AUTH-5). */
  readonly webClientId: string;
  readonly webClientSecret: string;
  /** Browser-facing authorization endpoint (public issuer). */
  readonly oidcAuthorizationUrl: URL;
  /** Token endpoint the api calls (may be an internal URL). */
  readonly oidcTokenUrl: URL;
  /** Raw `AIOPS_MASTER_KEYS`; parsed at api start-up with `parseMasterKeys` (SEC-2). */
  readonly masterKeys: string;
  readonly sessionMaxAgeSeconds: number;
  readonly freshAuthSeconds: number;
  /** Directory of the built web bundle, when the api serves it. */
  readonly webDir?: string;
  /** Directories of presets (colon-separated in the environment). */
  readonly presetDirs: readonly string[];
}

export interface WorkerEnv {
  readonly temporalAddress: string;
  readonly temporalNamespace: string;
  readonly taskQueue: string;
  readonly logLevel: LogLevel;
}

export interface EnvIssue {
  readonly variable: string;
  readonly reason: string;
}

export class EnvError extends Error {
  constructor(readonly issues: readonly EnvIssue[]) {
    super(`Invalid environment: ${issues.map((i) => `${i.variable}: ${i.reason}`).join('; ')}`);
    this.name = 'EnvError';
  }
}

const logLevel = z.enum(['debug', 'info', 'warn', 'error']).default('info');
const port = (fallback: number) => z.coerce.number().int().min(1).max(65_535).default(fallback);
const nonEmpty = (fallback: string) => z.string().trim().min(1).default(fallback);
const postgresUrl = z
  .string()
  .refine((v) => /^postgres(ql)?:\/\/./.test(v), { message: 'must be a postgres:// or postgresql:// URL' });

const httpUrl = z.url({ protocol: /^https?$/ });

const apiSchema = z.object({
  DATABASE_URL: postgresUrl,
  API_PORT: port(8080),
  API_ALLOWED_HOSTS: z
    .string()
    .default('localhost,127.0.0.1')
    .transform((v) => v.split(',').map((h) => h.trim()).filter((h) => h.length > 0))
    .refine((hosts) => hosts.length > 0, { message: 'must list at least one host' }),
  LOG_LEVEL: logLevel,
  AIOPS_CONFIG_DIR: z.string().trim().min(1),
  AIOPS_MCP_RESOURCE: httpUrl.refine((v) => !v.includes('#'), { message: 'must not contain a fragment' }),
  OIDC_ISSUER: httpUrl,
  OIDC_JWKS_URL: httpUrl,
  AIOPS_PUBLIC_URL: httpUrl.refine(
    (v) => {
      // Runs even after `z.url()` failed; that failure is already reported.
      if (!URL.canParse(v)) return true;
      const u = new URL(v);
      return u.pathname === '/' && u.search === '' && u.hash === '' && !v.includes('?') && !v.includes('#');
    },
    { message: 'must be an origin without path, query or fragment' },
  ),
  OIDC_WEB_CLIENT_ID: nonEmpty('aiops-web'),
  OIDC_WEB_CLIENT_SECRET: z.string().min(1),
  OIDC_AUTHORIZATION_URL: httpUrl.optional(),
  OIDC_TOKEN_URL: httpUrl.optional(),
  AIOPS_MASTER_KEYS: z.string().trim().min(1),
  AIOPS_SESSION_MAX_AGE_SECONDS: z.coerce.number().int().min(1).default(28_800),
  AIOPS_FRESH_AUTH_SECONDS: z.coerce.number().int().min(1).default(300),
  AIOPS_WEB_DIR: z.string().trim().min(1).optional(),
  AIOPS_PRESET_DIRS: z
    .string()
    .default('')
    .transform((v) => v.split(':').map((d) => d.trim()).filter((d) => d.length > 0)),
});

const workerSchema = z.object({
  TEMPORAL_ADDRESS: nonEmpty('localhost:7233'),
  TEMPORAL_NAMESPACE: nonEmpty('default'),
  TEMPORAL_TASK_QUEUE: nonEmpty('aiops-operations'),
  LOG_LEVEL: logLevel,
});

function parse<S extends z.ZodType>(schema: S, env: NodeJS.ProcessEnv): z.output<S> {
  const result = schema.safeParse(env);
  if (result.success) return result.data;
  // Zod messages for enums and coercions can quote the received value; report only
  // the variable name and a value-free reason.
  throw new EnvError(
    result.error.issues.map((issue) => ({
      variable: String(issue.path[0] ?? '(root)'),
      reason: issue.code === 'custom' ? issue.message : issue.input === undefined ? 'is required' : `invalid (${issue.code})`,
    })),
  );
}

export function parseApiEnv(env: NodeJS.ProcessEnv): ApiEnv {
  const e = parse(apiSchema, env);
  const issuerBase = e.OIDC_ISSUER.replace(/\/+$/, '');
  return {
    databaseUrl: e.DATABASE_URL,
    port: e.API_PORT,
    allowedHosts: e.API_ALLOWED_HOSTS,
    logLevel: e.LOG_LEVEL,
    configDir: e.AIOPS_CONFIG_DIR,
    mcpResource: new URL(e.AIOPS_MCP_RESOURCE),
    oidcIssuer: e.OIDC_ISSUER,
    oidcJwksUrl: new URL(e.OIDC_JWKS_URL),
    publicUrl: new URL(e.AIOPS_PUBLIC_URL),
    webClientId: e.OIDC_WEB_CLIENT_ID,
    webClientSecret: e.OIDC_WEB_CLIENT_SECRET,
    oidcAuthorizationUrl: new URL(e.OIDC_AUTHORIZATION_URL ?? `${issuerBase}/protocol/openid-connect/auth`),
    oidcTokenUrl: new URL(e.OIDC_TOKEN_URL ?? `${issuerBase}/protocol/openid-connect/token`),
    masterKeys: e.AIOPS_MASTER_KEYS,
    sessionMaxAgeSeconds: e.AIOPS_SESSION_MAX_AGE_SECONDS,
    freshAuthSeconds: e.AIOPS_FRESH_AUTH_SECONDS,
    ...(e.AIOPS_WEB_DIR === undefined ? {} : { webDir: e.AIOPS_WEB_DIR }),
    presetDirs: e.AIOPS_PRESET_DIRS,
  };
}

export function parseWorkerEnv(env: NodeJS.ProcessEnv): WorkerEnv {
  const e = parse(workerSchema, env);
  return {
    temporalAddress: e.TEMPORAL_ADDRESS,
    temporalNamespace: e.TEMPORAL_NAMESPACE,
    taskQueue: e.TEMPORAL_TASK_QUEUE,
    logLevel: e.LOG_LEVEL,
  };
}
