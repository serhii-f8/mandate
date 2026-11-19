/**
 * The policy model (SPEC section 4: Operation, Role, Grant), as `@aiops/config`
 * produces it from validated YAML. Plain immutable data, no behaviour.
 */

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
}

export type RollbackStrategy =
  | { readonly strategy: 'replay_previous_state' | 'none' }
  | { readonly strategy: 'inverse_operation'; readonly operation: string };

export type ManifestTemplate = string | number | boolean | { readonly arg: string; readonly default?: string | number | boolean };

export interface ManifestRead {
  readonly operation: string;
  readonly args: Readonly<Record<string, ManifestTemplate>>;
}

export interface ManifestDefinition {
  readonly idField: string;
  readonly idsArg?: string;
  readonly valuesArg: string;
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

export interface PolicyConfiguration {
  readonly operations: readonly OperationDefinition[];
  readonly roles: readonly RoleDefinition[];
  readonly roleMapping: readonly RoleMappingEntry[];
}
