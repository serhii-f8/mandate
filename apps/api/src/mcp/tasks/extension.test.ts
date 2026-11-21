// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The AI Operations Layer Authors
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
    const missing = missingTasksCapability();
    expect(missing.code).toBe(-32021);
    expect(missing.message).toContain('Missing required client capability');
    expect(missing.data).toEqual({ requiredCapabilities: { extensions: { 'io.modelcontextprotocol/tasks': {} } } });
    const notFound = taskNotFound();
    expect(notFound.code).toBe(-32602);
    expect(notFound.message).toBe('Failed to retrieve task: Task not found');
  });
});
