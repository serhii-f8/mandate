import { createSchemaCompiler } from '@aiops/config';
import { resolveRoles, type GrantDefinition } from '@aiops/core';
import type { BuiltinTool } from './tool-catalog.js';

const SCHEMA = { type: 'object', properties: {}, additionalProperties: false } as const;

/** `list_my_operations` (MCP-8): the caller's own policy, no side effects. */
export const listMyOperationsTool: BuiltinTool = {
  name: 'list_my_operations',
  description: 'List the operations you may use, with your scope and field restrictions.',
  inputSchema: SCHEMA,
  validate: createSchemaCompiler()(SCHEMA),
  handler(_args, { caller, snapshot }) {
    const { configuration, engine } = snapshot;
    const roleIds = new Set(resolveRoles(caller.groups, configuration.policy.roleMapping));
    const grantsOf = (operationId: string): GrantDefinition[] =>
      configuration.policy.roles.filter((r) => roleIds.has(r.id)).flatMap((r) => r.grants.filter((g) => g.operation === operationId));
    const operations = engine.grantedOperations(caller).map((op) => ({
      tool: op.toolName,
      operation: op.id,
      ...(op.title === undefined ? {} : { title: op.title }),
      risk: op.risk,
      description: op.description,
      grants: grantsOf(op.id).map((g) => ({
        scope: g.scope,
        denyFields: g.denyFields,
        ...(g.allowFields === undefined ? {} : { allowFields: g.allowFields }),
      })),
    }));
    const list = operations.map((o) => `${o.tool} (${o.risk})`).join(', ');
    const text = `You can use ${String(operations.length)} operation(s)${operations.length === 0 ? '.' : `: ${list}.`}`;
    return Promise.resolve({ content: [{ type: 'text', text }], structuredContent: { operations } });
  },
};
