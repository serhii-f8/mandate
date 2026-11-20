// MCP client for the acceptance scripts: the v2 client pinned to protocol 2026-07-28.
// Prints one JSON line and records the correlation ID of the last response.
//
//   mcp-call.mjs <mcp-url> [message] [--token T]
//       calls `ping`, fails unless it answers `pong: <message>`  → {"correlationId","text"}
//   mcp-call.mjs <mcp-url> --token T --list                      → {"correlationId","tools":[...]}
//   mcp-call.mjs <mcp-url> --token T --describe NAME             → {"correlationId","tool":<the listed definition or null>}
//   mcp-call.mjs <mcp-url> --token T --tool NAME --args JSON     → {"correlationId","text","isError","content","contentTypes","structuredContent"}
//       `text` joins every text part; `content` lists them one by one (MCP-4: summary first);
//       `contentTypes` lists the type of every part (an image part has no text).
// The token comes from AIOPS_MCP_TOKEN (preferred: argv shows in `ps`, SEC-3) or from --token.
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';

const positional = [];
const flags = {};
const argv = process.argv.slice(2);
for (let i = 0; i < argv.length; i++) {
  const arg = argv[i];
  if (arg === '--list') flags.list = true;
  else if (arg.startsWith('--')) flags[arg.slice(2)] = argv[++i];
  else positional.push(arg);
}
const [url, message = 'acceptance'] = positional;
const token = flags.token ?? (process.env.AIOPS_MCP_TOKEN || undefined);
if (url === undefined) {
  console.error('usage: [AIOPS_MCP_TOKEN=T] mcp-call.mjs <mcp-url> [message] [--token T] [--list | --describe NAME | --tool NAME --args JSON]');
  process.exit(2);
}

let lastCorrelationId;
const recordingFetch = async (input, init) => {
  const headers = new Headers(init?.headers);
  if (token) headers.set('authorization', `Bearer ${token}`);
  const response = await fetch(input, { ...init, headers });
  const id = response.headers.get('x-correlation-id');
  if (id !== null) lastCorrelationId = id;
  return response;
};

const client = new Client({ name: 'aiops-acceptance', version: '1.0.0' }, { versionNegotiation: { mode: { pin: '2026-07-28' } } });
await client.connect(new StreamableHTTPClientTransport(new URL(url), { fetch: recordingFetch }));
const textOf = (result) => (result.content ?? []).map((c) => c.text ?? '').join('');

if (flags.list) {
  const tools = await client.listTools();
  await client.close();
  console.log(JSON.stringify({ correlationId: lastCorrelationId, tools: tools.tools.map((t) => t.name) }));
} else if (flags.describe) {
  const tools = await client.listTools();
  await client.close();
  console.log(JSON.stringify({ correlationId: lastCorrelationId, tool: tools.tools.find((t) => t.name === flags.describe) ?? null }));
} else if (flags.tool) {
  const result = await client.callTool({ name: flags.tool, arguments: JSON.parse(flags.args ?? '{}') });
  await client.close();
  console.log(
    JSON.stringify({
      correlationId: lastCorrelationId,
      text: textOf(result),
      isError: result.isError === true,
      content: (result.content ?? []).map((c) => c.text ?? ''),
      contentTypes: (result.content ?? []).map((c) => c.type),
      ...(result.structuredContent === undefined ? {} : { structuredContent: result.structuredContent }),
    }),
  );
} else {
  const tools = await client.listTools();
  if (!tools.tools.some((t) => t.name === 'ping')) throw new Error('ping is not in the tool list');
  const result = await client.callTool({ name: 'ping', arguments: { message } });
  await client.close();
  const text = textOf(result);
  if (result.isError === true || text !== `pong: ${message}`) throw new Error(`unexpected result: ${JSON.stringify(result)}`);
  console.log(JSON.stringify({ correlationId: lastCorrelationId, text }));
}
