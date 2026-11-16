// Spike 1 — stateless MCP server (protocol 2026-07-28) on plain node:http.
//
// - One Streamable HTTP endpoint at /mcp, served by createMcpHandler from
//   @modelcontextprotocol/server 2.4.0 (modern era only: legacy: 'reject').
// - A fresh McpServer is built per HTTP request by the factory, from the
//   caller's AuthInfo, so the tool list is per user (MCP-2).
// - Bearer token check happens before the MCP handler; unknown/missing -> 401.
// - slow_export returns a Tasks-extension CreateTaskResult (resultType "task").
//   Task state lives in JSON files under TASK_DIR, shared by every process,
//   so tasks/get can be served by any instance (NFR-3).
import { createServer } from 'node:http';
import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import * as z from 'zod/v4';
import {
  McpServer,
  OAuthError,
  OAuthErrorCode,
  ProtocolError,
  createMcpHandler,
  requireBearerAuth,
} from '@modelcontextprotocol/server';
import { localhostHostValidation, localhostOriginValidation, toNodeHandler } from '@modelcontextprotocol/node';

const PORT = Number(process.env.PORT ?? 4101);
const TASK_DIR = process.env.TASK_DIR ?? new URL('./.task-state/', import.meta.url).pathname;
const INSTANCE = `instance-${PORT}`;
const TASKS_EXT = 'io.modelcontextprotocol/tasks';
const SLOW_EXPORT_MS = 3000;

// ---- identity: two fake bearer tokens --------------------------------------
const USERS = {
  'alice-token': { user: 'alice', tools: ['search_products', 'slow_export'] },
  'bob-token': { user: 'bob', tools: ['list_orders'] },
};

const verifier = {
  async verifyAccessToken(token) {
    const entry = USERS[token];
    if (!entry) throw new OAuthError(OAuthErrorCode.InvalidToken, 'unknown token');
    return {
      token,
      clientId: 'spike-client',
      scopes: [],
      expiresAt: Math.floor(Date.now() / 1000) + 3600,
      extra: { user: entry.user, tools: entry.tools },
    };
  },
};
const gate = requireBearerAuth({ verifier });

// ---- task store: one JSON file per task, shared across processes -----------
await mkdir(TASK_DIR, { recursive: true });
const taskPath = (id) => join(TASK_DIR, `${id}.json`);
async function saveTask(task) {
  const tmp = `${taskPath(task.taskId)}.${process.pid}.${randomUUID()}.tmp`;
  await writeFile(tmp, JSON.stringify(task));
  await rename(tmp, taskPath(task.taskId)); // atomic replace
}
async function loadTask(id) {
  if (!/^[0-9a-f-]{36}$/.test(id)) return undefined;
  try {
    return JSON.parse(await readFile(taskPath(id), 'utf8'));
  } catch {
    return undefined;
  }
}

function clientDeclaredTasks(ctx) {
  const caps = ctx.mcpReq.envelope?.['io.modelcontextprotocol/clientCapabilities'];
  return Boolean(caps?.extensions?.[TASKS_EXT]);
}
function missingTasksCapability() {
  // -32021 Missing Required Client Capability (ext-tasks spec, 2026-07-28)
  return new ProtocolError(-32021, 'Missing required client capability', {
    requiredCapabilities: { extensions: { [TASKS_EXT]: {} } },
  });
}

// Public view of a stored task (strip the private owner field).
function taskView(t) {
  const { owner, ...pub } = t;
  return pub;
}

// ---- tool catalogue ---------------------------------------------------------
const TOOL_DEFS = {
  search_products: {
    config: {
      description: 'Search products by text (spike fake).',
      inputSchema: z.object({ query: z.string() }),
    },
    handler: (user) => async ({ query }) => ({
      content: [{ type: 'text', text: `products for "${query}" (user ${user}, ${INSTANCE})` }],
      structuredContent: { items: [{ sku: 'SKU-1', name: `match for ${query}` }] },
    }),
  },
  list_orders: {
    config: {
      description: 'List recent orders (spike fake).',
      inputSchema: z.object({}),
    },
    handler: (user) => async () => ({
      content: [{ type: 'text', text: `orders for ${user} (${INSTANCE})` }],
      structuredContent: { orders: [{ id: 'O-1' }] },
    }),
  },
  slow_export: {
    config: {
      description: 'Export the catalogue; long-running, returns an MCP task handle.',
      inputSchema: z.object({ format: z.enum(['csv', 'json']) }),
    },
    handler: (user) => async ({ format }, ctx) => {
      if (!clientDeclaredTasks(ctx)) throw missingTasksCapability();
      const now = new Date().toISOString();
      const task = {
        taskId: randomUUID(),
        status: 'working',
        statusMessage: `export started on ${INSTANCE}`,
        createdAt: now,
        lastUpdatedAt: now,
        ttlMs: 600000,
        pollIntervalMs: 500,
        owner: user,
      };
      await saveTask(task); // durably created before the CreateTaskResult is returned
      // Work runs detached from the request. In the real system this is a
      // Temporal workflow; here a timer on the starting instance.
      setTimeout(async () => {
        const current = await loadTask(task.taskId);
        if (current?.status !== 'working') return; // cancelled meanwhile
        const done = {
          ...task,
          status: 'completed',
          statusMessage: `export finished on ${INSTANCE}`,
          lastUpdatedAt: new Date().toISOString(),
          // Exactly what a synchronous tools/call would have returned on
          // 2026-07-28, including the required resultType (ext-tasks 0.2.3's
          // CompleteCallToolResultV2Schema rejects the inner result without it).
          result: {
            resultType: 'complete',
            content: [{ type: 'text', text: `export.${format} ready (${user})` }],
            structuredContent: { url: `https://example.invalid/export/${task.taskId}.${format}`, rows: 42 },
            isError: false,
          },
        };
        await saveTask(done);
      }, SLOW_EXPORT_MS);
      return { resultType: 'task', ...taskView(task) };
    },
  },
};

// ---- per-request server factory --------------------------------------------
function buildServer({ authInfo }) {
  const user = authInfo?.extra?.user;
  const allowed = authInfo?.extra?.tools ?? [];
  const mcp = new McpServer(
    { name: 'spike-1-mcp-sdk', version: '0.0.0' },
    { capabilities: { extensions: { [TASKS_EXT]: {} } } },
  );
  for (const name of allowed) {
    const def = TOOL_DEFS[name];
    mcp.registerTool(name, def.config, def.handler(user));
  }

  // Tasks extension methods (not part of core 2026-07-28; registered as
  // custom-schema handlers, which the SDK's era gate admits for tasks/*).
  const TaskIdParams = z.object({ taskId: z.string() }).passthrough();
  const ownedTask = async (taskId, ctx) => {
    if (!clientDeclaredTasks(ctx)) throw missingTasksCapability();
    const t = await loadTask(taskId);
    // Auth binding: a task of another user is reported exactly like an unknown one.
    if (!t || t.owner !== user) throw new ProtocolError(-32602, 'Failed to retrieve task: Task not found');
    return t;
  };
  mcp.server.setRequestHandler('tasks/get', { params: TaskIdParams }, async ({ taskId }, ctx) => {
    const t = await ownedTask(taskId, ctx);
    return { resultType: 'complete', ...taskView(t), _meta: { 'spike/servedBy': INSTANCE } };
  });
  mcp.server.setRequestHandler('tasks/cancel', { params: TaskIdParams }, async ({ taskId }, ctx) => {
    const t = await ownedTask(taskId, ctx);
    if (t.status === 'working') {
      await saveTask({ ...t, status: 'cancelled', statusMessage: `cancelled via ${INSTANCE}`, lastUpdatedAt: new Date().toISOString() });
    }
    return { resultType: 'complete' };
  });
  mcp.server.setRequestHandler(
    'tasks/update',
    { params: z.object({ taskId: z.string(), inputResponses: z.record(z.string(), z.unknown()) }).passthrough() },
    async ({ taskId }, ctx) => {
      await ownedTask(taskId, ctx);
      return { resultType: 'complete' };
    },
  );
  return mcp;
}

const mcpHandler = createMcpHandler(buildServer, {
  legacy: 'reject',
  responseMode: 'json',
  onerror: (e) => console.error(`[${INSTANCE}] mcp error:`, e.message),
});

const authenticated = {
  fetch: async (request) => {
    const auth = await gate(request);
    if (auth instanceof Response) return auth; // 401 with WWW-Authenticate
    const response = await mcpHandler.fetch(request, { authInfo: auth });
    response.headers.set('x-spike-instance', INSTANCE);
    return response;
  },
};
const nodeHandler = toNodeHandler(authenticated);
// The handler validates neither Host nor Origin (spec: servers MUST validate
// Origin); guards from @modelcontextprotocol/node go in front of it.
const validateHost = localhostHostValidation();
const validateOrigin = localhostOriginValidation();

createServer((req, res) => {
  if (new URL(req.url, 'http://x').pathname !== '/mcp') {
    res.writeHead(404).end();
    return;
  }
  if (!validateHost(req, res) || !validateOrigin(req, res)) return;
  nodeHandler(req, res);
}).listen(PORT, '127.0.0.1', () => console.log(`[${INSTANCE}] listening on http://127.0.0.1:${PORT}/mcp, tasks in ${TASK_DIR}`));
