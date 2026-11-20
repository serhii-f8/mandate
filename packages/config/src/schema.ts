/**
 * Schema of one configuration document (CFG-1, ADR 0015). Every object is strict:
 * an unknown key is an error, so typos and pasted secrets do not pass silently.
 * `input_schema` (checked by Ajv) and connection test `args` are the only open
 * objects; `upstream` is strict since Phase 3 (ADR 0017).
 */
import { z } from 'zod';
import {
  connectionSettingsFields,
  httpUrl,
  id,
  openApiSchema,
  openObject,
  operationId,
  OPERATION_ID,
  operationUpstreamSchema,
} from './upstream-schema.js';
import { changesetsSchema, manifestSchema } from './manifest.js';

export { OPERATION_ID };
const credentialRef = id;
const positiveInt = z.number().int().positive();

const connectionBase = {
  id,
  credential_ref: credentialRef.optional(),
  preset: id.optional(),
  /** CONN-8: the preset's operation IDs `<ns>.<op>` become `<operation_prefix>.<op>` on this connection. */
  operation_prefix: z.string().regex(/^[a-z][a-z0-9_]{0,30}$/).optional(),
  ...connectionSettingsFields,
};
const connection = z.discriminatedUnion('adapter', [
  z.strictObject({ ...connectionBase, adapter: z.literal('openapi'), base_url: httpUrl, openapi: openApiSchema.optional() }),
  z.strictObject({
    ...connectionBase,
    adapter: z.literal('mcp'),
    mcp_url: httpUrl,
    /** CONN-4: seconds between checks of the pinned tools. */
    pin_check_seconds: z.number().int().min(10).max(86_400).default(300),
  }),
]);

const title = z.string().min(1).max(200);
const description = z.string().min(1).max(2000);
const operationFields = {
  id: operationId,
  risk: z.enum(['read', 'write', 'write_opaque', 'destructive']),
  title: title.optional(),
  description,
  /** HTTP mapping, or `{ tool, pin }` on an mcp connection (CONN-1). */
  upstream: operationUpstreamSchema,
  /** Absent: derived from the connection's spec (CONN-2). */
  input_schema: openObject.optional(),
  fields_arg: z.string().min(1).max(128).optional(),
  /** OPS-2: how a write operation's targets and after values are prepared. */
  manifest: manifestSchema.optional(),
};
const operation = z.strictObject({ ...operationFields, connection: id });
/** A preset operation: bound to the connection that applies the preset. */
export const presetOperationSchema = z.strictObject(operationFields);

/** MCP-9 and OPS-1: tool name, texts and enabling of an operation, applied after presets. */
const override = z.strictObject({
  operation: operationId,
  tool_name: operationId.optional(),
  title: title.optional(),
  description: description.optional(),
  enabled: z.boolean().optional(),
});

const scopeValue = z.union([z.string(), z.number(), z.boolean()]);
const grant = z.strictObject({
  operation: operationId,
  id: id.optional(),
  scope: z.record(z.string().min(1), z.array(scopeValue).min(1)).default({}),
  deny_fields: z.array(z.string().min(1)).default([]),
  allow_fields: z.array(z.string().min(1)).optional(),
});

const limits = z.strictObject({
  records_per_operation: positiveInt.optional(),
  records_per_day: positiveInt.optional(),
  calls_per_minute: positiveInt.optional(),
  concurrent_executions: positiveInt.optional(),
});

const approval = z.strictObject({
  required: z.enum(['always', 'never', 'above_threshold']).optional(),
  record_threshold: positiveInt.optional(),
  steps: z.array(z.strictObject({ role: id })).min(1).max(5).optional(),
  step_up_max_age_seconds: z.number().int().min(30).max(3600).optional(),
  allow_widget: z.boolean().default(false),
});

const role = z.strictObject({
  id,
  description: z.string().max(2000).optional(),
  grants: z.array(grant),
  limits: limits.optional(),
  approval: approval.optional(),
  /** Credential references the role may set and test on the trusted page; `*` for all. */
  manage_credentials: z.array(z.union([z.literal('*'), credentialRef])).optional(),
  /** SEC-1, AUD-6: may read the audit trail on the trusted page. */
  view_audit: z.boolean().default(false),
  /** NTF-1: notification IDs told when an approval step of this role becomes current, and of results. */
  notify: z.strictObject({ approval_requests: z.array(id).default([]), results: z.array(id).default([]) }).optional(),
});

const roleMapping = z.strictObject({ group: z.string().min(1).max(255), roles: z.array(id).min(1) });

/** SEC-10: requests per minute, a whole number from 1 to 100000. */
const rateLimit = z.number().int().min(1).max(100000);

/** SEC-10: effective endpoint rate limits (requests per minute). */
export interface RateLimits {
  readonly mcpUserPerMinute: number;
  readonly mcpServiceAccountPerMinute: number;
  readonly unauthenticatedPerMinute: number;
}

export const DEFAULT_RATE_LIMITS: RateLimits = { mcpUserPerMinute: 300, mcpServiceAccountPerMinute: 600, unauthenticatedPerMinute: 60 };

/** AUTH-4: an OAuth client (`azp`) that calls as a service account, with exactly one role. */
const serviceAccount = z.strictObject({
  client_id: z.string().min(1).max(255).regex(/^[^\p{Cc}]+$/u),
  role: id,
  description: z.string().max(500).optional(),
  /** SEC-10: overrides `rate_limits.mcp_service_account_per_minute` for this client. */
  rate_limit_per_minute: rateLimit.optional(),
});

const preset = z.strictObject({ id, package: z.string().min(1).max(214), version: z.string().min(1).max(64).optional() });

/** A lower-case host name or IPv4 address, without port (CONN-5). */
const HOST = /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)*$/;

const notification = z.discriminatedUnion('kind', [
  z.strictObject({ id, kind: z.literal('email'), to: z.array(z.email()).min(1) }),
  z.strictObject({
    id,
    kind: z.literal('webhook'),
    url_credential_ref: credentialRef,
    /** CONN-5: hosts the webhook URL may point to; the loader requires at least one. */
    allowed_hosts: z.array(z.string().max(253).regex(HOST)).optional(),
    allow_private_network: z.boolean().default(false),
  }),
]);

export const configDocumentSchema = z.strictObject({
  version: z.literal(1),
  connections: z.array(connection).optional(),
  operations: z.array(operation).optional(),
  roles: z.array(role).optional(),
  role_mapping: z.array(roleMapping).optional(),
  /** AUTH-4: collected across documents like role_mapping; a client_id appears once. */
  service_accounts: z.array(serviceAccount).optional(),
  presets: z.array(preset).optional(),
  notifications: z.array(notification).optional(),
  overrides: z.array(override).optional(),
  /** CS-6: at most one document may set it. */
  changesets: changesetsSchema.optional(),
  /** AUD-7: at most one document may set it; absent retention keeps the trail forever. */
  audit: z.strictObject({ retention_days: z.number().int().min(1).max(36500).optional() }).optional(),
  /** SEC-10: at most one document may set it; absent keys take DEFAULT_RATE_LIMITS. */
  rate_limits: z
    .strictObject({
      mcp_user_per_minute: rateLimit.optional(),
      mcp_service_account_per_minute: rateLimit.optional(),
      unauthenticated_per_minute: rateLimit.optional(),
    })
    .optional(),
});

export type ConfigDocument = z.output<typeof configDocumentSchema>;
export type ConnectionConfig = z.output<typeof connection>;
export type OperationConfig = z.output<typeof operation>;
export type RoleConfig = z.output<typeof role>;
export type RoleLimits = z.output<typeof limits>;
export type ServiceAccountConfig = z.output<typeof serviceAccount>;
export type RoleApproval = z.output<typeof approval>;
export type PresetConfig = z.output<typeof preset>;
export type PresetOperationConfig = z.output<typeof presetOperationSchema>;
export type OverrideConfig = z.output<typeof override>;
export type NotificationConfig = z.output<typeof notification>;

export interface SchemaIssue {
  readonly path: readonly PropertyKey[];
  readonly message: string;
}

/**
 * Parse parameters for configuration documents. Zod 4 leaves `input` out of issues
 * unless asked; `messageFor` needs it to tell a missing key from a wrong value. The
 * input never reaches a message: `schemaIssues` keeps only path and message.
 */
export const PARSE_PARAMS = { reportInput: true } as const;

/** Turns a Zod result into value-free issues: Zod's own messages can quote the input. */
export function schemaIssues(result: { success: true } | { success: false; error: z.ZodError }): SchemaIssue[] {
  if (result.success) return [];
  return result.error.issues.map((issue) => ({ path: issue.path, message: messageFor(issue) }));
}

function messageFor(issue: z.core.$ZodIssue): string {
  if ((issue.code === 'invalid_type' || issue.code === 'invalid_value') && issue.input === undefined) return 'is required';
  switch (issue.code) {
    case 'unrecognized_keys':
      return `unknown key${issue.keys.length > 1 ? 's' : ''}: ${issue.keys.join(', ')}`;
    case 'invalid_type':
      return issue.input === undefined ? 'is required' : `must be ${issue.expected}`;
    case 'invalid_value':
      return `must be one of: ${issue.values.map(String).join(', ')}`;
    case 'invalid_union':
      return 'does not match any allowed form';
    case 'invalid_format':
      return issue.format === 'regex' ? 'has an invalid format' : `must be a valid ${issue.format}`;
    case 'too_small':
      return `is too short or too small (minimum ${String(issue.minimum)})`;
    case 'too_big':
      return `is too long or too large (maximum ${String(issue.maximum)})`;
    case 'custom':
      return issue.message;
    default:
      return `is invalid (${issue.code})`;
  }
}
