import { randomUUID } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { CLIENT_INFO_META_KEY, McpServer, type AuthInfo, type McpServerFactory } from '@modelcontextprotocol/server';
import type { AuditLog, Caller } from '@aiops/core';
import { auditedTool } from './audited-tool.js';
import type { ToolCatalog } from './tool-catalog.js';

export const SERVER_INFO = { name: 'aiops', version: '0.0.0' } as const;

/** What the controller hands to the per-request factory through `authInfo.extra`. */
export interface RequestContext {
  readonly caller: Caller;
  readonly correlationId: string;
}

const CONTEXT_KEY = 'aiops/request';

export function authInfoFor(context: RequestContext): AuthInfo {
  return {
    token: '',
    clientId: context.caller.clientId ?? 'unknown',
    scopes: [],
    extra: { [CONTEXT_KEY]: context },
  };
}

/** The SDK types the envelope as `{}`; read the client's declared name defensively. */
function declaredClientName(envelope: object | undefined): string | undefined {
  const info: unknown = envelope === undefined ? undefined : (envelope as Record<string, unknown>)[CLIENT_INFO_META_KEY];
  if (typeof info !== 'object' || info === null) return undefined;
  const name: unknown = (info as Record<string, unknown>).name;
  return typeof name === 'string' && name.length > 0 ? name.slice(0, 200) : undefined;
}

function contextOf(authInfo: AuthInfo | undefined): RequestContext {
  const value = authInfo?.extra?.[CONTEXT_KEY];
  if (typeof value !== 'object' || value === null || !('caller' in value) || !('correlationId' in value)) {
    // Every request passes through the controller, which always sets the context.
    throw new Error('MCP request without a request context');
  }
  return value as RequestContext;
}

/**
 * Builds a fresh `McpServer` per HTTP request (ADR 0003): only the tools the
 * caller's catalogue grants are registered, so the tool list is per caller and
 * a call to any other tool is an unknown tool. Nothing survives the request (NFR-3).
 */
export function createServerFactory(deps: { catalog: ToolCatalog; audit: AuditLog }): McpServerFactory {
  return ({ authInfo }) => {
    const { caller, correlationId } = contextOf(authInfo);
    const server = new McpServer(SERVER_INFO);
    for (const tool of deps.catalog.toolsFor(caller)) {
      server.registerTool(tool.name, { description: tool.description, inputSchema: tool.inputSchema }, (args, ctx) => {
        // The 2026-07-28 envelope carries the client's self-declared name (absent on
        // 2025-era requests). It is unverified, so it is audited as a detail only.
        const clientName = declaredClientName(ctx.mcpReq.envelope);
        return auditedTool(tool, {
          audit: deps.audit,
          caller,
          correlationId,
          ...(clientName === undefined ? {} : { declaredClientName: clientName }),
          newId: randomUUID,
          now: () => performance.now(),
        })(args);
      });
    }
    return server;
  };
}
