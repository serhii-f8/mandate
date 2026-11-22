// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Mandate Authors
import { startFakeMcpServer } from './fake-mcp-server.js';

/**
 * Entry for the acceptance container: a read-like `lookup` and a write-like `create_note` tool,
 * mutable through POST /_control/tools/<name>; GET /_control/requests lists the calls received.
 */
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
    {
      name: 'create_note',
      title: 'Create note',
      description: 'Create a note with the given text.',
      inputSchema: { type: 'object', properties: { text: { type: 'string', description: 'The note text' } }, required: ['text'] },
      respond: () => ({ content: [{ type: 'text', text: 'note created' }] }),
    },
  ],
});
console.log(`fake MCP server listening on ${port}`);
