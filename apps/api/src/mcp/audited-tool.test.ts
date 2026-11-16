import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { ANONYMOUS_CALLER } from '@aiops/core';
import { InMemoryAuditLog } from '@aiops/testing';
import { auditedTool } from './audited-tool.js';
import type { ToolDefinition } from './tool-catalog.js';

function deps(audit: InMemoryAuditLog) {
  let ticks = 0;
  return {
    audit,
    caller: ANONYMOUS_CALLER,
    correlationId: 'corr-1',
    newId: () => '00000000-0000-4000-8000-000000000001',
    now: () => (ticks += 5),
  };
}

const okTool: ToolDefinition = {
  name: 'ok_tool',
  description: 'test',
  inputSchema: z.object({}),
  handler: () => Promise.resolve({ content: [{ type: 'text', text: 'done' }] }),
};

describe('AUD-1 every tool call is audited before its result is returned', () => {
  it('appends one ok event, then returns the handler result', async () => {
    const audit = new InMemoryAuditLog();
    const result = await auditedTool(okTool, deps(audit))({});
    expect(result).toEqual({ content: [{ type: 'text', text: 'done' }] });
    expect(audit.events).toEqual([
      {
        id: '00000000-0000-4000-8000-000000000001',
        actor: 'anonymous',
        action: 'tool.call',
        subject: 'ok_tool',
        outcome: 'ok',
        correlationId: 'corr-1',
        details: { durationMs: 5 },
      },
    ]);
  });

  it('reports an error instead of the result when the audit write fails', async () => {
    const audit = new InMemoryAuditLog();
    audit.failNext = new Error('database down');
    const result = await auditedTool(okTool, deps(audit))({});
    expect(result).toEqual({
      isError: true,
      content: [{ type: 'text', text: 'Audit unavailable; the call was not completed.' }],
    });
  });

  it('records a failing handler as an error and returns an error result', async () => {
    const audit = new InMemoryAuditLog();
    const failing: ToolDefinition = { ...okTool, handler: () => Promise.reject(new Error('secret detail')) };
    const result = await auditedTool(failing, deps(audit))({});
    expect(result).toEqual({ isError: true, content: [{ type: 'text', text: 'Tool failed.' }] });
    expect(audit.events[0]).toMatchObject({ outcome: 'error', details: { errorCode: 'handler_failed' } });
    expect(JSON.stringify(result)).not.toContain('secret detail');
  });
});
