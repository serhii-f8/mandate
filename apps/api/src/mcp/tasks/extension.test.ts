import { describe, expect, it } from 'vitest';
import { declaresTasks, missingTasksCapability, taskNotFound } from './extension.js';

const KEY = 'io.modelcontextprotocol/clientCapabilities';

describe('MCP-7 MCP-1 Tasks extension detection', () => {
  it('declared: the envelope names the tasks extension', () => {
    expect(declaresTasks({ [KEY]: { extensions: { 'io.modelcontextprotocol/tasks': {} } } })).toBe(true);
  });

  it.each([
    ['empty envelope', {}],
    ['another extension', { [KEY]: { extensions: { 'other/ext': {} } } }],
    ['non-object declaration', { [KEY]: { extensions: { 'io.modelcontextprotocol/tasks': true } } }],
    ['non-object envelope value', { [KEY]: true }],
    ['envelope that is not an object', true],
  ])('absent: %s gives false', (_name, envelope) => {
    expect(declaresTasks(envelope as object)).toBe(false);
  });

  it('2025-era: no envelope gives false', () => {
    expect(declaresTasks(undefined)).toBe(false);
  });

  it('errors carry the specified codes', () => {
    expect(missingTasksCapability().code).toBe(-32021);
    const notFound = taskNotFound();
    expect(notFound.code).toBe(-32602);
    expect(notFound.message).toContain('Failed to retrieve task: Task not found');
  });
});
