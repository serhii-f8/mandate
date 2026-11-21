// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The AI Operations Layer Authors
/**
 * A Tasks-aware test client (MCP-7), as spike 1 proved it (ADR 0003, spikes/1-mcp-sdk/check.mjs):
 * `@modelcontextprotocol/client` 2.4.0 rejects `resultType: "task"`, so ext-tasks 0.2.3 sends
 * `tools/call` and `tasks/*` through a host-written raw dispatcher with the 2026-07-28 framing.
 */
import type { Client } from '@modelcontextprotocol/client';
import type { JsonValue } from '@modelcontextprotocol/ext-tasks/core';
import {
  createTaskSessionFromClient,
  type DispatchOptions,
  type JsonRpcResponse,
  type RawClientDispatch,
  type TaskEnabledSession,
} from '@modelcontextprotocol/ext-tasks/client';
import { MODERN } from './helpers.js';

const CLIENT_INFO = { name: 'aiops-e2e', version: '1.0.0' };

/** One request the raw dispatcher sent, with the instance that answered it. */
export interface WireEntry {
  readonly port: number;
  readonly method: string;
  readonly status: number;
  /** The `x-correlation-id` the api answered with. */
  readonly correlationId: string;
  readonly json: { result?: Record<string, unknown>; error?: { code: number; message: string } };
}

export interface TaskSessionOptions {
  readonly token: string;
  /** Base URLs of the api instances; every raw request goes to the next one. */
  readonly baseUrls: readonly string[];
  /** Receives one entry per raw request. */
  readonly wire: WireEntry[];
}

/** `value[key]` when it is a string; the request is a JSON-RPC object built by ext-tasks. */
function stringField(value: JsonValue | undefined, key: string): string | undefined {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const found = (value as Record<string, JsonValue>)[key];
  return typeof found === 'string' ? found : undefined;
}

function objectField(value: JsonValue, key: string): JsonValue | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, JsonValue>)[key] : undefined;
}

/** The raw dispatcher: Streamable HTTP POSTs with the spec headers, rotating across `baseUrls`. */
export function rawDispatchFor(options: TaskSessionOptions): RawClientDispatch {
  let next = 0;
  let id = 1000;
  return async (request: JsonValue, dispatch: DispatchOptions = {}): Promise<JsonRpcResponse> => {
    const base = options.baseUrls[next++ % options.baseUrls.length] ?? '';
    const method = stringField(request, 'method') ?? '';
    const params = objectField(request, 'params');
    const name = stringField(params, 'name') ?? stringField(params, 'taskId');
    // A Headers object, so the `Mcp-Name` ext-tasks puts in the context replaces ours instead of
    // being sent twice under another case.
    const headers = new Headers(dispatch.context?.headers ?? {});
    headers.set('content-type', 'application/json');
    headers.set('accept', 'application/json, text/event-stream');
    headers.set('authorization', `Bearer ${options.token}`);
    headers.set('mcp-protocol-version', MODERN);
    headers.set('mcp-method', method);
    if (name !== undefined && !headers.has('mcp-name')) headers.set('mcp-name', name);
    const body = JSON.stringify({ jsonrpc: '2.0', id: id++, ...(request as Record<string, JsonValue>) });
    const response = await fetch(new URL('/mcp', base), {
      method: 'POST',
      headers,
      body,
      ...(dispatch.signal === undefined ? {} : { signal: dispatch.signal }),
    });
    const json = (await response.json()) as WireEntry['json'];
    options.wire.push({
      port: Number(new URL(base).port),
      method,
      status: response.status,
      correlationId: response.headers.get('x-correlation-id') ?? '',
      json,
    });
    if (json.error !== undefined) return { kind: 'error', error: json.error };
    return { kind: 'result', result: (json.result ?? {}) as JsonValue };
  };
}

/**
 * A task-enabled session over a connected 2026-07-28 `client`. `close()` sends `tasks/cancel` for
 * every execution that has not settled, so settle (or hand off) an execution before closing.
 */
export function taskSession(client: Client, options: TaskSessionOptions): TaskEnabledSession {
  return createTaskSessionFromClient(client, {
    // One logical endpoint served by every instance.
    endpointId: 'aiops-e2e',
    rawDispatch: rawDispatchFor(options),
    v2RequestFraming: { protocolVersion: MODERN, clientInfo: CLIENT_INFO, clientCapabilities: {} },
  });
}
