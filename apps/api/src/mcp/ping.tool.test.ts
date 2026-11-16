import { describe, expect, it } from 'vitest';
import { ANONYMOUS_CALLER } from '@aiops/core';
import { pingTool } from './ping.tool.js';

describe('ping tool', () => {
  it('answers pong', async () => {
    const result = await pingTool.handler({}, ANONYMOUS_CALLER);
    expect(result.content).toEqual([{ type: 'text', text: 'pong' }]);
    expect(result.structuredContent).toMatchObject({ pong: true, message: null });
  });

  it('echoes the message', async () => {
    const result = await pingTool.handler({ message: 'hi' }, ANONYMOUS_CALLER);
    expect(result.content).toEqual([{ type: 'text', text: 'pong: hi' }]);
    expect(result.structuredContent).toMatchObject({ pong: true, message: 'hi' });
    expect(typeof (result.structuredContent as { serverTime: unknown }).serverTime).toBe('string');
  });

  it('limits the message to 200 characters', () => {
    expect(pingTool.inputSchema.safeParse({ message: 'x'.repeat(200) }).success).toBe(true);
    expect(pingTool.inputSchema.safeParse({ message: 'x'.repeat(201) }).success).toBe(false);
  });
});
