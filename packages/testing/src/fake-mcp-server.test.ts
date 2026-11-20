import { afterEach, describe, expect, it } from 'vitest';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { startFakeMcpServer, type FakeMcpServer, type FakeMcpTool } from './fake-mcp-server.js';

const echo: FakeMcpTool = {
  name: 'echo',
  description: 'Echo the text.',
  inputSchema: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] },
  _meta: { origin: 'fake' },
  respond: (args) => ({ content: [{ type: 'text', text: `echo ${String(args.text)}` }] }),
};

const started: FakeMcpServer[] = [];
afterEach(async () => {
  await Promise.all(started.splice(0).map((s) => s.close()));
});

async function connect(server: FakeMcpServer): Promise<Client> {
  const client = new Client({ name: 'test', version: '0.0.0' });
  await client.connect(new StreamableHTTPClientTransport(new URL(server.url)));
  return client;
}

describe.each(['stateless', 'legacy-stateful'] as const)('CONN-1 fake MCP server (%s)', (mode) => {
  const start = async (extra: { control?: boolean; responseMode?: 'json' | 'sse' } = {}): Promise<FakeMcpServer> => {
    const server = await startFakeMcpServer({ tools: [echo], mode, ...extra });
    started.push(server);
    return server;
  };

  it('lists the tools with description and _meta and returns respond’s result', async () => {
    const server = await start();
    const client = await connect(server);
    const listed = await client.listTools();
    expect(listed.tools.map((t) => [t.name, t.description, t._meta])).toEqual([['echo', 'Echo the text.', { origin: 'fake' }]]);
    const result = await client.callTool({ name: 'echo', arguments: { text: 'hi' } });
    expect(result.content).toEqual([{ type: 'text', text: 'echo hi' }]);
    await client.close();
  });

  it('answers over SSE when responseMode is sse', async () => {
    const server = await start({ responseMode: 'sse' });
    const client = await connect(server);
    expect((await client.listTools()).tools).toHaveLength(1);
    await client.close();
  });

  it('CONN-4 updateTool changes the description on the next list', async () => {
    const server = await start();
    const client = await connect(server);
    server.updateTool('echo', { description: 'Changed.' });
    expect((await client.listTools()).tools[0]?.description).toBe('Changed.');
    server.setTools([{ name: 'other', inputSchema: { type: 'object' } }]);
    expect((await client.listTools()).tools.map((t) => t.name)).toEqual(['other']);
    await client.close();
  });

  it('failNext(503, 1) fails exactly the next POST and records requests', async () => {
    const server = await start();
    const post = (): Promise<Response> =>
      fetch(server.url, {
        method: 'POST',
        headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', 'x-probe': 'yes' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
      });
    server.failNext(503, 1);
    expect((await post()).status).toBe(503);
    expect((await post()).status).not.toBe(503);
    expect(server.requests.map((r) => [r.httpMethod, r.rpcMethod])).toEqual([
      ['POST', 'tools/list'],
      ['POST', 'tools/list'],
    ]);
    expect(server.requests[0]?.headers['x-probe']).toBe('yes');
  });

  it('control endpoint patches a tool and answers 204', async () => {
    const server = await start({ control: true });
    const base = new URL(server.url).origin;
    const res = await fetch(`${base}/_control/tools/echo`, { method: 'POST', body: JSON.stringify({ description: 'x' }) });
    expect(res.status).toBe(204);
    const client = await connect(server);
    expect((await client.listTools()).tools[0]?.description).toBe('x');
    await client.close();
    const missing = await fetch(`${base}/_control/tools/nope`, { method: 'POST', body: '{}' });
    expect(missing.status).toBe(404);
  });

  it('EXE-4 control endpoint lists the recorded requests with the called tool', async () => {
    const server = await start({ control: true });
    const client = await connect(server);
    await client.listTools();
    await client.callTool({ name: 'echo', arguments: { text: 'secret text' } });
    await client.close();
    expect(server.requests.filter((r) => r.rpcMethod === 'tools/call').map((r) => r.tool)).toEqual(['echo']);
    const res = await fetch(`${new URL(server.url).origin}/_control/requests`);
    expect(res.status).toBe(200);
    const listed = (await res.json()) as { rpcMethod?: string; tool?: string }[];
    expect(listed.filter((r) => r.rpcMethod === 'tools/call')).toEqual([{ rpcMethod: 'tools/call', tool: 'echo' }]);
    expect(listed.filter((r) => r.rpcMethod === 'tools/list')).toEqual([{ rpcMethod: 'tools/list' }]);
    // Only the method and the tool name: no headers, no arguments.
    expect(JSON.stringify(listed)).not.toContain('secret text');
    expect(listed.every((r) => Object.keys(r).every((k) => k === 'rpcMethod' || k === 'tool'))).toBe(true);
  });
});
