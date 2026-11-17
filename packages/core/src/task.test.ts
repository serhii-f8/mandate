import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { isTaskId } from './task.js';

describe('SEC-1 task ids', () => {
  it('SEC-1 isTaskId accepts UUIDs only', () => {
    const id = randomUUID();
    expect(isTaskId(id)).toBe(true);
    expect(isTaskId(id.toUpperCase())).toBe(true);
    for (const bad of ['x', 'x'.repeat(5000), '', '00000000-0000-0000-0000-00000000000g']) {
      expect(isTaskId(bad)).toBe(false);
    }
  });
});
