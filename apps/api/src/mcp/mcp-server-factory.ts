import { CLIENT_INFO_META_KEY, Server, type AuthInfo, type McpServerFactory } from '@modelcontextprotocol/server';
import type { Caller } from '@aiops/core';
import { callTool, listTools, type PipelineDeps, type PipelineRequest } from './tool-pipeline.js';

export const SERVER_INFO = { name: 'aiops', version: '0.0.0' } as const;

/** What the controller hands to the per-request factory through `authInfo.extra`. */
export interface RequestContext {
  readonly caller: Caller;
  readonly correlationId: string;
}

const CONTEXT_KEY = 'aiops/request';

/** The SDK sees no token: the caller travels in `extra`, the token field stays empty (AUTH-7). */
export function authInfoFor(context: RequestContext, expiresAt: number | undefined): AuthInfo {
  return {
    token: '',
    clientId: context.caller.clientId ?? '',
    scopes: [],
    ...(expiresAt === undefined ? {} : { expiresAt }),
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
 * Builds a fresh low-level `Server` per HTTP request (ADR 0003, ADR 0016) whose
 * `tools/list` and `tools/call` handlers are `api`'s own, so every rejection is
 * audited. The configuration snapshot is taken once per request. Nothing
 * survives the request (NFR-3).
 */
export function createServerFactory(deps: PipelineDeps): McpServerFactory {
  return ({ authInfo }) => {
    const { caller, correlationId } = contextOf(authInfo);
    const snapshot = deps.snapshot();
    const server = new Server(SERVER_INFO, { capabilities: { tools: { listChanged: false } } });
    const request = (envelope: object | undefined): PipelineRequest => {
      const name = declaredClientName(envelope);
      return { caller, correlationId, snapshot, ...(name === undefined ? {} : { declaredClientName: name }) };
    };
    server.setRequestHandler('tools/list', async (_req, ctx) => ({ tools: await listTools(deps, request(ctx.mcpReq.envelope)) }));
    server.setRequestHandler('tools/call', async (req, ctx) =>
      server.projectCallToolResult(await callTool(deps, request(ctx.mcpReq.envelope), req.params.name, req.params.arguments), undefined),
    );
    return server;
  };
}
