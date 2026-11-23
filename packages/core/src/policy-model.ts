// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Mandate Authors
/**
 * The policy model (SPEC section 4: Operation, Role, Grant), as `@mandate/config`
 * produces it from validated YAML. Plain immutable data, no behaviour.
 */
import type { FileArgument } from './files/model.js';

/** SPEC section 4, "Operation risk classes". */
export type RiskClass = 'read' | 'write' | 'write_opaque' | 'destructive';

/** A value a scope constraint allows for one argument (POL-2). Compared strictly. */
export type ScopeValue = string | number | boolean;

export interface OperationDefinition {
  readonly id: string;
  /** The MCP tool name. */
  readonly toolName: string;
  /** Where the operation came from: `config` or `preset:<id>`. */
  readonly source: string;
  readonly connection: string;
  readonly risk: RiskClass;
  readonly title?: string;
  readonly description: string;
  /** JSON Schema (2020-12) of the call arguments, root `type: object` (MCP-3). */
  readonly inputSchema: Readonly<Record<string, unknown>>;
  /** Argument naming the fields a call touches: object keys or string elements (POL-3). */
  readonly fieldsArg?: string;
  /** Present on write operations that prepare change-sets (CS-1). */
  readonly manifest?: ManifestDefinition;
  /** OPS-8: declared file arguments of an opaque operation; absent means none. */
  readonly files?: readonly FileArgument[];
}

export type RollbackStrategy =
  | { readonly strategy: 'replay_previous_state' | 'none' }
  | { readonly strategy: 'inverse_operation'; readonly operation: string };

export type ManifestTemplate = string | number | boolean | { readonly arg: string; readonly default?: string | number | boolean };

export interface ManifestRead {
  readonly operation: string;
  readonly args: Readonly<Record<string, ManifestTemplate>>;
}

/** What a manifest operation does to its targets (OPS-2, CS-4); absent on a manifest means `update`. */
export type ManifestAction = 'update' | 'create' | 'delete';

/** A literal a preparation check compares against (CS-3). */
export type CheckLiteral = string | number | boolean | null;

/**
 * What a check predicate reads (CS-3, ADR 0072): a field of the item's `after` or `before` side, of
 * the current upstream record, a call argument, or a field of a lookup result (OPS-7).
 */
export type CheckRef =
  | { readonly after: string }
  | { readonly before: string }
  | { readonly record: string }
  | { readonly arg: string }
  | { readonly lookup: string; readonly field: string };

/** One predicate of the closed set (CS-3); no expressions. */
export type CheckPredicate =
  | { readonly present: CheckRef }
  | { readonly absent: CheckRef }
  | { readonly equals: readonly [CheckRef, CheckRef | { readonly value: CheckLiteral }] }
  | { readonly in: CheckRef; readonly values: readonly Exclude<CheckLiteral, null>[] }
  | { readonly found: string }
  | { readonly not_found: string };

/** A preparation check: an item failing one of `require` is excluded with reason `code` (CS-3). */
export interface ManifestCheck {
  readonly code: string;
  /** Plain text from configuration, shown beside the code. */
  readonly title?: string;
  readonly require: readonly CheckPredicate[];
}

/**
 * What a lookup is keyed by for one item (OPS-7): the target ID, a field of the item's `after` or
 * `before` side, or a field of the current upstream record.
 */
export type ManifestLookupKey =
  | { readonly target: true }
  | { readonly after: string }
  | { readonly before: string }
  | { readonly record: string };

/**
 * A read of an enabled read operation on any connection, keyed per item, whose results feed the
 * preparation checks (OPS-7, ADR 0072). Its values are used by checks only, never stored (SEC-3).
 */
export interface ManifestLookup {
  readonly operation: string;
  /** The read operation's argument that takes the keys. */
  readonly idsArg: string;
  /** The result field the keys are matched against. */
  readonly keyField: string;
  readonly key: ManifestLookupKey;
  /** The result fields the checks may read; requested with `keyField`. */
  readonly fields: readonly string[];
  readonly args: Readonly<Record<string, ManifestTemplate>>;
}

/**
 * The verify-after stage (EXE-12, ADR 0073): after the last batch, look again at the written items
 * on a schedule until every check holds or the timeout passes. Its lookups are its own namespace;
 * `{ record }` means the record as read at the look, through `read_before`.
 */
export interface ManifestVerifyAfter {
  /** Wait before the first look, from the end of the last batch. */
  readonly afterSeconds: number;
  /** Wait between looks. */
  readonly everySeconds: number;
  /** From the end of the last batch: still-pending items then end `unconfirmed`. */
  readonly timeoutSeconds: number;
  /** Evaluated in order on each pending item; all hold means confirmed. */
  readonly checks: readonly ManifestCheck[];
  /** Lookups by name that the verify checks read; absent means none. */
  readonly lookups?: Readonly<Record<string, ManifestLookup>>;
}

export interface ManifestDefinition {
  /** Absent means `update`. Sealed into the change-set hash from version 2 on (CS-4). */
  readonly action?: ManifestAction;
  /** The verify-after stage (EXE-12, ADR 0073); absent means none. Not part of the hash. */
  readonly verifyAfter?: ManifestVerifyAfter;
  /** Preparation checks in order (CS-3, ADR 0072); absent means none. */
  readonly checks?: readonly ManifestCheck[];
  /** Lookups by name that the checks read (OPS-7, ADR 0072); absent means none. */
  readonly lookups?: Readonly<Record<string, ManifestLookup>>;
  readonly idField: string;
  readonly idsArg?: string;
  /** Argument holding one values object for every target (CS-2). The alternative to `recordsArg`. */
  readonly valuesArg?: string;
  /**
   * Argument holding an array of records, each with `idField` and its own values (CS-2, ADR 0070).
   * The records name the targets: no `idsArg` and no `selector` with it.
   */
  readonly recordsArg?: string;
  readonly fields: readonly string[];
  readonly requiredFields: readonly string[];
  /** Call argument name to record field. */
  readonly scopeArgs: Readonly<Record<string, string>>;
  readonly readBefore: ManifestRead & { readonly idsArg: string };
  readonly selector?: ManifestRead & { readonly pageArg: string; readonly pageSizeArg: string; readonly pageSize: number };
  /** Bulk writes (OPS-6): record fields carried over from the read-before value. */
  readonly write?: { readonly carryFields: readonly string[] };
  readonly batchSize: number;
  readonly maxTargets: number;
  readonly rollback: RollbackStrategy;
}

/** A catalogue entry the operator has not enabled (visible to admins only). */
export interface DisabledOperation {
  readonly key: string;
  readonly connection: string;
  readonly method: string;
  readonly path: string;
  readonly operationId?: string;
  readonly summary?: string;
  /** CONN-1: the upstream tool of an MCP-backed entry (`method` is then `MCP`, `path` the tool name). */
  readonly tool?: string;
  /** CONN-4: the live tool hash, when the tool was listed. */
  readonly hash?: string;
}

export interface GrantDefinition {
  readonly operation: string;
  /** Optional stable name used in rule references instead of the index. */
  readonly id?: string;
  /** Argument name → allowed values (POL-2). */
  readonly scope: Readonly<Record<string, readonly ScopeValue[]>>;
  readonly denyFields: readonly string[];
  /** When set, a call may touch only these fields (POL-3). */
  readonly allowFields?: readonly string[];
}

export interface RoleDefinition {
  readonly id: string;
  readonly description?: string;
  readonly grants: readonly GrantDefinition[];
}

/** One identity-provider group mapped to roles (AUTH-3). */
export interface RoleMappingEntry {
  readonly group: string;
  readonly roles: readonly string[];
}

/** One OAuth client acting as a service account, holding exactly one role (AUTH-4). */
export interface ServiceAccountEntry {
  readonly clientId: string;
  readonly role: string;
}

export interface PolicyConfiguration {
  readonly operations: readonly OperationDefinition[];
  readonly roles: readonly RoleDefinition[];
  readonly roleMapping: readonly RoleMappingEntry[];
  /** Configured service accounts (AUTH-4); absent means none. */
  readonly serviceAccounts?: readonly ServiceAccountEntry[];
}
