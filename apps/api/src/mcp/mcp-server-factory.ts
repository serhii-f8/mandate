import { CLIENT_INFO_META_KEY, Server, type AuthInfo, type McpServerFactory } from '@modelcontextprotocol/server';
import { z } from 'zod';
import type { Caller } from '@aiops/core';
import { declaresTasks, TASKS_EXTENSION } from './tasks/extension.js';
import { createTaskHandlers, type TaskHandlerDeps, type TaskRequestContext } from './tasks/task-handlers.js';
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

/** Task request params: loose, so `_meta` and future fields pass through to no effect. */
const TASK_PARAMS = z.looseObject({ taskId: z.string() });
const TASK_UPDATE_PARAMS = z.looseObject({ taskId: z.string(), inputResponses: z.record(z.string(), z.unknown()).optional() });

/**
 * Builds a fresh low-level `Server` per HTTP request (ADR 0003, ADR 0016) whose
 * `tools/list` and `tools/call` handlers are `api`'s own, so every rejection is
 * audited. The configuration snapshot is taken once per request. Nothing
 * survives the request (NFR-3). It advertises the Tasks extension in
 * `server/discover` and serves `tasks/get|update|cancel` (MCP-7, ADR 0029).
 */
export function createServerFactory(deps: PipelineDeps, tasks: TaskHandlerDeps): McpServerFactory {
  const handlers = createTaskHandlers(tasks);
  return ({ authInfo }) => {
    const { caller, correlationId } = contextOf(authInfo);
    const snapshot = deps.snapshot();
    // `Server` is deprecated for ordinary use in favour of `McpServer`; owning the
    // tools/* handlers so every rejection is audited is the advanced use it keeps (ADR 0016).
    // eslint-disable-next-line @typescript-eslint/no-deprecated
    const server = new Server(SERVER_INFO, { capabilities: { tools: { listChanged: false }, extensions: { [TASKS_EXTENSION]: {} } } });
    const request = (envelope: object | undefined): PipelineRequest => {
      const name = declaredClientName(envelope);
      return { caller, correlationId, snapshot, ...(name === undefined ? {} : { declaredClientName: name }) };
    };
    server.setRequestHandler('tools/list', async (_req, ctx) => ({ tools: await listTools(deps, request(ctx.mcpReq.envelope)) }));
    server.setRequestHandler('tools/call', async (req, ctx) =>
      server.projectCallToolResult(await callTool(deps, request(ctx.mcpReq.envelope), req.params.name, req.params.arguments), undefined),
    );
    // The 3-argument (custom-schema) form: on 2026-07-28, `tasks/get` and `tasks/cancel` are
    // extension methods, which the SDK dispatches only when registered this way (ADR 0029).
    const taskContext = (envelope: object | undefined): TaskRequestContext => ({ caller, correlationId, declared: declaresTasks(envelope) });
    // Spread into an object literal: the SDK's result type has an index signature an interface lacks.
    server.setRequestHandler('tasks/get', { params: TASK_PARAMS }, async (params, ctx) => ({ ...(await handlers.get(params, taskContext(ctx.mcpReq.envelope))) }));
    server.setRequestHandler('tasks/update', { params: TASK_UPDATE_PARAMS }, (params, ctx) => handlers.update(params, taskContext(ctx.mcpReq.envelope)));
    server.setRequestHandler('tasks/cancel', { params: TASK_PARAMS }, (params, ctx) => handlers.cancel(params, taskContext(ctx.mcpReq.envelope)));
    return server;
  };
}
