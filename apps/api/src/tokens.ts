/** Dependency-injection tokens shared by the api modules. */
export const API_ENV = Symbol('ApiEnv');
export const APPROVAL_SERVICE = Symbol('ApprovalService');
export const AUDIT_LOG = Symbol('AuditLog');
export const AUDIT_READER = Symbol('AuditReader');
export const BEARER_GATE = Symbol('BearerGate');
export const CHANGESET_EXECUTOR = Symbol('ChangeSetExecutor');
export const CHANGESET_REPOSITORY = Symbol('ChangeSetRepository');
export const CONFIGURATION = Symbol('ConfigurationHolder');
export const CONNECTION_TEST = Symbol('ConnectionTestService');
export const CREDENTIAL_VAULT = Symbol('CredentialVault');
export const DATABASE = Symbol('Database');
export const MCP_HANDLER = Symbol('McpHttpHandler');
export const LOGGER = Symbol('Logger');
export const OIDC_CLIENT = Symbol('OidcClient');
/** The caller's shutdown step, run after the api's own resources closed (`AppOverrides.onShutdown`). */
export const ON_SHUTDOWN = Symbol('OnShutdown');
/** The pin monitor of MCP-backed operations (CONN-4), or `null` when the adapter cannot list tools. */
export const PIN_MONITOR = Symbol('PinMonitor');
export const PAGE_CHECKS = Symbol('PageChecks');
export const PAGE_SESSIONS = Symbol('SessionService');
/** The shared rate counter of the pipeline (POL-4) and the endpoint limiter (SEC-10). */
export const RATE_COUNTER = Symbol('RateCounter');
/** The endpoint limiter of `/mcp` and the page login routes (SEC-10). */
export const RATE_LIMITER = Symbol('EndpointRateLimiter');
export const SUBMIT_SERVICE = Symbol('SubmitService');
/** The api's telemetry, or `null` without one; shut down after everything else (NFR-11). */
export const TELEMETRY = Symbol('Telemetry');
export const TEMPORAL = Symbol('Temporal');
/** The tracer of the api's own spans (NFR-11). */
export const TRACER = Symbol('Tracer');
export const WIDGET_BUNDLES = Symbol('WidgetBundles');
export const WORKFLOW_STARTER = Symbol('WorkflowStarter');
