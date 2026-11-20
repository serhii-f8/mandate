/** Shared test fakes and fixtures. */
export { InMemoryAuditLog } from './in-memory-audit-log.js';
export { InMemoryConfigRevisionStore } from './in-memory-config-revision-store.js';
export {
  describeConfigRevisionStoreContract,
  type ConfigRevisionStoreHarness,
} from './config-revision-store-contract.js';
export { InMemoryChangeSetRepository } from './in-memory-changeset-repository.js';
export { describeChangeSetRepositoryContract, type ChangeSetRepositoryHarness } from './changeset-repository-contract.js';
export { InMemoryNotificationOutbox } from './in-memory-notification-outbox.js';
export { describeNotificationOutboxContract, type NotificationOutboxHarness } from './notification-outbox-contract.js';
export { InMemoryTaskRepository } from './in-memory-task-repository.js';
export { describeTaskRepositoryContract, type TaskRepositoryHarness } from './task-repository-contract.js';
export { InMemoryRateCounter } from './in-memory-rate-counter.js';
export { describeRateCounterContract, type RateCounterHarness } from './rate-counter-contract.js';
export { InMemoryExecutor, ScriptedWriter, type InMemoryExecutorDeps, type ScriptedWriterOptions } from './in-memory-executor.js';
export {
  describeExecutorContract,
  describeRollbackRun,
  EXECUTOR_CONTRACT_HASH,
  type ExecutorHarness,
  type RollbackHarness,
} from './executor-contract.js';
export { allowAllGuard } from './allow-all-guard.js';
export { POSTGRES_IMAGE, startPostgres, type StartedPostgres } from './postgres.js';
export {
  startTestIssuer,
  TEST_WEB_CLIENT_ID,
  TEST_WEB_CLIENT_SECRET,
  type IdTokenTamper,
  type RecordedTokenRequest,
  type TestIssuer,
  type TestLoginUser,
  type TestTokenClaims,
} from './test-issuer.js';
export { FakeInvoker } from './fake-invoker.js';
export {
  CookieJar,
  KEYCLOAK_IMAGE,
  loginWithPkce,
  pageLogin,
  registerClient,
  startKeycloak,
  type LoginOptions,
  type LoginResult,
  type PageLoginOptions,
  type PageLoginResult,
  type StartedKeycloak,
  type StartKeycloakOptions,
} from './keycloak.js';
export { startFakeUpstream, type FakeUpstream, type FakeHandler, type FakeResponse, type RecordedRequest } from './fake-upstream.js';
export { FakeResolver, fakeCatalogEntry } from './fake-resolver.js';
export { startSmtpSink, type SinkMessage, type SmtpSink } from './smtp-sink.js';
export { installFakeMagentoCatalog, type FakeMagentoCatalog, type FakeMagentoProduct } from './fake-magento-catalog.js';
export { CODE_FIXTURE_PRESET_DIR, installFakeItems, type FakeItem, type FakeItems } from './fake-items.js';
export { recordApproval, submitChangeSet } from './approval-fixtures.js';
export { describeApprovalRepositoryContract } from './approval-repository-contract.js';
export {
  startFakeMcpServer,
  type FakeMcpServer,
  type FakeMcpServerOptions,
  type FakeMcpTool,
  type RecordedMcpRequest,
} from './fake-mcp-server.js';
export {
  contractRead,
  contractWrite,
  presetConnectionYaml,
  recordingsFreeOf,
  replayRecordings,
  type ContractBinding,
  type RecordedExchange,
} from './preset-contract.js';
