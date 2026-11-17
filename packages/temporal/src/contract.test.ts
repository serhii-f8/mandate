import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

describe('workflow contract', () => {
  it('EXE-10 the contract module has no runtime imports', () => {
    const source = readFileSync(new URL('./contract.ts', import.meta.url), 'utf8');
    const imports = source.split('\n').filter((line) => /^\s*(import|export)\b.*\bfrom\s/.test(line));
    expect(imports.length).toBeGreaterThan(0);
    for (const line of imports) expect(line).toMatch(/^\s*(import|export) type\b/);
    expect(source).not.toMatch(/\brequire\(|\bimport\(/);
  });
});
