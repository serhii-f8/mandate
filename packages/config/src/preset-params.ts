// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Mandate Authors
/**
 * Preset parameters (CONN-8, ADR 0067): a preset declares `params` with typed defaults, a
 * connection binding it may set `preset_params`, and every mapping `{ $param: <name> }` inside
 * the preset's `operations` and `test` is replaced by the binding's value before the operation
 * schema applies. Values are data: they are type-checked without coercion, and substitution
 * walks the preset's own nodes only, never a substituted value.
 */
import { z } from 'zod';

export type PresetParamValue = string | number | boolean | readonly string[];
export type PresetParamType = 'string' | 'number' | 'boolean' | 'string_list';
export interface PresetParamDecl {
  readonly type: PresetParamType;
  readonly default: PresetParamValue;
  /** `| undefined`: the Zod output of an absent optional key (exactOptionalPropertyTypes). */
  readonly description?: string | undefined;
}

export const MAX_PRESET_PARAMS = 50;
export const MAX_PARAM_STRING = 4000;
export const MAX_PARAM_LIST = 500;
export const PRESET_PARAM_NAME = /^[a-z][a-z0-9_]{0,63}$/;

const paramString = z.string().max(MAX_PARAM_STRING);
const paramList = z.array(paramString).max(MAX_PARAM_LIST);
/** A parameter value as YAML can give it; the declared type is checked by `resolveParamValues`. */
export const presetParamValueSchema = z.union([paramString, z.number(), z.boolean(), paramList]);

const description = z.string().min(1).max(2000).optional();
const declSchema = z.discriminatedUnion('type', [
  z.strictObject({ type: z.literal('string'), default: paramString, description }),
  z.strictObject({ type: z.literal('number'), default: z.number(), description }),
  z.strictObject({ type: z.literal('boolean'), default: z.boolean(), description }),
  z.strictObject({ type: z.literal('string_list'), default: paramList, description }),
]);

/** `params` of a preset file: name → type, default and description. */
export const presetParamsSchema = z.record(z.string().regex(PRESET_PARAM_NAME), declSchema).superRefine((params, ctx) => {
  if (Object.keys(params).length > MAX_PRESET_PARAMS) ctx.addIssue({ code: 'custom', message: `must have at most ${String(MAX_PRESET_PARAMS)} entries` });
});

/** `preset_params` of a connection: name → value. */
export const presetParamValuesSchema = z.record(z.string().regex(PRESET_PARAM_NAME), presetParamValueSchema).superRefine((params, ctx) => {
  if (Object.keys(params).length > MAX_PRESET_PARAMS) ctx.addIssue({ code: 'custom', message: `must have at most ${String(MAX_PRESET_PARAMS)} entries` });
});

export interface ParamIssue {
  readonly path: readonly PropertyKey[];
  readonly message: string;
}

/** Why `value` is not of `type`, or undefined when it is. Never coerces. */
function typeIssue(type: PresetParamType, value: unknown): string | undefined {
  switch (type) {
    case 'string':
      if (typeof value !== 'string') return 'must be a string';
      return value.length > MAX_PARAM_STRING ? `must be at most ${String(MAX_PARAM_STRING)} characters` : undefined;
    case 'number':
      return typeof value === 'number' && Number.isFinite(value) ? undefined : 'must be a number';
    case 'boolean':
      return typeof value === 'boolean' ? undefined : 'must be a boolean';
    case 'string_list':
      if (!Array.isArray(value) || !value.every((v): v is string => typeof v === 'string')) return 'must be a string_list';
      if (value.length > MAX_PARAM_LIST) return `must have at most ${String(MAX_PARAM_LIST)} items`;
      return value.some((v) => v.length > MAX_PARAM_STRING) ? `must be at most ${String(MAX_PARAM_STRING)} characters` : undefined;
  }
}

/** A frozen copy, so no binding shares a list with another or with the declaration. */
const copyValue = (value: PresetParamValue): PresetParamValue => (typeof value === 'object' ? Object.freeze([...value]) : value);

/**
 * The values of one binding: the given ones, checked against their declarations, and the
 * defaults for the rest. Unknown names and wrong types are issues at the name.
 */
export function resolveParamValues(
  decls: Readonly<Record<string, PresetParamDecl>>,
  given: Readonly<Record<string, unknown>> | undefined,
): { ok: true; values: Readonly<Record<string, PresetParamValue>> } | { ok: false; issues: ParamIssue[] } {
  const issues: ParamIssue[] = [];
  const values: Record<string, PresetParamValue> = {};
  for (const [name, value] of Object.entries(given ?? {})) {
    const decl = Object.hasOwn(decls, name) ? decls[name] : undefined;
    if (decl === undefined) {
      issues.push({ path: [name], message: 'is not a parameter of the preset' });
      continue;
    }
    const issue = typeIssue(decl.type, value);
    if (issue !== undefined) issues.push({ path: [name], message: issue });
    // typeIssue accepted the value as the declared type.
    else values[name] = copyValue(value as PresetParamValue);
  }
  if (issues.length > 0) return { ok: false, issues };
  for (const [name, decl] of Object.entries(decls)) {
    if (!Object.hasOwn(values, name)) values[name] = copyValue(decl.default);
  }
  return { ok: true, values: Object.freeze(values) };
}

/** True for a `{ $param: <name> }` mapping: its only key, a string name. */
export function isParamNode(node: object): node is { $param: string } {
  const keys = Object.keys(node);
  return keys.length === 1 && keys[0] === '$param' && typeof (node as { $param: unknown }).$param === 'string';
}

/**
 * A deep copy of `node` with every mapping `{ $param: <name> }` (its only key, a string name)
 * replaced by a copy of the value. A list value stays one element of a list (no splicing). The
 * walk covers the preset's own nodes only: a substituted value is never searched for `$param`.
 */
export function substituteParams(node: unknown, values: Readonly<Record<string, PresetParamValue>>): { ok: true; value: unknown } | { ok: false; unknown: string[] } {
  const unknown = new Set<string>();
  const walk = (n: unknown): unknown => {
    if (Array.isArray(n)) return n.map(walk);
    if (typeof n !== 'object' || n === null) return n;
    if (isParamNode(n)) {
      const name = n.$param;
      const value = Object.hasOwn(values, name) ? values[name] : undefined;
      if (value === undefined) {
        unknown.add(name);
        return n;
      }
      // A JSON copy: the value is data and is not walked; no reference is shared with `values`.
      return structuredClone(value);
    }
    return Object.fromEntries(Object.entries(n).map(([key, child]) => [key, walk(child)]));
  };
  const value = walk(node);
  return unknown.size > 0 ? { ok: false, unknown: [...unknown] } : { ok: true, value };
}
