/** Shared test fakes and fixtures. */
export { InMemoryAuditLog } from './in-memory-audit-log.js';
export { InMemoryChangeSetRepository } from './in-memory-changeset-repository.js';
export { describeChangeSetRepositoryContract, type ChangeSetRepositoryHarness } from './changeset-repository-contract.js';
export { InMemoryRateCounter } from './in-memory-rate-counter.js';
export { describeRateCounterContract, type RateCounterHarness } from './rate-counter-contract.js';
export { InMemoryExecutor, ScriptedWriter, type InMemoryExecutorDeps, type ScriptedWriterOptions } from './in-memory-executor.js';
export { describeExecutorContract, EXECUTOR_CONTRACT_HASH, type ExecutorHarness } from './executor-contract.js';
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
