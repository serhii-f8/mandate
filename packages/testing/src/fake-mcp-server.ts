import { randomUUID } from 'node:crypto';
import { createServer, type IncomingMessage, type Server as HttpServer, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { createMcpHandler, Server, type CallToolResult } from '@modelcontextprotocol/server';
import { NodeStreamableHTTPServerTransport, toNodeHandler } from '@modelcontextprotocol/node';

/** One tool of the fake MCP server, as a real server would list it. */
export interface FakeMcpTool {
  name: string;
  title?: string;
  description?: string;
  inputSchema: Record<string, unknown>;
  outputSchema?: Record<string, unknown>;
  annotations?: Record<string, unknown>;
  _meta?: Record<string, unknown>;
  /** The tools/call result; default { content: [{ type: 'text', text: 'ok' }] }. */
  respond?: (args: Record<string, unknown>) => Record<string, unknown> | Promise<Record<string, unknown>>;
}

/** One HTTP request as the fake MCP server saw it. Header names are lower-case. */
export interface RecordedMcpRequest {
  readonly httpMethod: string;
  readonly rpcMethod?: string;
  /** `params.name` of a `tools/call`. */
  readonly tool?: string;
  readonly headers: Readonly<Record<string, string>>;
}

export interface FakeMcpServer {
  /** `http://<host>:<port>/mcp` */
  readonly url: string;
  readonly port: number;
  readonly requests: readonly RecordedMcpRequest[];
  setTools(tools: readonly FakeMcpTool[]): void;
  updateTool(name: string, patch: Partial<Omit<FakeMcpTool, 'name'>>): void;
  /** The next `count` POST requests answer `status` with an empty body (retry tests). */
  failNext(status: number, count: number): void;
  close(): Promise<void>;
}

export interface FakeMcpServerOptions {
  tools: readonly FakeMcpTool[];
  mode?: 'stateless' | 'legacy-stateful';
  responseMode?: 'json' | 'sse';
  host?: string;
  port?: number;
  /**
   * Serves POST /_control/tools/<name> (JSON patch -> 204) and GET /_control/requests
   * (`[{ rpcMethod?, tool? }]`, no headers or arguments) for the acceptance container.
   */
  control?: boolean;
}

const DEFAULT_RESULT: Record<string, unknown> = { content: [{ type: 'text', text: 'ok' }] };
/** The adapters type `method` and `url` as required; a Node server request always has both. */
type NodeRequest = IncomingMessage & { method: string; url: string };
const CONTROL_PREFIX = '/_control/tools/';
const CONTROL_REQUESTS = '/_control/requests';

function flattenHeaders(req: IncomingMessage): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(req.headers)) {
    if (v !== undefined) out[k] = Array.isArray(v) ? v.join(', ') : v;
  }
  return out;
}

async function readBody(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString('utf8');
}

function parseJson(text: string): unknown {
  try {
    return text.length === 0 ? undefined : (JSON.parse(text) as unknown);
  } catch {
    return undefined;
  }
}

function firstMessage(body: unknown): Record<string, unknown> | undefined {
  const first: unknown = Array.isArray(body) ? body[0] : body;
  return typeof first === 'object' && first !== null ? (first as Record<string, unknown>) : undefined;
}

function rpcMethodOf(body: unknown): string | undefined {
  const method: unknown = firstMessage(body)?.method;
  return typeof method === 'string' ? method : undefined;
}

/** The tool name of a `tools/call` request. */
function toolOf(body: unknown): string | undefined {
  if (rpcMethodOf(body) !== 'tools/call') return undefined;
  const params: unknown = firstMessage(body)?.params;
  if (typeof params !== 'object' || params === null) return undefined;
  const name: unknown = (params as Record<string, unknown>).name;
  return typeof name === 'string' ? name : undefined;
}

/** An MCP server over Streamable HTTP with a mutable tool list, for adapter tests and the acceptance container. */
export async function startFakeMcpServer(options: FakeMcpServerOptions): Promise<FakeMcpServer> {
  const mode = options.mode ?? 'stateless';
  const responseMode = options.responseMode ?? 'json';
  const host = options.host ?? '127.0.0.1';
  let tools: FakeMcpTool[] = options.tools.map((t) => ({ ...t }));
  const requests: RecordedMcpRequest[] = [];
  const failures: number[] = [];

  /** A low-level `Server` (as `apps/api` builds) that lists and calls the current tools. */
  // `Server` is deprecated for ordinary use; owning tools/* handlers is the advanced use it keeps (ADR 0016).
  /* eslint-disable @typescript-eslint/no-deprecated */
  const buildServer = (): Server => {
    const server = new Server({ name: 'fake-mcp', version: '0.0.0' }, { capabilities: { tools: { listChanged: false } } });
    server.setRequestHandler('tools/list', () => ({
      tools: tools.map((t) => {
        const definition: Record<string, unknown> = { ...t };
        delete definition.respond;
        return definition;
      }) as never,
    }));
    server.setRequestHandler('tools/call', async (req) => {
      const tool = tools.find((t) => t.name === req.params.name);
      if (tool === undefined) return { content: [{ type: 'text', text: `unknown tool ${req.params.name}` }], isError: true };
      const result = tool.respond === undefined ? DEFAULT_RESULT : await tool.respond(req.params.arguments ?? {});
      return result as unknown as CallToolResult;
    });
    return server;
  };
  /* eslint-enable @typescript-eslint/no-deprecated */

  const sessions = new Map<string, NodeStreamableHTTPServerTransport>();
  const statelessNode = toNodeHandler(createMcpHandler(() => buildServer(), { legacy: 'stateless', responseMode }));

  const serveLegacy = async (req: NodeRequest, res: ServerResponse, body: unknown): Promise<void> => {
    const header = req.headers['mcp-session-id'];
    const id = Array.isArray(header) ? header[0] : header;
    let transport = id === undefined ? undefined : sessions.get(id);
    if (transport === undefined) {
      if (id !== undefined || req.method !== 'POST' || rpcMethodOf(body) !== 'initialize') {
        res.writeHead(id === undefined ? 400 : 404, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ jsonrpc: '2.0', error: { code: -32000, message: 'no valid session' }, id: null }));
        return;
      }
      const created = new NodeStreamableHTTPServerTransport({
        sessionIdGenerator: () => randomUUID(),
        enableJsonResponse: responseMode === 'json',
        onsessioninitialized: (sid) => {
          sessions.set(sid, created);
        },
      });
      created.onclose = () => {
        if (created.sessionId !== undefined) sessions.delete(created.sessionId);
      };
      await buildServer().connect(created);
      transport = created;
    }
    await transport.handleRequest(req, res, body);
  };

  const handle = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    const url = new URL(req.url ?? '/', 'http://fake');
    const text = req.method === 'POST' || req.method === 'PUT' ? await readBody(req) : '';

    if (options.control === true && req.method === 'POST' && url.pathname.startsWith(CONTROL_PREFIX)) {
      const name = decodeURIComponent(url.pathname.slice(CONTROL_PREFIX.length));
      const patch = parseJson(text);
      if (typeof patch !== 'object' || patch === null || !tools.some((t) => t.name === name)) {
        res.writeHead(404).end();
        return;
      }
      server.updateTool(name, patch);
      res.writeHead(204).end();
      return;
    }
    if (options.control === true && req.method === 'GET' && url.pathname === CONTROL_REQUESTS) {
      const listed = requests.map((r) => ({
        ...(r.rpcMethod === undefined ? {} : { rpcMethod: r.rpcMethod }),
        ...(r.tool === undefined ? {} : { tool: r.tool }),
      }));
      res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(listed));
      return;
    }
    if (url.pathname !== '/mcp') {
      res.writeHead(404).end();
      return;
    }

    const body = parseJson(text);
    const rpcMethod = rpcMethodOf(body);
    const tool = toolOf(body);
    requests.push({
      httpMethod: req.method ?? '',
      ...(rpcMethod === undefined ? {} : { rpcMethod }),
      ...(tool === undefined ? {} : { tool }),
      headers: flattenHeaders(req),
    });

    if (req.method === 'POST') {
      const status = failures.shift();
      if (status !== undefined) {
        res.writeHead(status).end();
        return;
      }
    }
    const nodeReq = req as NodeRequest;
    if (mode === 'legacy-stateful') await serveLegacy(nodeReq, res, body);
    else await statelessNode(nodeReq, res, body);
  };

  const http: HttpServer = createServer((req, res) => {
    handle(req, res).catch(() => {
      if (!res.headersSent) res.writeHead(500);
      res.end();
    });
  });
  await new Promise<void>((resolve, reject) => {
    http.once('error', reject);
    http.listen(options.port ?? 0, host, resolve);
  });
  const port = (http.address() as AddressInfo).port;

  const server: FakeMcpServer = {
    url: `http://${host}:${port}/mcp`,
    port,
    requests,
    setTools(next) {
      tools = next.map((t) => ({ ...t }));
    },
    updateTool(name, patch) {
      tools = tools.map((t) => (t.name === name ? { ...t, ...patch } : t));
    },
    failNext(status, count) {
      for (let i = 0; i < count; i += 1) failures.push(status);
    },
    async close() {
      await Promise.all([...sessions.values()].map((t) => t.close().catch(() => undefined)));
      http.closeAllConnections();
      await new Promise<void>((resolve) => {
        http.close(() => {
          resolve();
        });
      });
    },
  };
  return server;
}
