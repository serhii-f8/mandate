import { startFakeMcpServer } from './fake-mcp-server.js';

/** Entry for the acceptance container: one `lookup` tool, mutable through POST /_control/tools/<name>. */
const port = Number(process.env.PORT ?? '3002');
await startFakeMcpServer({
  host: '0.0.0.0',
  port,
  control: true,
  tools: [
    {
      name: 'lookup',
      title: 'Lookup',
      description: 'Look up a record by key.',
      inputSchema: { type: 'object', properties: { key: { type: 'string', description: 'The record key' } }, required: ['key'] },
      respond: (args) => {
        const key = typeof args.key === 'string' ? args.key : '';
        return { content: [{ type: 'text', text: `found ${key}` }], structuredContent: { key, found: true } };
      },
    },
  ],
});
console.log(`fake MCP server listening on ${port}`);
