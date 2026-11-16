import { describe, expect, it } from 'vitest';
import type { Caller } from '@aiops/core';
import { pingTool } from './builtin-tools.js';

const caller: Caller = { subject: 'alice', groups: [] };

describe('ping built-in tool', () => {
  it('answers pong', async () => {
    const result = await pingTool.handler({}, caller);
    expect(result.content).toEqual([{ type: 'text', text: 'pong' }]);
    expect(result.structuredContent).toMatchObject({ pong: true, message: null });
  });

  it('echoes the message', async () => {
    const result = await pingTool.handler({ message: 'hi' }, caller);
    expect(result.content).toEqual([{ type: 'text', text: 'pong: hi' }]);
    expect(typeof (result.structuredContent as { serverTime: unknown }).serverTime).toBe('string');
  });

  it('limits the message to 200 characters and rejects unknown arguments', () => {
    expect(pingTool.validate({ message: 'x'.repeat(200) })).toEqual({ ok: true });
    expect(pingTool.validate({ message: 'x'.repeat(201) }).ok).toBe(false);
    expect(pingTool.validate({ other: 1 }).ok).toBe(false);
  });

  it('publishes a JSON Schema with an object root', () => {
    expect(pingTool.inputSchema).toMatchObject({ type: 'object', additionalProperties: false });
  });
});
