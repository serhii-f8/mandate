import type { CallToolResult } from '@modelcontextprotocol/server';
import { describe, expect, it } from 'vitest';
import type { Caller } from '@aiops/core';
import { pingTool } from './builtin-tools.js';
import { isTaskAnswer, type ToolAnswer } from './tasks/task-result.js';

/** Narrows an answer to a plain tool result; these tests never ask for a task. */
function plain(answer: ToolAnswer): CallToolResult {
  if (isTaskAnswer(answer)) throw new Error('unexpected task answer');
  return answer;
}

const caller: Caller = { subject: 'alice', groups: [] };
// The ping handler uses nothing from the context but the caller.
const ctx = { caller, snapshot: undefined as never, correlationId: 'c', tasks: false, report: () => undefined };

describe('ping built-in tool', () => {
  it('answers pong', async () => {
    const result = plain(await pingTool.handler({}, ctx));
    expect(result.content).toEqual([{ type: 'text', text: 'pong' }]);
    expect(result.structuredContent).toMatchObject({ pong: true, message: null });
  });

  it('echoes the message', async () => {
    const result = plain(await pingTool.handler({ message: 'hi' }, ctx));
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
