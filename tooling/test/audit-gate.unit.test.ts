// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The AI Operations Layer Authors
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { evaluateAudit } from '../security/audit-gate-lib.mjs';

const TODAY = new Date('2026-11-20T10:00:00Z');
const run = evaluateAudit;

function report(...advs: { id: string; pkg?: string; severity: string; path?: string }[]): unknown {
  const advisories: Record<string, unknown> = {};
  advs.forEach((a, i) => {
    advisories[String(i + 1)] = {
      github_advisory_id: a.id,
      module_name: a.pkg ?? 'left-pad',
      severity: a.severity,
      vulnerable_versions: '<1.0.0',
      patched_versions: '>=1.0.0',
      findings: [{ version: '0.9.0', paths: [a.path ?? '.>left-pad', '.>other>left-pad'] }],
    };
  });
  return { advisories, metadata: {} };
}

const entry = (id: string, expires: string, extra = ''): string =>
  `- id: ${id}\n  package: left-pad\n  reason: dev-only\n  expires: ${expires}\n${extra}`;

describe('SEC-11 audit gate', () => {
  it('SEC-11 blocks a high advisory that is not allowlisted and names id, package and first path', () => {
    const r = run(report({ id: 'GHSA-aaaa-aaaa-aaaa', pkg: 'left-pad', severity: 'high', path: 'apps/api>left-pad' }), '[]', TODAY);
    expect(r.exitCode).toBe(1);
    expect(r.lines.join('\n')).toMatch(/GHSA-aaaa-aaaa-aaaa left-pad high apps\/api>left-pad/);
  });

  it('SEC-11 blocks a critical advisory', () => {
    expect(run(report({ id: 'GHSA-bbbb-bbbb-bbbb', severity: 'critical' }), '[]', TODAY).exitCode).toBe(1);
  });

  it('SEC-11 blocks an upper-case or unknown severity: only low, moderate and info pass ungated', () => {
    expect(run(report({ id: 'GHSA-up', severity: 'HIGH' }), '[]', TODAY).exitCode).toBe(1);
    expect(run(report({ id: 'GHSA-unk', severity: 'severe' }), '[]', TODAY).exitCode).toBe(1);
    expect(run(report({ id: 'GHSA-info', severity: 'info' }, { id: 'GHSA-lo', severity: 'Low' }), '[]', TODAY).exitCode).toBe(0);
  });

  it('SEC-11 passes moderate and low advisories and lists them as not gated', () => {
    const r = run(report({ id: 'GHSA-m', severity: 'moderate' }, { id: 'GHSA-l', severity: 'low' }), '', TODAY);
    expect(r.exitCode).toBe(0);
    expect(r.lines.filter((l) => l.startsWith('not gated'))).toHaveLength(2);
  });

  it('SEC-11 passes an allowlisted high and prints allowed <id> until <date>', () => {
    const r = run(report({ id: 'GHSA-cccc', severity: 'high' }), entry('GHSA-cccc', '2027-01-15'), TODAY);
    expect(r.exitCode).toBe(0);
    expect(r.lines).toContain('allowed GHSA-cccc until 2027-01-15 (left-pad, high)');
  });

  it('SEC-11 accepts an allowlist entry for a present moderate: allowed, not stale', () => {
    const r = run(report({ id: 'GHSA-mod', severity: 'moderate' }), entry('GHSA-mod', '2027-01-15'), TODAY);
    expect(r.exitCode).toBe(0);
    expect(r.lines.some((l) => l.startsWith('allowed GHSA-mod until 2027-01-15'))).toBe(true);
    expect(r.lines.join('\n')).not.toMatch(/stale/);
  });

  it('SEC-11 fails an expired allowlist entry', () => {
    const r = run(report({ id: 'GHSA-dddd', severity: 'high' }), entry('GHSA-dddd', '2026-11-19'), TODAY);
    expect(r.exitCode).toBe(1);
    expect(r.lines.join('\n')).toMatch(/expired allowlist entry GHSA-dddd/);
  });

  it('SEC-11 an expired entry does not print allowed for its advisory, and the advisory is judged by severity', () => {
    const r = run(report({ id: 'GHSA-dddd', severity: 'high' }), entry('GHSA-dddd', '2026-11-19'), TODAY);
    expect(r.lines.some((l) => l.startsWith('allowed GHSA-dddd'))).toBe(false);
    expect(r.lines.join('\n')).toMatch(/blocked GHSA-dddd/);
  });

  it('SEC-11 accepts an entry that expires today and one exactly 90 days away', () => {
    expect(run(report({ id: 'GHSA-e', severity: 'high' }), entry('GHSA-e', '2026-11-20'), TODAY).exitCode).toBe(0);
    expect(run(report({ id: 'GHSA-e', severity: 'high' }), entry('GHSA-e', '2027-02-18'), TODAY).exitCode).toBe(0);
  });

  it('SEC-11 fails an entry that expires more than 90 days after the run date', () => {
    const r = run(report({ id: 'GHSA-f', severity: 'high' }), entry('GHSA-f', '2027-02-19'), TODAY);
    expect(r.exitCode).toBe(1);
    expect(r.lines.join('\n')).toMatch(/GHSA-f.*more than 90 days/);
  });

  it('SEC-11 fails a stale allowlist entry that matches no advisory', () => {
    const r = run(report(), entry('GHSA-gone', '2027-01-15'), TODAY);
    expect(r.exitCode).toBe(1);
    expect(r.lines.join('\n')).toMatch(/stale allowlist entry GHSA-gone/);
  });

  it('SEC-11 fails a malformed allowlist and names the missing field', () => {
    const r = run(report(), '- id: GHSA-h\n  package: left-pad\n  expires: 2027-01-15\n', TODAY);
    expect(r.exitCode).toBe(1);
    expect(r.lines.join('\n')).toMatch(/"reason"/);
  });

  it('SEC-11 fails an allowlist whose expires is not a date', () => {
    const r = run(report(), entry('GHSA-i', 'soon'), TODAY);
    expect(r.exitCode).toBe(1);
    expect(r.lines.join('\n')).toMatch(/"expires"/);
  });

  it('SEC-11 fails an unreadable audit report', () => {
    for (const bad of [undefined, null, 'x', {}, { advisories: { 1: { module_name: 'a' } } }]) {
      const r = run(bad, '[]', TODAY);
      expect(r.exitCode).toBe(1);
      expect(r.lines).toEqual(['unreadable audit report']);
    }
  });

  it('SEC-11 CLI resolves yaml from the repository and exits with the gate verdict', () => {
    const dir = mkdtempSync(join(tmpdir(), 'audit-gate-'));
    const auditPath = join(dir, 'audit.json');
    const listPath = join(dir, 'allow.yaml');
    writeFileSync(auditPath, JSON.stringify(report({ id: 'GHSA-cli', severity: 'high' })));
    writeFileSync(listPath, '[]\n');
    const cli = fileURLToPath(new URL('../security/audit-gate.mjs', import.meta.url));
    const r = spawnSync(process.execPath, [cli, auditPath, listPath], { encoding: 'utf8' });
    expect(r.status).toBe(1);
    expect(r.stdout).toMatch(/blocked GHSA-cli/);
    const exp = new Date(Date.now() + 30 * 86_400_000).toISOString().slice(0, 10);
    writeFileSync(listPath, entry('GHSA-cli', exp));
    expect(execFileSync(process.execPath, [cli, auditPath, listPath], { encoding: 'utf8' })).toMatch(/gate: pass/);
  });
});
