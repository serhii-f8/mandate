import { describe, expect, it } from 'vitest';
import { echo } from './echo.js';

describe('echo activity', () => {
  it('returns the message', async () => {
    expect(await echo('hi')).toBe('hi');
  });
});
