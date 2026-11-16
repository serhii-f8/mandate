/**
 * Schema of one configuration document (CFG-1, ADR 0015). Every object is strict:
 * an unknown key is an error, so typos and pasted secrets do not pass silently.
 * `upstream` (adapter-specific until Phase 3) and `input_schema` (checked by Ajv)
 * are the only open objects.
 */
import { z } from 'zod';

const id = z.string().regex(/^[a-z][a-z0-9_-]{0,62}$/);
/** Operation IDs are also MCP tool names. */
export const OPERATION_ID = /^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)*$/;
const operationId = z.string().max(64).regex(OPERATION_ID);
const credentialRef = id;
const httpUrl = z.url({ protocol: /^https?$/ });
const openObject = z.record(z.string(), z.unknown());
const positiveInt = z.number().int().positive();

const connectionBase = { id, credential_ref: credentialRef.optional(), preset: id.optional() };
const connection = z.discriminatedUnion('adapter', [
  z.strictObject({ ...connectionBase, adapter: z.literal('openapi'), base_url: httpUrl }),
  z.strictObject({ ...connectionBase, adapter: z.literal('mcp'), mcp_url: httpUrl }),
]);

const operation = z.strictObject({
  id: operationId,
  connection: id,
  risk: z.enum(['read', 'write', 'write_opaque', 'destructive']),
  title: z.string().min(1).max(200).optional(),
  description: z.string().min(1).max(2000),
  upstream: openObject,
  input_schema: openObject,
  fields_arg: z.string().min(1).max(128).optional(),
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
  approver_role: id.optional(),
  allow_widget: z.boolean().default(false),
});

const role = z.strictObject({
  id,
  description: z.string().max(2000).optional(),
  grants: z.array(grant),
  limits: limits.optional(),
  approval: approval.optional(),
});

const roleMapping = z.strictObject({ group: z.string().min(1).max(255), roles: z.array(id).min(1) });

const preset = z.strictObject({ id, package: z.string().min(1).max(214), version: z.string().min(1).max(64).optional() });

const notification = z.discriminatedUnion('kind', [
  z.strictObject({ id, kind: z.literal('email'), to: z.array(z.email()).min(1) }),
  z.strictObject({ id, kind: z.literal('webhook'), url_credential_ref: credentialRef }),
]);

export const configDocumentSchema = z.strictObject({
  version: z.literal(1),
  connections: z.array(connection).optional(),
  operations: z.array(operation).optional(),
  roles: z.array(role).optional(),
  role_mapping: z.array(roleMapping).optional(),
  presets: z.array(preset).optional(),
  notifications: z.array(notification).optional(),
});

export type ConfigDocument = z.output<typeof configDocumentSchema>;
export type ConnectionConfig = z.output<typeof connection>;
export type OperationConfig = z.output<typeof operation>;
export type RoleConfig = z.output<typeof role>;
export type RoleLimits = z.output<typeof limits>;
export type RoleApproval = z.output<typeof approval>;
export type PresetConfig = z.output<typeof preset>;
export type NotificationConfig = z.output<typeof notification>;

export interface SchemaIssue {
  readonly path: readonly PropertyKey[];
  readonly message: string;
}

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
