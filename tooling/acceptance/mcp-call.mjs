// Calls the `ping` tool on a running MCP endpoint with the v2 client pinned to
// protocol 2026-07-28 and prints {"correlationId", "text"} as one JSON line.
// Usage: node tooling/acceptance/mcp-call.mjs http://127.0.0.1:8400/mcp [message]
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';

const [url, message = 'acceptance'] = process.argv.slice(2);
if (url === undefined) {
  console.error('usage: mcp-call.mjs <mcp-url> [message]');
  process.exit(2);
}

let lastCorrelationId;
const recordingFetch = async (input, init) => {
  const response = await fetch(input, init);
  const id = response.headers.get('x-correlation-id');
  if (id !== null) lastCorrelationId = id;
  return response;
};

const client = new Client({ name: 'aiops-acceptance', version: '1.0.0' }, { versionNegotiation: { mode: { pin: '2026-07-28' } } });
await client.connect(new StreamableHTTPClientTransport(new URL(url), { fetch: recordingFetch }));
const tools = await client.listTools();
if (!tools.tools.some((t) => t.name === 'ping')) throw new Error('ping is not in the tool list');
const result = await client.callTool({ name: 'ping', arguments: { message } });
await client.close();
const text = (result.content ?? []).map((c) => c.text ?? '').join('');
if (result.isError === true || text !== `pong: ${message}`) throw new Error(`unexpected result: ${JSON.stringify(result)}`);
console.log(JSON.stringify({ correlationId: lastCorrelationId, text }));
