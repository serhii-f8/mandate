// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Mandate Authors
/** Domain model, policy evaluation, manifest engine and diff. Free of frameworks, drivers and adapters. */
export { AUDIT_ACTIONS, type AuditAction, type AuditDecision, type AuditEventInput, type AuditLog, type AuditOutcome } from './audit.js';
export { AuditRedactionError, REDACTED, redactAuditDetails } from './audit/redact.js';
export type { AuditReader, AuditRecord, AuditSearchFilter } from './audit/search.js';
export {
  AUDIT_CHAIN_FORMAT,
  auditRowHash,
  checkLink,
  GENESIS_HASH,
  type ChainBreak,
  type ChainHead,
  type ChainRow,
  type SealedChainRow,
} from './audit/chain.js';
export type {
  ApplyRevisionResult,
  ConfigListener,
  ConfigListenerHandlers,
  ConfigRevision,
  ConfigRevisionSource,
  ConfigRevisionStore,
  ConfigRevisionSummary,
  NewConfigRevision,
} from './config-revision.js';
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
  ServiceAccountEntry,
} from './policy-model.js';
export { callerKind, resolveRoles, rolesOf, SERVICE_SUBJECT_PREFIX, serviceClientOf, serviceSubject } from './roles.js';
export {
  createPolicyEngine,
  type DenyReason,
  type EvaluationRequest,
  type PolicyDecision,
  type PolicyEngine,
  touchedFields as touchedCallFields,
} from './policy-engine.js';
export { MAX_AUDITED_TOOL_NAME, policyDecisionAuditEvent, type PolicyDecisionRecord } from './policy-audit.js';
export { isTaskId, TASK_TTL_MS, type TaskKind, type TaskRecord, type TaskRepository } from './task.js';
export type { InvocationRequest, InvocationResult, OperationInvoker } from './operation-invoker.js';
export { readErrorResult, readToolResult, READ_RESULT_TEXT, type ReadToolResultInput } from './read-result.js';
export type { CredentialHandle, CredentialStatus, CredentialVault } from './credential-vault.js';
export { parseVersionedKeys, type VersionedKeys } from './keys.js';
export { CanonicalJsonError, canonicalJson, compareTargetIds, normalizeArgs } from './changeset/canonical.js';
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
  RollbackCounts,
  RollbackItemStatus,
  RollbackRequest,
} from './changeset/model.js';
export { EMPTY_STATS } from './changeset/model.js';
export {
  CANCELLABLE,
  canTransition,
  executionStarted,
  isExpiryDue,
  PRE_EXECUTION,
  ROLLBACK_FROM,
  TRANSITIONS,
} from './changeset/lifecycle.js';
export {
  changesetRollbackBatchEvent,
  ROLLBACK_REQUEST_MARGIN_MS,
  rollbackEligibility,
  rollbackFromFinished,
  rollbackOutcome,
  rollbackRequestEvents,
  rollbackTerminal,
  rollbackWindowEnd,
  rollbackWindowOpen,
  type RollbackEligibility,
  type RollbackEligibilityDeps,
  type RollbackOutcome,
  type RollbackReads,
  type RollbackReason,
  type RollbackRefusal,
} from './changeset/rollback.js';
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
  OpaqueCaller,
  OpaqueCallOutcome,
  OpaqueNotSentCode,
  PlanEntry,
  PreparationRepository,
  PrepareFailure,
  RateCounter,
  ReadPage,
  RollbackItemOutcome,
  RollbackRequestInput,
  RollbackRequestOutcome,
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
  classifyForRollback,
  classifyForWrite,
  type Clock,
  type DirectRecordState,
  type DirectWriter,
  ManifestBatchWriter,
  type ManifestBatchWriterDeps,
  POLL_FACTOR,
  POLL_GIVE_UP_MS,
  POLL_INITIAL_MS,
  POLL_MAX_MS,
  RetryableWriteError,
  type RetryableWriteCode,
  type RollbackClassification,
  UnsupportedWriter,
  type WriteClassification,
  type WriteDirection,
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
  deriveChangeSet,
  isValidTargetId,
  MAX_DERIVE_TARGETS,
  type DeriveDeps,
  type DeriveOutcome,
  type DeriveRefusal,
  type DeriveRepository,
  type DeriveRequest,
} from './changeset/derive.js';
export {
  CHANGESET_TEXT,
  decodeCursor,
  encodeCursor,
  preparationErrorResult,
  preparedResult,
} from './changeset/result.js';
export {
  OPAQUE_TARGET_ID,
  changesetKind,
  isOpaque,
  runOpaquePreparation,
  type ChangeSetKind,
  type OpaquePreparationRequest,
} from './changeset/opaque.js';
export { OpaqueCallWriter, type OpaqueCallWriterDeps } from './changeset/opaque-writer.js';
export * from './approval/index.js';
export * from './notification/index.js';
