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
export { parseVersionedKeys, type VersionedKeys } from './keys.js';
export { canonicalJson, compareTargetIds, normalizeArgs } from './changeset/canonical.js';
export { ChangeSetHasher, type HashableItem } from './changeset/hash.js';
export type {
  CancelRequest,
  ExecutionRequest,
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
  BatchContext,
  BatchRecord,
  BatchSubmission,
  ChangeSetExecutor,
  ChangeSetRepository,
  ChangeWriter,
  ExecutionGuard,
  ExecutionLimits,
  ExecutionProgress,
  ExecutionUsage,
  FinishOutcome,
  ItemOutcome,
  ItemsPageQuery,
  LimitName,
  NewChangeSet,
  PlanEntry,
  PreparationRepository,
  PrepareFailure,
  RateCounter,
  ReadPage,
  StartEvent,
  StartOutcome,
  StartRefusal,
  StartRequest,
  UpstreamReader,
  WorkflowProgress,
  WorkflowStarter,
} from './changeset/ports.js';
export { BatchFenced, ExecutorUnavailable } from './changeset/ports.js';
export {
  changesetBatchEvent,
  coverBatch,
  evaluateLimits,
  executionTerminal,
  failureThresholdExceeded,
  startEventFactory,
  type BatchCounts,
  type StartEventContext,
} from './changeset/execution.js';
export { changesetTransitionEvent, type ChangesetTransitionInput } from './changeset/audit.js';
export { buildItems, inScope, touchedFields } from './changeset/items.js';
export {
  type BulkItemState,
  type BulkWriter,
  classifyForWrite,
  type Clock,
  ManifestBatchWriter,
  type ManifestBatchWriterDeps,
  POLL_FACTOR,
  POLL_GIVE_UP_MS,
  POLL_INITIAL_MS,
  POLL_MAX_MS,
  RetryableWriteError,
  type RetryableWriteCode,
  UnsupportedWriter,
  type WriteClassification,
  type WriteOutcomeCode,
} from './changeset/writer.js';
export {
  createChangeSet,
  resolveTemplates,
  prepareChangeSet,
  runPreparation,
  type CreateRequest,
  type PrepareDeps,
  type PrepareOutcome,
  type PrepareRequest,
  type RunPreparationRequest,
} from './changeset/prepare.js';
export { hashStoredItems } from './changeset/verify.js';
export {
  CHANGESET_TEXT,
  decodeCursor,
  encodeCursor,
  preparationErrorResult,
  preparedResult,
} from './changeset/result.js';
