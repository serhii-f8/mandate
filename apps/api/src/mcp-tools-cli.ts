// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The AI Operations Layer Authors
/**
 * `aiops mcp tools <connection> [--show <tool>]`: lists an `mcp` connection's tools live, with
 * their hashes, the operation bound to each and its pin state, so an operator can review a
 * tool and record its pin (CONN-1, CONN-4). `--show` prints the upstream definition for the
 * operator only (SEC-6): it never reaches a client, and the credential is never printed (SEC-3).
 * Environment, stores and exit codes are handled by `cli.ts`; this module takes loaded values.
 */
import { createSchemaCompiler, MCP_TOOL_NAME, pinStateOf, toMcpCatalog, type LoadedConfiguration, type McpOperationBinding } from '@aiops/config';
import type { ConnectionSettings, McpToolAdapter, McpToolDefinition } from '@aiops/connector-sdk';
import type { CredentialVault } from '@aiops/core';
import { connectionCredential } from '@aiops/upstream';

export const MCP_TOOLS_USAGE = '       aiops mcp tools <connection> [--show <tool>]';
export const REVIEW_LINE = '# Upstream definition, for operator review only (SEC-6); not shown to clients';

/** The shape of a connection ID (`upstream-schema.ts`); anything else cannot name one. */
const CONNECTION_ID = /^[a-z][a-z0-9_-]{0,62}$/;
const MAX_OPERATION_ID = 64;

export interface McpToolsArgs {
  readonly connection: string;
  readonly show?: string;
}

/** `<connection> [--show <tool>]`; undefined is a usage error. Both values are printable once they pass. */
export function parseMcpToolsArgs(args: readonly string[]): McpToolsArgs | undefined {
  const [connection, flag, tool, ...extra] = args;
  if (connection === undefined || !CONNECTION_ID.test(connection) || extra.length > 0) return undefined;
  if (flag === undefined) return { connection };
  if (flag !== '--show' || tool === undefined || !MCP_TOOL_NAME.test(tool)) return undefined;
  return { connection, show: tool };
}

/** The connection's settings when it is an `mcp` connection of the revision; otherwise the reason. */
export function mcpConnectionOf(configuration: LoadedConfiguration, id: string): ConnectionSettings | string {
  const settings = configuration.connectionSettings.get(id);
  if (settings === undefined) return `connection ${id} is not defined in the active revision`;
  if (settings.kind !== 'mcp') return `connection ${id} is not an mcp connection`;
  return settings;
}

/**
 * A valid operation ID for a skeleton (ruling F17): each part lower-cased, every character
 * outside `[a-z0-9_]` replaced with `_`, the tool part prefixed `t_` unless it starts with a
 * letter, and the whole truncated to 64 characters.
 */
export function skeletonOperationId(connection: string, tool: string): string {
  const clean = (value: string): string => value.toLowerCase().replace(/[^a-z0-9_]/g, '_');
  const toolPart = clean(tool);
  return `${clean(connection)}.${/^[a-z]/.test(toolPart) ? toolPart : `t_${toolPart}`}`.slice(0, MAX_OPERATION_ID);
}

/**
 * Characters that JSON leaves raw but a terminal or editor may act on: DEL and C1 controls
 * (`\u009b` is a CSI), line and paragraph separators, and bidirectional overrides.
 */
const TERMINAL_UNSAFE = /[\u007f-\u009f\u061c\u200e\u200f\u2028\u2029\u202a-\u202e\u2066-\u2069]/g;

/** Pretty JSON of upstream text with every control character escaped (JSON escapes U+0000–U+001F itself). */
function reviewJson(value: unknown): string[] {
  const escape = (ch: string): string => `\\u${ch.charCodeAt(0).toString(16).padStart(4, '0')}`;
  return JSON.stringify(value, null, 2).replace(TERMINAL_UNSAFE, escape).split('\n');
}

/**
 * A tool name as a YAML flow scalar that reads back as the same string: plain when it starts
 * with a letter or `_` and is not a core-schema boolean or null, else double-quoted (JSON is YAML).
 */
function yamlString(value: string): string {
  return /^[A-Za-z_][A-Za-z0-9_./-]*$/.test(value) && !/^(true|false|null)$/i.test(value) ? value : JSON.stringify(value);
}

export interface McpToolsInput {
  readonly configuration: LoadedConfiguration;
  readonly connection: ConnectionSettings;
  readonly vault: CredentialVault;
  readonly listTools: McpToolAdapter['listTools'];
  readonly show?: string;
}

/** Lists the tools and prints them, or the one `--show` names. Returns the exit code: 0 listed, 1 failed or unknown tool. */
export async function runMcpTools(input: McpToolsInput, out: (line: string) => void): Promise<0 | 1> {
  const { configuration, connection } = input;
  const credential = await connectionCredential(input.vault, connection.credentialRef);
  if (credential === 'unusable') {
    out('tools/list failed: credential_unusable');
    return 1;
  }
  const outcome = await input.listTools({ connection, ...(credential === undefined ? {} : { credential }) });
  // The catalog drops bad names, refuses duplicates and recomputes each hash, as the pin monitor does.
  const catalog = toMcpCatalog(outcome, Date.now());
  if (catalog.status !== 'listed') {
    // The code only: an upstream message may carry upstream text (SEC-3, SEC-5).
    out(`tools/list failed: ${catalog.status === 'unlisted' ? catalog.code : 'invalid_response'}`);
    return 1;
  }

  if (input.show !== undefined) {
    const tool = catalog.tools.find((t) => t.name === input.show);
    const definition: McpToolDefinition | undefined = outcome.ok ? outcome.tools.find((t) => t.definition.name === input.show)?.definition : undefined;
    if (tool === undefined || definition === undefined) {
      out(`tool ${input.show} is not listed by connection ${connection.id}`);
      return 1;
    }
    out(REVIEW_LINE);
    const { name, title, description, inputSchema, outputSchema, annotations } = definition;
    for (const line of reviewJson({ name, title: title ?? null, description: description ?? null, inputSchema, outputSchema: outputSchema ?? null, annotations: annotations ?? null })) {
      out(line);
    }
    out('operations:');
    out(`  - id: ${skeletonOperationId(connection.id, tool.name)}`);
    out(`    connection: ${connection.id}`);
    out('    risk: read');
    out('    description: <write your own description>');
    out(`    upstream: { tool: ${yamlString(tool.name)}, pin: ${tool.hash} }`);
    return 0;
  }

  const bound = new Map<string, { readonly operation: string; readonly binding: McpOperationBinding }>();
  for (const [operation, binding] of configuration.bindings) {
    if (binding.kind === 'mcp' && binding.connection === connection.id) bound.set(binding.tool, { operation, binding });
  }
  const compile = createSchemaCompiler();
  // Code-unit order, so the output does not depend on the locale.
  const tools = [...catalog.tools].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  for (const tool of tools) {
    const entry = bound.get(tool.name);
    const state = entry === undefined ? 'unreferenced' : pinStateOf(entry.binding, catalog, compile).state;
    out(`${tool.name} ${tool.hash} ${entry?.operation ?? '-'} ${state}`);
  }
  out(`listed ${String(tools.length)} tools (dropped ${String(catalog.dropped)})`);
  return 0;
}
