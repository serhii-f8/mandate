import { createSchemaCompiler } from '@aiops/config';
import type { AuditLog, ChangeSetExecutor, ChangeSetRepository, TaskRepository } from '@aiops/core';
import type { ApprovalService } from '../approvals/approval-service.js';
import { createChangesetTools } from './changeset-tools.js';
import { listMyOperationsTool } from './operations-tool.js';
import { submitForApprovalTool } from './submit-tool.js';
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
  /** Starts execution (EXE-11); `submit_for_approval` only. */
  readonly executor: ChangeSetExecutor;
  /** Where `submit_for_approval` commits its execute tasks (MCP-7). */
  readonly tasks: TaskRepository;
  /** For the policy re-check's decision row (POL-6, POL-8). */
  readonly audit: AuditLog;
  /** Starts approved change-sets with the requester's submitted identity (POL-6, SEC-9). */
  readonly approvals: ApprovalService;
  /** `AIOPS_PUBLIC_URL`: base of the approval page link in the submit answer (APR-7). */
  readonly publicUrl: URL;
}

/** Every built-in tool (MCP-8); their names are reserved. */
export function createBuiltinTools(deps: BuiltinToolDeps): readonly BuiltinTool[] {
  return [pingTool, listMyOperationsTool, ...createChangesetTools(deps), submitForApprovalTool(deps)];
}
