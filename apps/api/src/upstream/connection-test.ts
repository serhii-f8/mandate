/**
 * CONN-7 connection test (design part 1 §4.7): runs a connection's declared test read
 * through its adapter with the stored credential and reports status, item count and the
 * detectable scopes (SEC-7). Independent of HTTP: the credential page and the CLI use it.
 */
import type { ConnectionTestReport, ReadAdapter, ReadErrorCode, ScopeReport } from '@aiops/connector-sdk';
import type { LoadedConfiguration } from '@aiops/config';
import type { AuditLog, CredentialVault } from '@aiops/core';
import { connectionCredential } from '@aiops/upstream';

export const NO_TEST_DECLARED = 'no connection test is declared';
export const CONNECTION_UNKNOWN = 'connection is not configured';
const CREDENTIAL_UNUSABLE = 'the stored credential has an unknown scheme';
const CREDENTIAL_UNREADABLE = 'the stored credential could not be read';
const NOT_DETECTABLE: ScopeReport = { detectable: false, source: 'none', values: [] };

export interface ConnectionTestDeps {
  /** The active configuration; a caller holding a request snapshot passes it to `run` instead. */
  readonly configuration: () => LoadedConfiguration;
  readonly vault: CredentialVault;
  readonly adapter: ReadAdapter;
  readonly audit: AuditLog;
  readonly newId: () => string;
}

const failed = (operation: string, code: ReadErrorCode, message: string): ConnectionTestReport => ({
  ok: false,
  operation,
  durationMs: 0,
  code,
  message,
  scopes: NOT_DETECTABLE,
});

export class ConnectionTestService {
  constructor(private readonly deps: ConnectionTestDeps) {}

  /** Runs the test and writes one `connection.test` audit row (AUD-1); the report never holds secret material (SEC-3). */
  async run(connectionId: string, actor: string, clientId: string, correlationId: string, configuration = this.deps.configuration()): Promise<ConnectionTestReport> {
    const report = await this.test(connectionId, configuration);
    await this.deps.audit.append({
      id: this.deps.newId(),
      actor,
      clientId,
      action: 'connection.test',
      subject: connectionId,
      outcome: report.ok ? 'ok' : 'error',
      correlationId,
      // The adapter's message stays out of the audit: only fixed codes and numbers (SEC-3).
      details: {
        connection: connectionId,
        ok: report.ok,
        ...(report.status === undefined ? {} : { status: report.status }),
        ...(report.code === undefined ? {} : { code: report.code }),
        scopesDetectable: report.scopes.detectable,
      },
    });
    return report;
  }

  /** A thrown error becomes a report with a fixed message: the error's own text may hold upstream or secret material (SEC-3). */
  private async test(connectionId: string, configuration: LoadedConfiguration): Promise<ConnectionTestReport> {
    const operation = configuration.connectionTests.get(connectionId)?.operation ?? '';
    const credentialFailed = { value: false };
    try {
      return await this.attempt(connectionId, configuration, credentialFailed);
    } catch {
      return credentialFailed.value
        ? failed(operation, 'credential_unusable', CREDENTIAL_UNREADABLE)
        : failed(operation, 'network', 'the connection test failed unexpectedly');
    }
  }

  private async attempt(connectionId: string, configuration: LoadedConfiguration, credentialFailed: { value: boolean }): Promise<ConnectionTestReport> {
    const connection = configuration.connectionSettings.get(connectionId);
    if (connection === undefined) return failed('', 'mapping', CONNECTION_UNKNOWN);
    const declared = configuration.connectionTests.get(connectionId);
    if (declared === undefined) return failed('', 'mapping', NO_TEST_DECLARED);
    const binding = configuration.bindings.get(declared.operation);
    // Not reachable with a fully checked configuration (the loader checks the test operation).
    // An MCP-backed test operation is not run here yet (Phase 9 adapter plan, Task 12).
    if (binding?.connection !== connectionId || binding.kind !== 'http') return failed(declared.operation, 'mapping', 'the test operation has no upstream binding');

    let credential: Awaited<ReturnType<typeof connectionCredential>>;
    try {
      credential = await connectionCredential(this.deps.vault, connection.credentialRef);
    } catch {
      return failed(declared.operation, 'credential_unusable', CREDENTIAL_UNREADABLE);
    }
    if (credential === 'unusable') return failed(declared.operation, 'credential_unusable', CREDENTIAL_UNUSABLE);
    // Marks a failed decrypt, so an error the adapter passes on is reported as the credential's.
    const source = credential;
    const withCredential =
      source === undefined
        ? {}
        : {
            credential: {
              ...source,
              open: () =>
                source.open().catch((error: unknown) => {
                  credentialFailed.value = true;
                  throw error;
                }),
            },
          };
    const outcome = await this.deps.adapter.read({ connection, mapping: binding.mapping, args: declared.args, ...withCredential });
    const scopes = await this.deps.adapter.detectScopes({ connection, ...withCredential });
    if (!outcome.ok) {
      return {
        ok: false,
        operation: declared.operation,
        ...(outcome.status === undefined ? {} : { status: outcome.status }),
        durationMs: outcome.durationMs,
        code: outcome.code,
        message: outcome.message,
        scopes,
      };
    }
    return {
      ok: true,
      operation: declared.operation,
      status: outcome.status,
      durationMs: outcome.durationMs,
      ...(outcome.items === undefined ? {} : { itemCount: outcome.items.length }),
      scopes,
    };
  }
}
