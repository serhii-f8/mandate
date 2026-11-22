// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Mandate Authors
/**
 * CONN-7 connection test (design part 1 §4.7): runs a connection's declared test read
 * through its adapter with the stored credential and reports status, item count and the
 * detectable scopes (SEC-7). Independent of HTTP: the credential page and the CLI use it.
 * An `mcp` connection lists its tools and calls the test operation's tool, only when the
 * listed tool still matches its pin (CONN-4); its item count is the number of listed tools.
 * A code-bound test operation runs its preset code read through `codeRead` (OPS-5).
 */
import type { CodeAdapter, ConnectionSettings, ConnectionTestReport, CredentialSource, McpToolAdapter, ReadAdapter, ReadErrorCode, ReadOutcome, ScopeReport } from '@mandate/connector-sdk';
import type { LoadedConfiguration, McpOperationBinding } from '@mandate/config';
import type { AuditLog, CredentialVault } from '@mandate/core';
import { connectionCredential } from '@mandate/upstream';

export const NO_TEST_DECLARED = 'no connection test is declared';
export const CONNECTION_UNKNOWN = 'connection is not configured';
const CREDENTIAL_UNUSABLE = 'the stored credential has an unknown scheme';
const CREDENTIAL_UNREADABLE = 'the stored credential could not be read';
const NOT_DETECTABLE: ScopeReport = { detectable: false, source: 'none', values: [] };
const PIN_MISMATCH = "the test operation's upstream tool does not match its pin";
const NO_TOOL_ADAPTER = 'the adapter cannot list or call upstream tools';

export interface ConnectionTestDeps {
  /** The active configuration; a caller holding a request snapshot passes it to `run` instead. */
  readonly configuration: () => LoadedConfiguration;
  readonly vault: CredentialVault;
  /**
   * The MCP methods are needed only for `mcp` connections, `codeRead` only for a code-bound test
   * operation (OPS-5); without them those tests report `mapping`.
   */
  readonly adapter: ReadAdapter & Partial<McpToolAdapter> & Partial<CodeAdapter>;
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
    const noBinding = failed(declared.operation, 'mapping', 'the test operation has no upstream binding');
    // Not reachable with a fully checked configuration (the loader checks the test operation).
    if (binding?.connection !== connectionId) return noBinding;
    // The read of an HTTP or code binding (an MCP binding is tested by `attemptMcp`).
    let readWith: ((withCredential: { credential?: CredentialSource }) => Promise<ReadOutcome>) | undefined;
    if (binding.kind === 'code') {
      // OPS-5: only a module operation of kind `read`, through an adapter that runs code.
      const operation = configuration.codeOperations.get(declared.operation);
      const { adapter } = this.deps;
      const { codeRead } = adapter;
      if (operation?.kind !== 'read' || codeRead === undefined) return noBinding;
      readWith = (withCredential) =>
        codeRead.call(adapter, { connection, name: binding.name, operation, args: declared.args, response: binding.response, ...withCredential });
    } else if (binding.kind === 'http') {
      readWith = (withCredential) => this.deps.adapter.read({ connection, mapping: binding.mapping, args: declared.args, ...withCredential });
    }

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
    if (binding.kind === 'mcp') return this.attemptMcp(connection, declared, binding, withCredential);
    if (readWith === undefined) return noBinding;
    const outcome = await readWith(withCredential);
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

  /**
   * Lists the tools, then calls the test operation's tool only when the listed definition's hash
   * equals the pin (CONN-4): an operator-triggered test never runs a definition nobody reviewed.
   */
  private async attemptMcp(
    connection: ConnectionSettings,
    declared: { readonly operation: string; readonly args: Readonly<Record<string, unknown>> },
    binding: McpOperationBinding,
    withCredential: { credential?: CredentialSource },
  ): Promise<ConnectionTestReport> {
    const { listTools, callTool } = this.deps.adapter;
    if (listTools === undefined || callTool === undefined) return failed(declared.operation, 'mapping', NO_TOOL_ADAPTER);
    const list = await listTools.call(this.deps.adapter, { connection, ...withCredential });
    if (!list.ok) {
      return {
        ok: false,
        operation: declared.operation,
        ...(list.status === undefined ? {} : { status: list.status }),
        durationMs: list.durationMs,
        code: list.code,
        message: list.message,
        scopes: NOT_DETECTABLE,
      };
    }
    const tool = list.tools.find((t) => t.definition.name === binding.tool);
    if (tool?.hash !== binding.pin) return { ...failed(declared.operation, 'mapping', PIN_MISMATCH), durationMs: list.durationMs };
    const outcome = await callTool.call(this.deps.adapter, { connection, tool: binding.tool, args: declared.args, ...withCredential, retryable: true });
    const durationMs = list.durationMs + outcome.durationMs;
    if (!outcome.ok) {
      return {
        ok: false,
        operation: declared.operation,
        ...(outcome.status === undefined ? {} : { status: outcome.status }),
        durationMs,
        code: outcome.code,
        message: outcome.message,
        scopes: NOT_DETECTABLE,
      };
    }
    return { ok: true, operation: declared.operation, status: outcome.status, durationMs, itemCount: list.tools.length, scopes: NOT_DETECTABLE };
  }
}
