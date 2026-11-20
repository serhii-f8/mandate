import { createSchemaCompiler } from '@aiops/config';
import type { AuditLog, ChangeSetExecutor, ChangeSetRepository, TaskRepository, WorkflowStarter } from '@aiops/core';
import type { UpstreamToolView } from '@aiops/upstream';
import type { ApprovalService } from '../approvals/approval-service.js';
import { createChangesetTools } from './changeset-tools.js';
import { decideChangesetTool } from './decide-tool.js';
import { excludeChangesetItemsTool } from './exclude-tool.js';
import { createListMyOperationsTool } from './operations-tool.js';
import { reviewChangesetTool } from './review-tool.js';
import { rollbackChangesetTool } from './rollback-tool.js';
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
  /** Records decisions (`decide_changeset`) and starts approved change-sets with the requester's submitted identity (POL-6, SEC-9). */
  readonly approvals: ApprovalService;
  /** `AIOPS_PUBLIC_URL`: base of the approval page link in the submit answer (APR-7). */
  readonly publicUrl: URL;
  /** Pin states for `list_my_operations` (CONN-4). */
  readonly upstreamTools?: UpstreamToolView;
}

/** What `exclude_changeset_items` needs besides the shared deps: the derived change-set's workflow start (EXE-1). */
export interface ExclusionWiring {
  readonly starter: WorkflowStarter;
  readonly onStartFailure: (changesetId: string, error: unknown) => void;
}

/** Every built-in tool (MCP-8); their names are reserved. */
export function createBuiltinTools(deps: BuiltinToolDeps, exclusion: ExclusionWiring): readonly BuiltinTool[] {
  return [
    pingTool,
    createListMyOperationsTool(deps.upstreamTools),
    ...createChangesetTools(deps),
    submitForApprovalTool(deps),
    excludeChangesetItemsTool({ repository: deps.repository, newId: deps.newId, now: deps.now, ...exclusion }),
    rollbackChangesetTool({ repository: deps.repository, now: deps.now, publicUrl: deps.publicUrl }),
    decideChangesetTool(deps),
    reviewChangesetTool(deps),
  ];
}
