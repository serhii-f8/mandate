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
export const PAGE_CHECKS = Symbol('PageChecks');
export const PAGE_SESSIONS = Symbol('SessionService');
export const SUBMIT_SERVICE = Symbol('SubmitService');
export const TEMPORAL = Symbol('Temporal');
export const WIDGET_BUNDLES = Symbol('WidgetBundles');
export const WORKFLOW_STARTER = Symbol('WorkflowStarter');
