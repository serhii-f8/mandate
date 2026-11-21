// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The AI Operations Layer Authors
import { describe, expect, it } from 'vitest';
import { MCP_APPS_DEFAULT_CSP, parseArgs, TERMINAL } from '../acceptance/widget-host-lib.mjs';

const URL_ = 'http://127.0.0.1:8400/mcp';

describe('MCP-5 UI-6 reference host helpers', () => {
  it('UI-6 the frame CSP is the MCP Apps default: no network', () => {
    expect(MCP_APPS_DEFAULT_CSP).toContain("default-src 'none'");
    expect(MCP_APPS_DEFAULT_CSP).not.toContain('connect-src');
  });

  it('MCP-5 parseArgs accepts list and render with flags and rejects unknown flags, a missing --tool and non-JSON --args', () => {
    expect(parseArgs([URL_, 'list'])).toEqual({ url: URL_, command: 'list' });
    expect(
      parseArgs([URL_, 'render', '--tool', 'x', '--args', '{"a":1}', '--exclude', '2', '--submit', '--decide', 'approve', '--open-page', '--wait-terminal', '30']),
    ).toEqual({ url: URL_, command: 'render', tool: 'x', args: { a: 1 }, exclude: 2, submit: true, decide: 'approve', openPage: true, waitTerminal: 30 });
    expect(parseArgs([URL_, 'render', '--tool', 'x'])).toEqual({ url: URL_, command: 'render', tool: 'x', args: {} });
    expect(() => parseArgs([URL_, 'render', '--tool', 'x', '--bogus'])).toThrow(/^usage:/);
    expect(() => parseArgs([URL_, 'render'])).toThrow(/^usage:/);
    expect(() => parseArgs([URL_, 'render', '--tool', 'x', '--args', 'nope'])).toThrow(/^usage:/);
    expect(() => parseArgs([URL_, 'render', '--tool', 'x', '--decide', 'reject'])).toThrow(/^usage:/);
    expect(() => parseArgs([URL_, 'render', '--tool', 'x', '--exclude', 'a'])).toThrow(/^usage:/);
    expect(() => parseArgs([URL_, 'other'])).toThrow(/^usage:/);
    expect(() => parseArgs([])).toThrow(/^usage:/);
  });

  it('MCP-5 TERMINAL holds the six terminal statuses', () => {
    expect([...TERMINAL].sort()).toEqual(['cancelled', 'completed', 'completed_with_errors', 'expired', 'failed', 'rolled_back']);
  });
});
