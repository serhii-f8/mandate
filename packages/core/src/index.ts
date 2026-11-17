/** Domain model, policy evaluation, manifest engine and diff. Free of frameworks, drivers and adapters. */
export type { AuditAction, AuditDecision, AuditEventInput, AuditLog, AuditOutcome } from './audit.js';
export { ANONYMOUS_CALLER, type Caller } from './caller.js';
export { toolCallAuditEvent, type ToolCallRecord } from './tool-call-audit.js';
export type {
  DisabledOperation,
  GrantDefinition,
  ManifestDefinition,
  ManifestRead,
  ManifestTemplate,
  RollbackStrategy,
  OperationDefinition,
  PolicyConfiguration,
  RiskClass,
  RoleDefinition,
  RoleMappingEntry,
  ScopeValue,
} from './policy-model.js';
export { resolveRoles } from './roles.js';
export {
  createPolicyEngine,
  type DenyReason,
  type EvaluationRequest,
  type PolicyDecision,
  type PolicyEngine,
} from './policy-engine.js';
export { MAX_AUDITED_TOOL_NAME, policyDecisionAuditEvent, type PolicyDecisionRecord } from './policy-audit.js';
export type { InvocationRequest, InvocationResult, OperationInvoker } from './operation-invoker.js';
export { readErrorResult, readToolResult, READ_RESULT_TEXT, type ReadToolResultInput } from './read-result.js';
export type { CredentialHandle, CredentialStatus, CredentialVault } from './credential-vault.js';
export { canonicalJson, compareTargetIds, normalizeArgs } from './changeset/canonical.js';
export { ChangeSetHasher, type HashableItem } from './changeset/hash.js';
export type {
  ChangeItemRecord,
  ChangeSetRecord,
  ChangeSetStats,
  ChangeSetStatus,
  ExclusionReason,
  ItemStatus,
} from './changeset/model.js';
export { EMPTY_STATS } from './changeset/model.js';
export { CANCELLABLE, canTransition, isExpiryDue, PRE_EXECUTION, TRANSITIONS } from './changeset/lifecycle.js';
export type {
  ChangeSetExecutor,
  ChangeSetRepository,
  ChangeWriter,
  ExecutionProgress,
  ItemOutcome,
  ItemsPageQuery,
  NewChangeSet,
  PrepareFailure,
  ReadPage,
  StartRefusal,
  UpstreamReader,
} from './changeset/ports.js';
export { changesetTransitionEvent, type ChangesetTransitionInput } from './changeset/audit.js';
export { buildItems, touchedFields } from './changeset/items.js';
export { prepareChangeSet, type PrepareDeps, type PrepareOutcome, type PrepareRequest } from './changeset/prepare.js';
export {
  CHANGESET_TEXT,
  decodeCursor,
  encodeCursor,
  preparationErrorResult,
  preparedResult,
} from './changeset/result.js';
