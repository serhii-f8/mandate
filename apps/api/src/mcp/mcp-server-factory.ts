// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Mandate Authors
import { CLIENT_INFO_META_KEY, Server, type AuthInfo, type CallToolResult, type McpServerFactory } from '@modelcontextprotocol/server';
import { z } from 'zod';
import type { Caller } from '@mandate/core';
import { declaresTasks, TASKS_EXTENSION } from './tasks/extension.js';
import { listResources, readResource } from './resources.js';
import { createTaskHandlers, type TaskHandlerDeps, type TaskRequestContext } from './tasks/task-handlers.js';
import { isTaskAnswer } from './tasks/task-result.js';
import { callTool, listTools, type PipelineDeps, type PipelineRequest } from './tool-pipeline.js';

export const SERVER_INFO = { name: 'mandate', version: '0.0.0' } as const;

/** What the controller hands to the per-request factory through `authInfo.extra`. */
export interface RequestContext {
  readonly caller: Caller;
  readonly correlationId: string;
}

const CONTEXT_KEY = 'mandate/request';

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
 * Task request params: loose, so `_meta` and future fields pass through to no effect. `tasks/update`
 * uses the same schema: the SDK exposes a request's `inputResponses` as `ctx.mcpReq.inputResponses`,
 * and no input request is ever outstanding, so neither is read.
 */
const TASK_PARAMS = z.looseObject({ taskId: z.string() });

/**
 * Builds a fresh low-level `Server` per HTTP request (ADR 0003, ADR 0016) whose
 * `tools/list` and `tools/call` handlers are `api`'s own, so every rejection is
 * audited. The configuration snapshot is taken once per request. Nothing
 * survives the request (NFR-3). It advertises the Tasks extension in
 * `server/discover` and serves `tasks/get|update|cancel` (MCP-7, ADR 0029), and the widget
 * bundles as UI resources (MCP-5).
 */
export function createServerFactory(deps: PipelineDeps, tasks: TaskHandlerDeps): McpServerFactory {
  const handlers = createTaskHandlers(tasks);
  return ({ authInfo }) => {
    const { caller, correlationId } = contextOf(authInfo);
    const snapshot = deps.snapshot();
    // `Server` is deprecated for ordinary use in favour of `McpServer`; owning the
    // tools/* handlers so every rejection is audited is the advanced use it keeps (ADR 0016).
    // eslint-disable-next-line @typescript-eslint/no-deprecated
    const server = new Server(SERVER_INFO, {
      capabilities: { tools: { listChanged: false }, resources: { listChanged: false }, extensions: { [TASKS_EXTENSION]: {} } },
    });
    const request = (envelope: object | undefined): PipelineRequest => {
      const name = declaredClientName(envelope);
      return { caller, correlationId, snapshot, tasks: declaresTasks(envelope), ...(name === undefined ? {} : { declaredClientName: name }) };
    };
    server.setRequestHandler('tools/list', async (_req, ctx) => ({ tools: await listTools(deps, request(ctx.mcpReq.envelope)) }));
    server.setRequestHandler('tools/call', async (req, ctx) => {
      const answer = await callTool(deps, request(ctx.mcpReq.envelope), req.params.name, req.params.arguments);
      // `projectCallToolResult` takes a CallToolResult, and a task answer is not one, so it is returned as it is
      // (ADR 0003, ADR 0029). SDK 2.4.0: `stampResultType` lets resultType 'task' pass on tools/call; the wrapper
      // still adds an empty `content` (normalizeContentlessToolResult). The handler's declared result type has no
      // task variant, hence the cast.
      return isTaskAnswer(answer) ? (answer as unknown as CallToolResult) : server.projectCallToolResult(answer, undefined);
    });
    // UI resources (MCP-5): the bundles hold no data, so they are the same for every caller and are not
    // audited (ADR 0035); the controller's bearer check still guards them. SDK 2.4.0 refuses these
    // handlers unless `capabilities.resources` is declared (assertRequestHandlerCapability).
    server.setRequestHandler('resources/list', () => listResources(deps.widgets));
    server.setRequestHandler('resources/read', (req) => readResource(deps.widgets, req.params.uri));
    server.setRequestHandler('resources/templates/list', () => ({ resourceTemplates: [] }));
    // The 3-argument (custom-schema) form: on 2026-07-28, `tasks/get` and `tasks/cancel` are
    // extension methods, which the SDK dispatches only when registered this way (ADR 0029).
    const taskContext = (envelope: object | undefined): TaskRequestContext => ({ caller, correlationId, declared: declaresTasks(envelope) });
    // Spread into an object literal: the SDK's result type has an index signature an interface lacks.
    server.setRequestHandler('tasks/get', { params: TASK_PARAMS }, async (params, ctx) => ({ ...(await handlers.get(params, taskContext(ctx.mcpReq.envelope))) }));
    server.setRequestHandler('tasks/update', { params: TASK_PARAMS }, (params, ctx) => handlers.update(params, taskContext(ctx.mcpReq.envelope)));
    server.setRequestHandler('tasks/cancel', { params: TASK_PARAMS }, (params, ctx) => handlers.cancel(params, taskContext(ctx.mcpReq.envelope)));
    return server;
  };
}
