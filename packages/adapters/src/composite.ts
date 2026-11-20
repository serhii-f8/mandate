/**
 * Composite adapter (CONN-1, SEC-7): one object the api, worker and CLI use for every
 * connection. Each method dispatches on `ConnectionSettings.kind`: OpenAPI connections (the
 * default) go to the OpenAPI adapter, `mcp` connections to the MCP tool adapter. A method that
 * does not exist for a connection's kind answers `mapping` without sending anything; preset code
 * operations (OPS-5) run on OpenAPI connections only.
 */
import type {
  BulkStatusOutcome,
  BulkSubmitOutcome,
  CallOutcome,
  CodeAdapter,
  CodeCallResult,
  CodeWriteOutcome,
  ConnectionSettings,
  CredentialSource,
  McpToolAdapter,
  ReadAdapter,
  ReadOutcome,
  RecordSendOutcome,
  RecordWriteAdapter,
  RequestInstrumentation,
  ScopeReport,
  ToolListOutcome,
  UpstreamResolver,
  WriteAdapter,
  WriteFailure,
} from '@aiops/connector-sdk';
import type { CodeRunnerDeps } from './code/runner.js';
import { createMcpToolAdapter } from './mcp/adapter.js';
import { createOpenApiAdapter } from './openapi/adapter.js';

export type UpstreamAdapters = ReadAdapter &
  WriteAdapter &
  RecordWriteAdapter &
  CodeAdapter &
  McpToolAdapter & { resolver: UpstreamResolver & Required<Pick<UpstreamResolver, 'resolveTools'>> };

export interface AdaptersDeps {
  readonly instrumentation?: RequestInstrumentation;
  /** R10: the credential of a connection for the load-time tool list; absent lists without one. */
  readonly credentialFor?: (ref: string) => Promise<CredentialSource | undefined>;
  /** Receives the scrubbed, cut message of a code operation that threw (OPS-5, SEC-3). */
  readonly onCodeError?: CodeRunnerDeps['onCodeError'];
  /** Code operation deadlines; default 60 s for reads, 300 s for writes and calls (OPS-5). */
  readonly codeDeadlines?: CodeRunnerDeps['codeDeadlines'];
}

/** Scope detection reads an OAuth token response or JWT claims; an MCP connection offers neither here (SEC-7). */
const NOT_DETECTABLE: ScopeReport = { detectable: false, source: 'none', values: [] };

const isMcp = (connection: ConnectionSettings): boolean => connection.kind === 'mcp';

const readMismatch = (message: string): ReadOutcome & { ok: false } => ({ ok: false, code: 'mapping', durationMs: 0, message });
const writeMismatch = (): WriteFailure => ({ ok: false, code: 'mapping', durationMs: 0, retriable: false });

export function createAdapters(deps: AdaptersDeps = {}): UpstreamAdapters {
  const instrumentation = deps.instrumentation === undefined ? {} : { instrumentation: deps.instrumentation };
  const openapi = createOpenApiAdapter({
    ...instrumentation,
    ...(deps.onCodeError === undefined ? {} : { onCodeError: deps.onCodeError }),
    ...(deps.codeDeadlines === undefined ? {} : { codeDeadlines: deps.codeDeadlines }),
  });
  const mcp = createMcpToolAdapter(instrumentation);

  async function resolveTools({ connection }: { connection: ConnectionSettings }): Promise<ToolListOutcome> {
    if (!isMcp(connection)) return readMismatch('tool listing needs an mcp connection');
    const ref = connection.credentialRef;
    let credential: CredentialSource | undefined;
    if (ref !== undefined && deps.credentialFor !== undefined) {
      try {
        credential = await deps.credentialFor(ref);
      } catch {
        // The lookup's error may carry vault detail; the outcome carries only the code (SEC-3).
        return { ok: false, code: 'credential_unusable', durationMs: 0, message: 'upstream tool list failed (credential_unusable)' };
      }
    }
    return mcp.listTools({ connection, ...(credential === undefined ? {} : { credential }) });
  }

  return {
    resolver: {
      resolveSpec: (input) => openapi.resolver.resolveSpec(input),
      resolveTools,
    },
    read: (input) => (isMcp(input.connection) ? Promise.resolve(readMismatch('an mcp connection has no HTTP read mapping')) : openapi.read(input)),
    detectScopes: (input) => (isMcp(input.connection) ? Promise.resolve(NOT_DETECTABLE) : openapi.detectScopes(input)),
    submitBulk: (input): Promise<BulkSubmitOutcome> => (isMcp(input.connection) ? Promise.resolve(writeMismatch()) : openapi.submitBulk(input)),
    bulkStatus: (input): Promise<BulkStatusOutcome> => (isMcp(input.connection) ? Promise.resolve(writeMismatch()) : openapi.bulkStatus(input)),
    // Each adapter answers not_sent/mapping for a target of the other kind (EXE-4).
    callOnce: (input): Promise<CallOutcome> => (isMcp(input.connection) ? mcp.callOnce(input) : openapi.callOnce(input)),
    // A per-record write is an HTTP binding of an OpenAPI connection (OPS-6).
    writeRecord: (input): Promise<RecordSendOutcome> => (isMcp(input.connection) ? Promise.resolve(writeMismatch()) : openapi.writeRecord(input)),
    // Code operations call the connection's HTTP base URL: an mcp connection has none (F22).
    codeRead: (input) => (isMcp(input.connection) ? Promise.resolve(readMismatch('code operations need an openapi connection')) : openapi.codeRead(input)),
    codeWrite: (input): Promise<CodeWriteOutcome> => (isMcp(input.connection) ? Promise.resolve(writeMismatch()) : openapi.codeWrite(input)),
    codeCall: (input): Promise<CodeCallResult> =>
      // Nothing is sent, so nothing can have been applied: a definite refusal.
      isMcp(input.connection) ? Promise.resolve({ ok: false, definite: true, code: 'mapping', durationMs: 0 }) : openapi.codeCall(input),
    listTools: (input) => (isMcp(input.connection) ? mcp.listTools(input) : Promise.resolve(readMismatch('tool listing needs an mcp connection'))),
    callTool: (input) => (isMcp(input.connection) ? mcp.callTool(input) : Promise.resolve(readMismatch('a tool call needs an mcp connection'))),
  };
}
