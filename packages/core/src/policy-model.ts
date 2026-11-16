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
}

/** A catalogue entry the operator has not enabled (visible to admins only). */
export interface DisabledOperation {
  key: string;
  connection: string;
  method: string;
  path: string;
  operationId?: string;
  summary?: string;
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
