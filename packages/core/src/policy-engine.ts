// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Mandate Authors
import type { Caller } from './caller.js';
import type { GrantDefinition, OperationDefinition, PolicyConfiguration, ScopeValue } from './policy-model.js';
import { rolesOf } from './roles.js';

export type DenyReason =
  | 'no_grant'
  | 'unknown_tool'
  | 'scope_argument_missing'
  | 'out_of_scope'
  | 'denied_field'
  | 'field_not_allowed'
  | 'limit_exceeded';

/**
 * The outcome of one evaluation. `rule` names what produced it (POL-8):
 * `role:<role>/grant:<id|index>[/scope:<arg>|/deny_fields|/allow_fields]`,
 * `default-deny` or `builtin`. `detail` carries argument or field names only,
 * never argument values.
 */
export interface PolicyDecision {
  readonly effect: 'allow' | 'deny';
  readonly rule: string;
  readonly reason?: DenyReason;
  readonly detail?: string;
  readonly roles: readonly string[];
}

export interface EvaluationRequest {
  readonly caller: Caller;
  readonly operationId: string;
  readonly args: Readonly<Record<string, unknown>>;
}

/**
 * Authorization behind one interface (SPEC section 3). Implementations are pure:
 * no I/O, no side effects, evaluated from in-memory configuration (NFR-6).
 */
export interface PolicyEngine {
  /** Operations with at least one grant in the caller's roles, in configuration order (MCP-2). */
  grantedOperations(caller: Caller): readonly OperationDefinition[];
  /** The decision for one call (POL-1, POL-2, POL-3). Also the dry entry point (POL-7). */
  evaluate(request: EvaluationRequest): PolicyDecision;
}

interface IndexedGrant {
  readonly ref: string;
  readonly grant: GrantDefinition;
}

type Check = { readonly ok: true } | { readonly ok: false; readonly suffix: string; readonly reason: DenyReason; readonly detail: string };

const PASS: Check = { ok: true };

function isScalar(value: unknown): value is ScopeValue {
  return typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean';
}

function checkScope(grant: GrantDefinition, args: Readonly<Record<string, unknown>>): Check {
  for (const [arg, allowed] of Object.entries(grant.scope)) {
    const fail = (reason: DenyReason): Check => ({ ok: false, suffix: `/scope:${arg}`, reason, detail: arg });
    if (!Object.hasOwn(args, arg) || args[arg] === undefined) return fail('scope_argument_missing');
    const value = args[arg];
    const values: readonly unknown[] = Array.isArray(value) ? value : [value];
    if (values.length === 0) return fail('out_of_scope');
    if (!values.every((v) => isScalar(v) && allowed.includes(v))) return fail('out_of_scope');
  }
  return PASS;
}

/** Fields the call touches, or `unreadable` when the argument is neither an object nor an array of strings. */
export function touchedFields(fieldsArg: string | undefined, args: Readonly<Record<string, unknown>>): readonly string[] | 'unreadable' {
  if (fieldsArg === undefined) return [];
  const value = args[fieldsArg];
  if (value === undefined || value === null) return [];
  if (Array.isArray(value)) return value.every((v) => typeof v === 'string') ? value : 'unreadable';
  if (typeof value === 'object') return Object.keys(value);
  return 'unreadable';
}

function checkFields(grant: GrantDefinition, fields: readonly string[] | 'unreadable', fieldsArg: string | undefined): Check {
  if (fields === 'unreadable') {
    // Fail closed (POL-3): a grant that restricts fields cannot pass a call whose fields it cannot read.
    if (grant.denyFields.length > 0) return { ok: false, suffix: '/deny_fields', reason: 'denied_field', detail: fieldsArg ?? '' };
    if (grant.allowFields !== undefined) return { ok: false, suffix: '/allow_fields', reason: 'field_not_allowed', detail: fieldsArg ?? '' };
    return PASS;
  }
  const denied = fields.find((f) => grant.denyFields.includes(f));
  if (denied !== undefined) return { ok: false, suffix: '/deny_fields', reason: 'denied_field', detail: denied };
  const allow = grant.allowFields;
  if (allow !== undefined) {
    const outside = fields.find((f) => !allow.includes(f));
    if (outside !== undefined) return { ok: false, suffix: '/allow_fields', reason: 'field_not_allowed', detail: outside };
  }
  return PASS;
}

/**
 * The reference of a grant in a decision rule, `role:<role>/grant:<id|index>` (POL-5). The loader
 * keys a grant's approval rule by it, so both sides use this one function.
 */
export function grantReference(roleId: string, grantId: string | undefined, index: number): string {
  return `role:${roleId}/grant:${grantId ?? String(index)}`;
}

/** Builds the in-memory index once per configuration; every call after that is pure lookup. */
export function createPolicyEngine(config: PolicyConfiguration): PolicyEngine {
  const operations = new Map(config.operations.map((o) => [o.id, o] as const));
  // role -> operation -> grants, in configuration order.
  const grants = new Map<string, Map<string, IndexedGrant[]>>();
  for (const role of config.roles) {
    const byOperation = new Map<string, IndexedGrant[]>();
    role.grants.forEach((grant, index) => {
      const list = byOperation.get(grant.operation) ?? [];
      list.push({ ref: grantReference(role.id, grant.id, index), grant });
      byOperation.set(grant.operation, list);
    });
    grants.set(role.id, byOperation);
  }

  const rolesFor = (caller: Caller): readonly string[] => rolesOf(caller, config);

  return {
    grantedOperations(caller) {
      const roles = rolesFor(caller);
      return config.operations.filter((op) => roles.some((r) => grants.get(r)?.has(op.id) === true));
    },

    evaluate({ caller, operationId, args }) {
      const roles = rolesFor(caller);
      const operation = operations.get(operationId);
      const matching = operation === undefined ? [] : roles.flatMap((r) => grants.get(r)?.get(operationId) ?? []);
      if (operation === undefined || matching.length === 0) {
        return { effect: 'deny', rule: 'default-deny', reason: 'no_grant', roles };
      }
      const fields = touchedFields(operation.fieldsArg, args);
      let firstFailure: { ref: string; check: Extract<Check, { ok: false }> } | undefined;
      for (const { ref, grant } of matching) {
        const scope = checkScope(grant, args);
        const check = scope.ok ? checkFields(grant, fields, operation.fieldsArg) : scope;
        if (check.ok) return { effect: 'allow', rule: ref, roles };
        firstFailure ??= { ref, check };
      }
      // `matching` is non-empty and every grant failed, so a failure was recorded.
      const failure = firstFailure as { ref: string; check: Extract<Check, { ok: false }> };
      return {
        effect: 'deny',
        rule: `${failure.ref}${failure.check.suffix}`,
        reason: failure.check.reason,
        detail: failure.check.detail,
        roles,
      };
    },
  };
}
