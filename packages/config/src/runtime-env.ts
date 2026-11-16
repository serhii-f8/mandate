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

const apiSchema = z.object({
  DATABASE_URL: postgresUrl,
  API_PORT: port(8080),
  API_ALLOWED_HOSTS: z
    .string()
    .default('localhost,127.0.0.1')
    .transform((v) => v.split(',').map((h) => h.trim()).filter((h) => h.length > 0))
    .refine((hosts) => hosts.length > 0, { message: 'must list at least one host' }),
  LOG_LEVEL: logLevel,
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
  return { databaseUrl: e.DATABASE_URL, port: e.API_PORT, allowedHosts: e.API_ALLOWED_HOSTS, logLevel: e.LOG_LEVEL };
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
