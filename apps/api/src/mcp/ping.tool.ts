import { z } from 'zod';
import type { ToolDefinition } from './tool-catalog.js';

const input = z.object({ message: z.string().max(200).optional() });

/** The one hard-coded tool of Phase 1: proves the endpoint, the SDK wiring and the audit path. */
export const pingTool: ToolDefinition = {
  name: 'ping',
  description: 'Check that the AI Operations Layer is reachable.',
  inputSchema: input,
  handler(args) {
    const { message } = input.parse(args);
    return Promise.resolve({
      content: [{ type: 'text', text: message === undefined ? 'pong' : `pong: ${message}` }],
      structuredContent: { pong: true, message: message ?? null, serverTime: new Date().toISOString() },
    });
  },
};
