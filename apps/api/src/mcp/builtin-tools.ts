import { createSchemaCompiler } from '@aiops/config';
import type { ChangeSetRepository } from '@aiops/core';
import { createChangesetTools } from './changeset-tools.js';
import { listMyOperationsTool } from './operations-tool.js';
import type { BuiltinTool } from './tool-catalog.js';

const PING_SCHEMA = {
  type: 'object',
  properties: { message: { type: 'string', maxLength: 200 } },
  additionalProperties: false,
} as const;

const validatePing = createSchemaCompiler()(PING_SCHEMA);

/** Checks that the AI Operations Layer is reachable (Phase 1, kept as a built-in; ADR 0016). */
export const pingTool: BuiltinTool = {
  name: 'ping',
  description: 'Check that the AI Operations Layer is reachable.',
  inputSchema: PING_SCHEMA,
  validate: validatePing,
  handler(args) {
    const message = typeof args.message === 'string' ? args.message : undefined;
    return Promise.resolve({
      content: [{ type: 'text', text: message === undefined ? 'pong' : `pong: ${message}` }],
      structuredContent: { pong: true, message: message ?? null, serverTime: new Date().toISOString() },
    });
  },
};

export interface BuiltinToolDeps {
  readonly repository: ChangeSetRepository;
  readonly newId: () => string;
  readonly now: () => Date;
}

/** Every built-in tool (MCP-8); their names are reserved. */
export function createBuiltinTools(deps: BuiltinToolDeps): readonly BuiltinTool[] {
  return [pingTool, listMyOperationsTool, ...createChangesetTools(deps)];
}
