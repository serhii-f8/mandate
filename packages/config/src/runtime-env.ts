/**
 * Process environment of `api` and `worker`, parsed at the boundary (CLAUDE.md:
 * external input is parsed with a schema). Errors name the variable and the
 * reason, never the value, because values can be secrets (SEC-3).
 */
import { POLL_MAX_MS } from '@aiops/core';
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
  /** Directory of the widget bundles (`AIOPS_WIDGET_DIR`); the development location when unset. */
  readonly widgetDir?: string;
  /** Directories of presets (colon-separated in the environment). */
  readonly presetDirs: readonly string[];
  /** Temporal frontend the api starts, signals and queries workflows on (EXE-11). */
  readonly temporalAddress: string;
  readonly temporalNamespace: string;
  readonly taskQueue: string;
  /** Raw `AIOPS_TEMPORAL_KEYS`; parsed at api start-up with `parseTemporalKeys` (SEC-4). */
  readonly temporalKeys: string;
  /** How long a write call without Tasks waits for its preparation, in ms (MCP-7). */
  readonly prepareWaitMs: number;
  /** Absolute directory of audit retention archives (`AIOPS_AUDIT_ARCHIVE_DIR`, AUD-7); unset keeps rows. */
  readonly auditArchiveDir?: string;
}

/** Activity timeouts and retries of the operation workflow (same shape as `ActivityTuning` of `@aiops/temporal`). */
export interface WorkerActivityTuning {
  /** Start-to-close of one preparation attempt, the ceiling of a whole preparation (NFR-7). */
  readonly prepareTimeoutMs: number;
  readonly batchHeartbeatMs: number;
  readonly batchTimeoutMs: number;
  readonly batchMaxAttempts: number;
  readonly retryInitialMs: number;
  readonly retryMaxMs: number;
}

export interface WorkerEnv {
  readonly temporalAddress: string;
  readonly temporalNamespace: string;
  readonly taskQueue: string;
  readonly logLevel: LogLevel;
  readonly databaseUrl: string;
  /** Directory of YAML configuration files (CFG-1); the worker loads it like `api`. */
  readonly configDir: string;
  /** Directories of presets (colon-separated in the environment). */
  readonly presetDirs: readonly string[];
  /** Raw `AIOPS_MASTER_KEYS`; parsed at worker start-up with `parseMasterKeys` (SEC-2). */
  readonly masterKeys: string;
  /** Raw `AIOPS_TEMPORAL_KEYS`; parsed at worker start-up with `parseTemporalKeys` (SEC-4). */
  readonly temporalKeys: string;
  readonly activityTuning: WorkerActivityTuning;
  /** `smtp://host:port` or `smtps://host:port` of the mail relay (NTF-1); without it e-mail notifications fail with `channel_unconfigured`. */
  readonly smtpUrl?: string;
  /** Sender address of notification e-mails (NTF-1). */
  readonly mailFrom: string;
  /** Public origin of the api (no path); base of the change-set links in notifications (NTF-2). */
  readonly publicUrl: URL;
  /** Absolute directory of the audit archive files (AUD-7); without it retention refuses with `archive_unavailable`. */
  readonly auditArchiveDir?: string;
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

const positiveInt = (fallback: number) => z.coerce.number().int().positive().default(fallback);
const presetDirs = z
  .string()
  .default('')
  .transform((v) => v.split(':').map((d) => d.trim()).filter((d) => d.length > 0));

const httpUrl = z.url({ protocol: /^https?$/ });

/** An http(s) origin without path, query or fragment; `api` and `worker` share the rule. */
const originUrl = httpUrl.refine(
  (v) => {
    // Runs even after `z.url()` failed; that failure is already reported.
    if (!URL.canParse(v)) return true;
    const u = new URL(v);
    return u.pathname === '/' && u.search === '' && u.hash === '' && !v.includes('?') && !v.includes('#');
  },
  { message: 'must be an origin without path, query or fragment' },
);

const SMTP_URL = /^smtps?:\/\/[^/?#\s]+(:\d{1,5})?\/?$/;

/**
 * `smtp://host:port` or `smtps://host:port`, user info allowed (relays may need auth). The
 * pattern lets an out-of-range port through, so the value must also parse as a URL with a host.
 * The message is fixed: the value can hold a password (SEC-3).
 */
const smtpUrl = z.string().refine(
  (v) => SMTP_URL.test(v) && URL.canParse(v) && new URL(v).hostname !== '',
  { message: 'must be smtp://host:port or smtps://host:port' },
);

const mailAddress = z
  .string()
  .trim()
  .max(254)
  .regex(/^[^\s@<>]+@[^\s@<>]+$/);

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
  AIOPS_PUBLIC_URL: originUrl,
  OIDC_WEB_CLIENT_ID: nonEmpty('aiops-web'),
  OIDC_WEB_CLIENT_SECRET: z.string().min(1),
  OIDC_AUTHORIZATION_URL: httpUrl.optional(),
  OIDC_TOKEN_URL: httpUrl.optional(),
  AIOPS_MASTER_KEYS: z.string().trim().min(1),
  AIOPS_SESSION_MAX_AGE_SECONDS: z.coerce.number().int().min(1).default(28_800),
  AIOPS_FRESH_AUTH_SECONDS: z.coerce.number().int().min(1).default(300),
  AIOPS_WEB_DIR: z.string().trim().min(1).optional(),
  AIOPS_WIDGET_DIR: z.string().trim().min(1).optional(),
  AIOPS_PRESET_DIRS: presetDirs,
  TEMPORAL_ADDRESS: nonEmpty('localhost:7233'),
  TEMPORAL_NAMESPACE: nonEmpty('default'),
  TEMPORAL_TASK_QUEUE: nonEmpty('aiops-operations'),
  AIOPS_TEMPORAL_KEYS: z.string().trim().min(1),
  AIOPS_PREPARE_WAIT_MS: z.coerce.number().int().min(0).max(300_000).default(20_000),
  AIOPS_AUDIT_ARCHIVE_DIR: z.string().startsWith('/', { message: 'must be an absolute path' }).optional(),
});

/**
 * The batch heartbeat timeout must exceed the longest pause between two status polls (one
 * heartbeat per round) plus this margin for the status call itself (EXE-4).
 */
const HEARTBEAT_MARGIN_MS = 5_000;
const MIN_BATCH_HEARTBEAT_MS = POLL_MAX_MS + HEARTBEAT_MARGIN_MS;
/** The fixed heartbeat timeout of `prepare` (`PREPARE_HEARTBEAT_MS` of `@aiops/temporal`). */
const PREPARE_HEARTBEAT_MS = 60_000;

const workerSchema = z.object({
  TEMPORAL_ADDRESS: nonEmpty('localhost:7233'),
  TEMPORAL_NAMESPACE: nonEmpty('default'),
  TEMPORAL_TASK_QUEUE: nonEmpty('aiops-operations'),
  LOG_LEVEL: logLevel,
  DATABASE_URL: postgresUrl,
  AIOPS_CONFIG_DIR: z.string().trim().min(1),
  AIOPS_PRESET_DIRS: presetDirs,
  AIOPS_MASTER_KEYS: z.string().trim().min(1),
  AIOPS_TEMPORAL_KEYS: z.string().trim().min(1),
  AIOPS_PREPARE_TIMEOUT_MS: positiveInt(3_600_000),
  AIOPS_BATCH_HEARTBEAT_MS: positiveInt(30_000),
  AIOPS_BATCH_TIMEOUT_MS: positiveInt(900_000),
  AIOPS_BATCH_MAX_ATTEMPTS: positiveInt(10),
  AIOPS_RETRY_INITIAL_MS: positiveInt(1_000),
  AIOPS_RETRY_MAX_MS: positiveInt(30_000),
  AIOPS_SMTP_URL: smtpUrl.optional(),
  AIOPS_MAIL_FROM: mailAddress.default('aiops@localhost'),
  AIOPS_PUBLIC_URL: originUrl.default('http://localhost:8400'),
  AIOPS_AUDIT_ARCHIVE_DIR: z.string().startsWith('/', { message: 'must be an absolute path' }).optional(),
}).superRefine((e, ctx) => {
  // Cross-field checks run only once every field parsed; the messages name variables, never values (SEC-3).
  if (e.AIOPS_RETRY_INITIAL_MS > e.AIOPS_RETRY_MAX_MS) {
    ctx.addIssue({ code: 'custom', path: ['AIOPS_RETRY_INITIAL_MS'], message: 'must not exceed AIOPS_RETRY_MAX_MS' });
  }
  // A preparation ceiling within the heartbeat timeout would end a healthy preparation first.
  if (e.AIOPS_PREPARE_TIMEOUT_MS <= PREPARE_HEARTBEAT_MS) {
    ctx.addIssue({
      code: 'custom',
      path: ['AIOPS_PREPARE_TIMEOUT_MS'],
      message: `must be greater than ${String(PREPARE_HEARTBEAT_MS)} (the preparation heartbeat timeout)`,
    });
  }
  // A shorter one could time a healthy batch out between two status polls, and its retry would resubmit.
  if (e.AIOPS_BATCH_HEARTBEAT_MS <= MIN_BATCH_HEARTBEAT_MS) {
    ctx.addIssue({
      code: 'custom',
      path: ['AIOPS_BATCH_HEARTBEAT_MS'],
      message: `must be greater than ${String(MIN_BATCH_HEARTBEAT_MS)} (the longest status poll pause plus a margin)`,
    });
  }
  // A heartbeat timeout at or above the start-to-close timeout would never notice a lost worker first.
  if (e.AIOPS_BATCH_HEARTBEAT_MS >= e.AIOPS_BATCH_TIMEOUT_MS) {
    ctx.addIssue({ code: 'custom', path: ['AIOPS_BATCH_HEARTBEAT_MS'], message: 'must be less than AIOPS_BATCH_TIMEOUT_MS' });
  }
});

function parse<S extends z.ZodType>(schema: S, env: NodeJS.ProcessEnv): z.output<S> {
  const result = schema.safeParse(env);
  if (result.success) return result.data;
  // Zod messages for enums and coercions can quote the received value; report only
  // the variable name and a value-free reason.
  throw new EnvError(
    result.error.issues.map((issue) => {
      const variable = String(issue.path[0] ?? '(root)');
      // Zod 4 leaves `issue.input` unset for most issue codes, so "required" is decided by the
      // variable's presence in the environment.
      const reason = issue.code === 'custom' ? issue.message : env[variable] === undefined ? 'is required' : `invalid (${issue.code})`;
      return { variable, reason };
    }),
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
    ...(e.AIOPS_WIDGET_DIR === undefined ? {} : { widgetDir: e.AIOPS_WIDGET_DIR }),
    presetDirs: e.AIOPS_PRESET_DIRS,
    temporalAddress: e.TEMPORAL_ADDRESS,
    temporalNamespace: e.TEMPORAL_NAMESPACE,
    taskQueue: e.TEMPORAL_TASK_QUEUE,
    temporalKeys: e.AIOPS_TEMPORAL_KEYS,
    prepareWaitMs: e.AIOPS_PREPARE_WAIT_MS,
    ...(e.AIOPS_AUDIT_ARCHIVE_DIR === undefined ? {} : { auditArchiveDir: e.AIOPS_AUDIT_ARCHIVE_DIR }),
  };
}

export function parseWorkerEnv(env: NodeJS.ProcessEnv): WorkerEnv {
  const e = parse(workerSchema, env);
  return {
    temporalAddress: e.TEMPORAL_ADDRESS,
    temporalNamespace: e.TEMPORAL_NAMESPACE,
    taskQueue: e.TEMPORAL_TASK_QUEUE,
    logLevel: e.LOG_LEVEL,
    databaseUrl: e.DATABASE_URL,
    configDir: e.AIOPS_CONFIG_DIR,
    presetDirs: e.AIOPS_PRESET_DIRS,
    masterKeys: e.AIOPS_MASTER_KEYS,
    temporalKeys: e.AIOPS_TEMPORAL_KEYS,
    activityTuning: {
      prepareTimeoutMs: e.AIOPS_PREPARE_TIMEOUT_MS,
      batchHeartbeatMs: e.AIOPS_BATCH_HEARTBEAT_MS,
      batchTimeoutMs: e.AIOPS_BATCH_TIMEOUT_MS,
      batchMaxAttempts: e.AIOPS_BATCH_MAX_ATTEMPTS,
      retryInitialMs: e.AIOPS_RETRY_INITIAL_MS,
      retryMaxMs: e.AIOPS_RETRY_MAX_MS,
    },
    ...(e.AIOPS_SMTP_URL === undefined ? {} : { smtpUrl: e.AIOPS_SMTP_URL }),
    mailFrom: e.AIOPS_MAIL_FROM,
    publicUrl: new URL(e.AIOPS_PUBLIC_URL),
    ...(e.AIOPS_AUDIT_ARCHIVE_DIR === undefined ? {} : { auditArchiveDir: e.AIOPS_AUDIT_ARCHIVE_DIR }),
  };
}
