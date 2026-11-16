import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const CORE = fileURLToPath(new URL('../../packages/core', import.meta.url));
const INFRASTRUCTURE = /from\s+['"](testcontainers|@testcontainers\/[^'"]+|pg|@temporalio\/[^'"]+|@aiops\/(testing|db))['"]/;

function testFiles(dir: string): string[] {
  return readdirSync(dir, { recursive: true, encoding: 'utf8' })
    .filter((f) => f.endsWith('.test.ts'))
    .map((f) => join(dir, f));
}

describe('NFR-14 packages/core is covered by unit tests without infrastructure', () => {
  it('has unit tests next to its code', () => {
    expect(testFiles(join(CORE, 'src')).length).toBeGreaterThanOrEqual(4);
  });

  it('imports no infrastructure in any core test', () => {
    const offenders = testFiles(join(CORE, 'src')).filter((f) => INFRASTRUCTURE.test(readFileSync(f, 'utf8')));
    expect(offenders).toEqual([]);
  });

  it('has no integration or e2e tests', () => {
    expect(existsSync(join(CORE, 'test', 'integration'))).toBe(false);
    expect(existsSync(join(CORE, 'test', 'e2e'))).toBe(false);
  });

  it('the scan recognises an infrastructure import (negative control)', () => {
    expect(INFRASTRUCTURE.test("import { startPostgres } from '@aiops/testing';")).toBe(true);
    expect(INFRASTRUCTURE.test("import pg from 'pg';")).toBe(true);
    expect(INFRASTRUCTURE.test("import { describe } from 'vitest';")).toBe(false);
  });
});
