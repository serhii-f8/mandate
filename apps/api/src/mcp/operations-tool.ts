// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The AI Operations Layer Authors
import { createSchemaCompiler, type PinState } from '@aiops/config';
import { rolesOf, type GrantDefinition } from '@aiops/core';
import type { UpstreamToolView } from '@aiops/upstream';
import type { BuiltinTool } from './tool-catalog.js';

const SCHEMA = { type: 'object', properties: {}, additionalProperties: false } as const;
const validate = createSchemaCompiler()(SCHEMA);

/**
 * `list_my_operations` (MCP-8): the caller's own policy, no side effects. MCP-backed operations
 * stay listed with their pin state (CONN-4), so a caller sees why one is not offered; without a
 * tool view their state is `unverified`, as the router treats them.
 */
export function createListMyOperationsTool(upstreamTools?: UpstreamToolView): BuiltinTool {
  return {
    name: 'list_my_operations',
    description: 'List the operations you may use, with your scope and field restrictions.',
    inputSchema: SCHEMA,
    validate,
    handler(_args, { caller, snapshot }) {
      const { configuration, engine } = snapshot;
      const roleIds = new Set(rolesOf(caller, configuration.policy));
      const grantsOf = (operationId: string): GrantDefinition[] =>
        configuration.policy.roles.filter((r) => roleIds.has(r.id)).flatMap((r) => r.grants.filter((g) => g.operation === operationId));
      const pinOf = (operationId: string): PinState | undefined =>
        configuration.bindings.get(operationId)?.kind === 'mcp' ? (upstreamTools?.view(configuration, operationId)?.state ?? 'unverified') : undefined;
      const operations = engine.grantedOperations(caller).map((op) => {
        const pin = pinOf(op.id);
        return {
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
          ...(pin === undefined ? {} : { pin }),
        };
      });
      const list = operations
        .map((o) => `${o.tool} (${o.risk})${o.pin === undefined || o.pin === 'ok' ? '' : ` (unavailable: ${o.pin})`}`)
        .join(', ');
      const text = `You can use ${String(operations.length)} operation(s)${operations.length === 0 ? '.' : `: ${list}.`}`;
      return Promise.resolve({ content: [{ type: 'text', text }], structuredContent: { operations } });
    },
  };
}
