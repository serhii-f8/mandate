// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Mandate Authors
/**
 * File arguments of an operation and the global file settings (OPS-8, ADR 0075): the Zod
 * schemas, the conversion into the core model and the rules the registry applies.
 */
import { z } from 'zod';
import { DEFAULT_FILE_SETTINGS, HARD_MAX_FILE_BYTES, type FileArgument, type FileSettings } from '@mandate/core';

const SEGMENT = '[A-Za-z_][A-Za-z0-9_]{0,63}';
/** `/a/b/c`: 1 to 8 property names; no index, no `~` escape. */
const FILE_AT = new RegExp(`^/${SEGMENT}(/${SEGMENT}){0,7}$`);
const MEDIA_TYPE = /^[a-z0-9][a-z0-9!#$&^_.+-]{0,62}\/[a-z0-9][a-z0-9!#$&^_.+-]{0,62}$/;
const PART = /^[A-Za-z0-9_.-]{1,64}$/;

const fileArgumentSchema = z.strictObject({
  at: z.string().regex(FILE_AT),
  send: z.enum(['base64', 'multipart']),
  media_types: z.array(z.string().regex(MEDIA_TYPE)).min(1).max(20),
  max_bytes: z.number().int().min(1).max(HARD_MAX_FILE_BYTES).optional(),
  part: z.string().regex(PART).optional(),
});

/** OPS-8: one to five file arguments of an operation. */
export const fileArgumentsSchema = z.array(fileArgumentSchema).min(1).max(5);

/** OPS-8: the global staging settings; at most one document may set them. */
export const fileSettingsSchema = z.strictObject({
  max_bytes: z.number().int().min(1).max(HARD_MAX_FILE_BYTES).optional(),
  staged_ttl_hours: z.number().int().min(1).max(720).optional(),
  keep_days: z.number().int().min(0).max(365).optional(),
  per_user_count: z.number().int().min(1).max(1000).optional(),
  per_user_bytes: z.number().int().min(1).max(10_737_418_240).optional(),
});

export type FileArgumentsConfig = z.output<typeof fileArgumentsSchema>;
export type FileSettingsConfig = z.output<typeof fileSettingsSchema>;

/** The effective settings: keys the document leaves out take the defaults. */
export function toFileSettings(config: FileSettingsConfig | undefined): FileSettings {
  return {
    maxBytes: config?.max_bytes ?? DEFAULT_FILE_SETTINGS.maxBytes,
    stagedTtlHours: config?.staged_ttl_hours ?? DEFAULT_FILE_SETTINGS.stagedTtlHours,
    keepDays: config?.keep_days ?? DEFAULT_FILE_SETTINGS.keepDays,
    perUserCount: config?.per_user_count ?? DEFAULT_FILE_SETTINGS.perUserCount,
    perUserBytes: config?.per_user_bytes ?? DEFAULT_FILE_SETTINGS.perUserBytes,
  };
}

/** The core model of an operation's file arguments; an entry without `max_bytes` takes `maxBytes`. */
export function toFileArguments(config: FileArgumentsConfig, maxBytes: number): FileArgument[] {
  return config.map((entry) => {
    const path = entry.at.slice(1).split('/');
    // A multipart file's part defaults to its argument name; the loader refuses a nested path for multipart.
    const part = entry.part ?? (entry.send === 'multipart' && path.length === 1 ? path[0] : undefined);
    return {
      pointer: entry.at,
      path,
      send: entry.send,
      mediaTypes: [...entry.media_types],
      maxBytes: entry.max_bytes ?? maxBytes,
      ...(part === undefined ? {} : { part }),
    };
  });
}

export interface FileArgumentInput {
  readonly files: FileArgumentsConfig;
  readonly inputSchema: Readonly<Record<string, unknown>> | undefined;
  /** True when the operation declares its own `input_schema`. */
  readonly explicitSchema: boolean;
  /** `write_opaque`, or `destructive` without a manifest. */
  readonly opaque: boolean;
  readonly binding: 'http' | 'mcp' | 'code';
  /** The global `files.max_bytes`. */
  readonly maxBytes: number;
}

export interface FileIssue {
  /** Relative to the operation. */
  readonly path: PropertyKey[];
  readonly message: string;
}

const LEAF_KEYS = new Set(['type', 'format', 'title', 'description']);
const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);

/** True when `path` names a required string property with format uuid, every parent a required object. */
function namesRequiredUuid(schema: Readonly<Record<string, unknown>>, path: readonly string[]): boolean {
  let current: Record<string, unknown> = schema;
  for (const [index, name] of path.entries()) {
    const required = current.required;
    const properties = current.properties;
    if (current.type !== 'object' || !Array.isArray(required) || !required.includes(name) || !isRecord(properties)) return false;
    const next = Object.hasOwn(properties, name) ? properties[name] : undefined;
    if (!isRecord(next)) return false;
    current = next;
    if (index === path.length - 1) {
      return current.type === 'string' && current.format === 'uuid' && Object.keys(current).every((key) => LEAF_KEYS.has(key));
    }
  }
  return false;
}

const isMultipart = (send: FileArgument['send']): boolean => send === 'multipart';
const overlaps = (a: string, b: string): boolean => a === b || a.startsWith(`${b}/`) || b.startsWith(`${a}/`);

/** The issues of one operation's `files` (OPS-8), at paths relative to the operation. */
export function fileArgumentIssues(input: FileArgumentInput): FileIssue[] {
  if (!input.opaque || input.binding !== 'http') return [{ path: ['files'], message: 'is allowed only on an opaque operation with an HTTP binding' }];
  const issues: FileIssue[] = [];
  const schema = input.explicitSchema ? input.inputSchema : undefined;
  if (schema === undefined) issues.push({ path: ['input_schema'], message: 'is required for an operation with files' });
  input.files.forEach((entry, index) => {
    const at = ['files', index, 'at'];
    if (input.files.slice(0, index).some((earlier) => overlaps(earlier.at, entry.at))) {
      issues.push({ path: at, message: 'must not repeat or extend another file path' });
    }
    if (schema !== undefined && !namesRequiredUuid(schema, entry.at.slice(1).split('/'))) {
      issues.push({ path: at, message: 'must name a required string property with format uuid' });
    }
    if (entry.max_bytes !== undefined && entry.max_bytes > input.maxBytes) {
      issues.push({ path: ['files', index, 'max_bytes'], message: 'must not exceed files.max_bytes' });
    }
    const first = input.files[0];
    if (first !== undefined && index > 0 && entry.send !== first.send) {
      issues.push({ path: ['files', index, 'send'], message: 'must be the same for every file of the operation' });
    }
    if (isMultipart(entry.send)) {
      const segments = entry.at.slice(1).split('/');
      if (segments.length > 1) issues.push({ path: at, message: 'must be a top-level argument with send: multipart' });
      const part = entry.part ?? segments[0];
      const taken = input.files.slice(0, index).some((earlier) => isMultipart(earlier.send) && (earlier.part ?? earlier.at.slice(1).split('/')[0]) === part);
      if (taken && segments.length === 1) issues.push({ path: ['files', index, 'part'], message: 'is already used by another file' });
    }
    if (entry.part !== undefined && !isMultipart(entry.send)) {
      issues.push({ path: ['files', index, 'part'], message: 'is allowed only with send: multipart' });
    }
  });
  return issues;
}
