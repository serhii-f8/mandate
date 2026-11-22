// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Mandate Authors
import { describe, expect, it } from 'vitest';
import { formatIssue, pathToString } from './issues.js';
import { parseYamlSource } from './yaml-source.js';

describe('CFG-2 YAML errors carry file, line and path', () => {
  it('reports a syntax error with line and column', () => {
    const { document, issues } = parseYamlSource('roles.yaml', 'version: 1\nroles:\n  - id: a\n   grants: []\n');
    expect(document).toBeUndefined();
    expect(issues).toHaveLength(1);
    expect(issues[0]).toMatchObject({ file: 'roles.yaml', line: 4 });
    expect(typeof issues[0]?.column).toBe('number');
  });

  it('rejects duplicate keys', () => {
    const { issues } = parseYamlSource('a.yaml', 'version: 1\nversion: 1\n');
    expect(issues[0]?.message).toMatch(/unique|duplicate/i);
    expect(issues[0]).toMatchObject({ file: 'a.yaml', line: 2 });
  });

  it('locates a nested path, or its deepest existing parent', () => {
    const { document } = parseYamlSource('roles.yaml', 'version: 1\nroles:\n  - id: a\n    grants:\n      - operation: x\n');
    expect(document?.locate(['roles', 0, 'grants', 0, 'operation'])).toEqual({ line: 5, column: 9 });
    expect(document?.locate(['roles', 0, 'grants', 0, 'scope'])).toEqual({ line: 5, column: 9 });
  });

  it('formats an issue as file:line:column path: message', () => {
    expect(formatIssue({ file: 'roles.yaml', line: 3, column: 5, path: 'roles[0].id', message: 'is required' })).toBe(
      'roles.yaml:3:5 roles[0].id: is required',
    );
    expect(formatIssue({ file: 'roles.yaml', path: '', message: 'no line' })).toBe('roles.yaml: no line');
  });

  it('writes paths with indices in brackets', () => {
    expect(pathToString(['roles', 0, 'grants', 1, 'scope', 'brand'])).toBe('roles[0].grants[1].scope.brand');
  });
});
